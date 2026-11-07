---
title: "Connection pooling: why your database falls over at 200 requests"
description: "Postgres allows 100 connections by default, and Go's database/sql will happily try to open more. Here's what actually happens when traffic spikes, measured, and how to size and configure a pool so it queues instead of failing."
pubDate: 2026-11-07
tags: [postgres, go, performance, databases, reliability]
draft: false
---

A Go service runs fine all week. Then a marketing email goes out, traffic jumps to a couple of hundred concurrent requests, and half of them fail with this:

```
FATAL: sorry, too many clients already (SQLSTATE 53300)
```

Nothing is wrong with the queries. The database isn't out of CPU. It has simply run out of **connections**, and the application never told itself to stop asking for more.

## Connections are not free

Postgres starts a separate server process for every client connection, and each one holds memory of its own. So the server caps how many it will accept with `max_connections`. The docs give the default as "typically 100 connections" ([Connection Settings](https://www.postgresql.org/docs/17/runtime-config-connection.html)).

Not all 100 are yours. `superuser_reserved_connections` (default **3**) keeps slots back for superusers, so that an administrator can still log in when everything else is full. An application connecting as an ordinary role gets 97.

## What database/sql does by default

In Go, `*sql.DB` is already a pool. The question is how it's configured, and the defaults are surprising:

- `SetMaxOpenConns`: "The default is 0 (unlimited)."
- `SetMaxIdleConns`: "The default max idle connections is currently 2."

([database/sql docs](https://pkg.go.dev/database/sql#DB.SetMaxOpenConns))

Unlimited open connections means that when 200 requests arrive at once and each needs the database, the pool tries to open 200 connections. Postgres accepts the first 97 and refuses the rest.

## Measuring it

I tested this against Postgres 17 in Docker with the default `max_connections = 100`. Each request runs a query that holds its connection for 500 ms, and 200 of them start at once:

```go
// burst fires n concurrent queries that each hold a connection for hold.
func burst(db *sql.DB, n int, hold time.Duration) (errs []error, took time.Duration) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := db.Exec(`SELECT pg_sleep($1)`, hold.Seconds()); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return errs, time.Since(start)
}
```

**With the defaults**, connecting as an ordinary role, **103 of 200 requests failed** with `too many clients already`, which is exactly 200 minus the 97 slots available. As a superuser, 100 failed, because superusers can use the reserved slots.

There was a detail worth knowing: with a short 50 ms query nothing failed at all. Opening a connection takes time, so the early requests finished and freed their slots before the later ones arrived. **Connection exhaustion shows up when queries get slow**, which is usually also when traffic is high. That's why it tends to hit during incidents rather than in load tests.

**With the pool capped at 20**, all 200 requests succeeded. They took 5.06 seconds in total, which is what you'd expect: 200 requests × 0.5 s ÷ 20 connections = 5 s. `db.Stats()` showed 180 requests had waited for a connection.

That's the trade a pool makes. It **doesn't make the database faster**. It turns "fail immediately" into "wait your turn". Waiting is better, but only if the wait is short and bounded.

## A configured pool

```go
// Open returns a pool that never holds more than maxConns connections.
func Open(url string, maxConns int) (*sql.DB, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(maxConns)            // the hard cap; the default is 0, meaning unlimited
	db.SetMaxIdleConns(maxConns)            // keep them warm; the default is only 2
	db.SetConnMaxLifetime(30 * time.Minute) // recycle now and then (failovers, load balancers)
	db.SetConnMaxIdleTime(5 * time.Minute)  // shrink after a quiet spell

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
```

Each setting is there for a reason:

- **`SetMaxOpenConns`** is the one that matters most. It's the cap that keeps the service from flooding the database.
- **`SetMaxIdleConns`** at the same value keeps connections open between bursts. With the default of 2, a pool capped at 20 opens up to 20 connections during a burst, then closes 18 of them as soon as it's over. In the tests, five bursts of 40 requests closed **90** connections because of the idle limit with the default setting, and **0** with it raised to match the cap. Each of those was a connection set up and torn down for nothing.
- **`SetConnMaxLifetime`** recycles connections now and then, so a pool notices a database failover or a load balancer change instead of holding on to old connections forever.
- **`SetConnMaxIdleTime`** lets the pool shrink after a quiet period.

## Bound the wait

A capped pool queues requests, and a queue with no limit is just a slower outage. If the database stalls, every request waits forever, goroutines pile up, and clients retry on top of them.

`database/sql` waits for a free connection until the query's context is done, so put a deadline on it:

```go
// OrderCount answers from the database, but gives up if it can't get a
// connection (or an answer) within two seconds.
func OrderCount(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		var n int
		err := db.QueryRowContext(ctx,
			`SELECT count(*) FROM orders WHERE customer = $1`, r.URL.Query().Get("customer")).Scan(&n)
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			http.Error(w, "database busy, try again", http.StatusServiceUnavailable)
		case err != nil:
			http.Error(w, "internal error", http.StatusInternalServerError)
		default:
			w.Write([]byte(strconv.Itoa(n)))
		}
	}
}
```

In the test, a pool of one was held busy by another caller. The handler gave up after **2.001 s** and returned `503` instead of hanging. A `503` is a clear signal to a load balancer or a client with [sensible retries](../timeouts-retries-circuit-breakers/); a hung request isn't.

## How big should the pool be?

Smaller than you think. The best-known starting point comes from the HikariCP wiki, quoting the PostgreSQL project ([About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)):

```
connections = (core_count * 2) + effective_spindle_count
```

`core_count` is physical cores on the **database** server, not hyperthreads. `effective_spindle_count` is zero if the working set fits in memory. For an 8-core database with a cached working set that's about 16 connections, **in total**. The wiki is clear that this is "a starting point" and that pool sizing "is ultimately very specific to deployments", so measure from there.

The intuition: a database with 8 cores can only run about 8 queries at once. Connections beyond that don't add throughput; they compete for CPU, locks and memory. The wiki describes an Oracle demonstration where cutting the pool from 2,048 connections to 96 brought response times from about 100 ms to about 2 ms.

**"In total" is the part people miss.** The pool size in your config is per process. Ten replicas with a pool of 20 each is 200 connections, already twice the default limit, before counting migrations, cron jobs, admin sessions and your monitoring agent. Work out the budget across everything that connects:

```
replicas × pool size + workers + migrations + headroom  <  max_connections
```

Autoscaling makes this worse, because adding replicas under load adds connections at exactly the wrong moment.

## When you need more connections than the database can take

Sometimes you really do have hundreds of processes that each need a connection now and then: many replicas, serverless functions, or lots of small services. That's what a connection pooler like **PgBouncer** is for. Applications connect to PgBouncer, and it shares a small set of real Postgres connections between them.

The mode that makes this work is **transaction pooling**: a server connection is assigned to a client only for the length of a transaction. That only works if nothing depends on state that lives in the session. PgBouncer's [feature table](https://www.pgbouncer.org/features.html) lists what breaks in transaction mode, including:

- `SET` / `RESET`
- `LISTEN`
- `WITH HOLD` cursors
- SQL-level `PREPARE` / `DEALLOCATE`
- session-level advisory locks

Protocol-level prepared statements, which drivers like pgx use, are supported in transaction mode, but only once you set `max_prepared_statements` to a non-zero value.

If you use PgBouncer, keep the in-app pool too. It still bounds how much one process can ask for, and it still needs timeouts.

## Watch it

`db.Stats()` tells you how the pool is doing. Logging the change every interval turns it into something you can graph:

```go
// LogStats prints what the pool did in each interval.
func LogStats(ctx context.Context, db *sql.DB, every time.Duration) {
	prev := db.Stats()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s := db.Stats()
		log.Printf("db pool: in_use=%d idle=%d waited=%d wait_time=%s closed_idle=%d",
			s.InUse, s.Idle,
			s.WaitCount-prev.WaitCount,
			s.WaitDuration-prev.WaitDuration,
			s.MaxIdleClosed-prev.MaxIdleClosed)
		prev = s
	}
}
```

The numbers to watch:

- **`waited` and `wait_time` rising** means requests are queueing for connections. Either the pool is too small for the load, or queries are holding connections too long. Check query latency before you raise the cap.
- **`in_use` stuck at the maximum** means the pool is saturated.
- **`closed_idle` climbing steadily** means `MaxIdleConns` is too low and connections are being churned.

On the database side, `SELECT state, count(*) FROM pg_stat_activity GROUP BY state` shows how many connections exist and what they're doing. Lots of `idle in transaction` usually means code that opened a transaction and forgot to finish it.

## Checklist

- [ ] `SetMaxOpenConns` is set on every `*sql.DB`; the default is unlimited
- [ ] `SetMaxIdleConns` matches it, so bursts don't churn connections
- [ ] Every query runs with a context deadline, so waiting for a connection is bounded
- [ ] The **total** across replicas, workers and jobs stays below `max_connections`, with headroom
- [ ] Pool size starts near `cores × 2` on the database server and is adjusted from measurements
- [ ] PgBouncer in transaction mode only for code that doesn't rely on session state
- [ ] Pool stats are logged or exported, and `wait_time` is on a dashboard

A connection pool is a queue in front of your database. Size it for what the database can do, not for how much traffic you hope to get, and make sure nobody waits in it forever.

---

**Further reading**

- [PostgreSQL: Connection Settings](https://www.postgresql.org/docs/17/runtime-config-connection.html)
- [Go: database/sql](https://pkg.go.dev/database/sql)
- [HikariCP: About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- [PgBouncer: Features](https://www.pgbouncer.org/features.html)
