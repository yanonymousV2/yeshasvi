---
title: "The outbox pattern: reliable events without distributed transactions"
description: "Saving a row and publishing an event are two writes to two systems, and one of them will eventually fail without the other. The outbox pattern makes them one write. Here's how it works, with a tested Go and Postgres implementation."
pubDate: 2026-11-07
tags: [distributed-systems, postgres, go, messaging, reliability]
draft: false
---

An order service does two things when a customer checks out. It inserts the order into Postgres, and it publishes an `order.placed` event so the email, warehouse and analytics services can react.

```go
tx.Exec(`INSERT INTO orders ...`)
tx.Commit()
broker.Publish("order.placed", order) // what if this fails?
```

Most days this works. Then one day the broker is restarting for a few seconds, the publish fails, and an order exists that no other service will ever hear about. The customer never gets a confirmation email and the warehouse never ships.

Flipping the order doesn't help. Publish first and commit second, and a failed commit leaves an event announcing an order that doesn't exist. Publish inside the transaction, before the commit, and you have the same problem: the event is out, but the transaction can still roll back.

This is the **dual write** problem. You're writing to two systems that don't share a transaction, so there's always a moment where one write has happened and the other hasn't. A crash, a deploy or a network blip in that moment leaves them disagreeing.

## Why not a distributed transaction?

The textbook answer is two-phase commit across the database and the broker. In practice most brokers don't support it, and the ones that do couple your service to both systems being up at the same time. Chris Richardson's write-up of the pattern ([microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)) rules 2PC out for exactly these reasons.

The outbox pattern takes a different route: **don't write to two systems in the request at all.**

## The idea

Instead of publishing the event, the service **inserts it into an `outbox` table in the same database, in the same transaction** as the order. One database, one transaction, so either both rows commit or neither does.

A separate process, the **relay**, reads unpublished rows from the outbox and publishes them to the broker. If the broker is down, the rows wait. When it comes back, the relay catches up.

```
request ──► [ orders + outbox ]  (one transaction)
                     │
               relay polls
                     │
                     ▼
                  broker ──► consumers
```

The request path no longer depends on the broker at all. It only needs the database, which it already needed.

## The schema

```sql
CREATE TABLE orders (
    id          bigserial   PRIMARY KEY,
    customer    text        NOT NULL,
    total_cents bigint      NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
    id           bigserial   PRIMARY KEY,
    aggregate_id text        NOT NULL,
    event_type   text        NOT NULL,
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz             -- NULL until the relay has published it
);

-- The relay only ever looks for unpublished rows, so index just those.
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

`published_at` stays `NULL` until the relay has sent the row. The partial index covers only the rows the relay is looking for, so it stays small even when the table holds millions of published events.

## Writing the event

The write side is an ordinary transaction with one extra insert:

```go
// Event is one row of the outbox table.
type Event struct {
	ID          int64
	AggregateID string
	Type        string
	Payload     []byte
}

// PlaceOrder writes the order and the event announcing it in one transaction.
// Either both rows commit or neither does.
func PlaceOrder(ctx context.Context, db *sql.DB, customer string, totalCents int64) (int64, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() // no-op after a successful Commit

	var id int64
	err = tx.QueryRowContext(ctx,
		`INSERT INTO orders (customer, total_cents) VALUES ($1, $2) RETURNING id`,
		customer, totalCents).Scan(&id)
	if err != nil {
		return 0, err
	}

	payload, err := json.Marshal(map[string]any{
		"order_id": id, "customer": customer, "total_cents": totalCents,
	})
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'order.placed', $2)`,
		strconv.FormatInt(id, 10), payload)
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}
```

That's the whole change to the request path. In the tests, I added a `CHECK (false)` constraint to the outbox table so the second insert fails, and confirmed the order insert rolls back with it. No orphan orders, no orphan events.

## The relay

The relay claims a batch of unpublished events, publishes them in order, and marks the ones that went out:

```go
// Publisher sends one event to the broker (Kafka, NATS, SQS, a webhook...).
type Publisher interface {
	Publish(ctx context.Context, e Event) error
}

// RelayBatch claims up to limit unpublished events, publishes them in order
// and marks the published ones. It returns how many it published.
func RelayBatch(ctx context.Context, db *sql.DB, pub Publisher, limit int) (int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// SKIP LOCKED: a second relay running this query at the same time
	// gets the next rows instead of waiting for ours.
	rows, err := tx.QueryContext(ctx, `
		SELECT id, aggregate_id, event_type, payload
		FROM outbox
		WHERE published_at IS NULL
		ORDER BY id
		LIMIT $1
		FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return 0, err
	}
	var batch []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.AggregateID, &e.Type, &e.Payload); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, e)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	var done []int64
	var pubErr error
	for _, e := range batch {
		if pubErr = pub.Publish(ctx, e); pubErr != nil {
			break // stop here so later events don't overtake the one that failed
		}
		done = append(done, e.ID)
	}

	if len(done) > 0 {
		_, err = tx.ExecContext(ctx,
			`UPDATE outbox SET published_at = now() WHERE id = ANY($1)`, done)
		if err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(done), pubErr
}
```

Three choices in here are doing most of the work.

**`FOR UPDATE SKIP LOCKED`.** `FOR UPDATE` locks the rows the relay claimed until its transaction ends. `SKIP LOCKED` means a second relay running the same query doesn't wait for those locks: it skips them and takes the next rows. The Postgres docs describe this exact use: skipping locked rows "can be used to avoid lock contention with multiple consumers accessing a queue-like table" ([SELECT, The Locking Clause](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE)). In the tests, four relays drained 500 events concurrently in batches of 25, and every event was published exactly once.

**Stop at the first failure.** If event 3 fails, events 4 and 5 stay unpublished too, even though the broker might accept them. Otherwise a consumer could see "order shipped" before "order placed". Events 1 and 2 still get marked, so the next batch starts at 3.

**Mark only what was sent.** The `UPDATE` covers the events that published successfully, nothing more.

The loop around it is short:

```go
// Run relays events until ctx is cancelled. When a batch comes back full it
// goes again straight away; otherwise it waits for the next tick.
func Run(ctx context.Context, db *sql.DB, pub Publisher, every time.Duration) error {
	const batchSize = 100
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		n, err := RelayBatch(ctx, db, pub, batchSize)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			log.Printf("outbox relay: %v", err)
		}
		if n == batchSize {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}
```

When a batch comes back full there's probably more waiting, so it goes again straight away. Otherwise it sleeps until the next tick. A second or less is a typical interval; it's the worst-case delay between commit and publish.

## The catch: at-least-once delivery

Look at what happens if the relay crashes after `Publish` succeeds but before `Commit`. The broker has the event. The outbox row is still unpublished, because the update never committed. When the relay restarts, it publishes the event **again**.

You can't close that gap from the relay side. There's always a moment between "the broker accepted it" and "we recorded that it did". So the outbox gives you **at-least-once** delivery, and consumers have to handle duplicates. Richardson calls this out directly: the relay "might publish a message more than once", so consumers must be idempotent.

The usual fix is a table of processed event IDs on the consumer side, written **in the same transaction as the consumer's own side effect**:

```go
// HandleOnce runs apply for an event at most once, even if the relay
// delivers it twice. The dedupe record and the side effect commit together.
//
//	CREATE TABLE processed_events (event_id bigint PRIMARY KEY);
func HandleOnce(ctx context.Context, db *sql.DB, eventID int64, apply func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return nil // seen it before: skip
	}

	if err := apply(tx); err != nil {
		return err
	}
	return tx.Commit()
}
```

If the insert hits a conflict, the event was handled before and the function returns without doing anything. If `apply` fails, the whole transaction rolls back, including the dedupe row, so the next delivery tries again. The tests check both cases. It's the same idea as [idempotency keys](../idempotency-keys/), with the event ID as the key.

## Ordering

Events for the same order should arrive in the order they happened. A single relay processing batches in `id` order gives you that, which is what the tests check.

Several relays don't. Relay A claims events 1–100 and relay B claims 101–200. If A is slow, B can publish event 150 before A publishes event 50, even when both are about the same order. You have three reasonable options:

- **Run one relay at a time.** Have each instance call `pg_try_advisory_lock` on a dedicated connection (`db.Conn`, since the lock belongs to the session) and only relay while it holds the lock. The others are hot standbys.
- **Partition by aggregate.** Each relay handles a subset of `aggregate_id` values, for example by hash, so all events for one order go through one relay.
- **Make consumers tolerate reordering.** Include a version or timestamp in each event and ignore anything older than what's already been applied.

One more subtlety: `bigserial` IDs are handed out when a row is **inserted**, not when its transaction **commits**. Two transactions can commit in the opposite order to their IDs. The relay above is fine with that, because it looks for `published_at IS NULL`, not "everything after the last ID I saw", so a late-committing event 10 is still picked up on a later poll. A relay that tracks a high-water mark by ID would skip it for good.

## Running it in production

- **Clean up published rows.** The outbox grows forever otherwise. A scheduled `DELETE FROM outbox WHERE published_at < now() - interval '7 days'` keeps it small while leaving a recent history for debugging.
- **Watch the lag.** The useful metric is the age of the oldest unpublished event: `SELECT now() - min(created_at) FROM outbox WHERE published_at IS NULL`. If it climbs, the relay is stuck or the broker is down.
- **Wake the relay instead of polling harder.** Postgres `NOTIFY` sent inside the writing transaction is only delivered "until and unless the transaction is committed" ([NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html)), so the relay can `LISTEN` and react immediately, keeping a slow poll as the fallback. Keep the payload out of the notification; it must be shorter than 8000 bytes by default.
- **Or skip polling entirely with change data capture.** Tools like Debezium read the database's write-ahead log and turn outbox inserts into broker messages. Its [outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html) expects columns like `aggregatetype`, `aggregateid`, `type` and `payload`, and uses `aggregateid` as the message key so events for one aggregate keep their order. You trade a polling loop for another piece of infrastructure to run.

## Checklist

- [ ] The business write and the outbox insert are in **one** transaction
- [ ] Nothing in the request path talks to the broker
- [ ] The relay claims rows with `FOR UPDATE SKIP LOCKED` and marks only what it published
- [ ] The relay stops a batch at the first failed publish
- [ ] Consumers dedupe on the event ID in the same transaction as their side effect
- [ ] Ordering is handled: one relay, partitioning, or version checks
- [ ] Published rows are cleaned up, and the oldest unpublished event's age is on a dashboard

The outbox doesn't make the broker reliable. It makes the broker's downtime someone else's problem: events wait in a table you already back up, and go out when it's ready.

---

**Further reading**

- [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html), Chris Richardson
- [PostgreSQL: SELECT, The Locking Clause](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL: NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html)
- [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
