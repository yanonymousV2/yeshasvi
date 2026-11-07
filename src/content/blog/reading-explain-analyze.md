---
title: "Reading EXPLAIN ANALYZE: Postgres indexes in practice"
description: "A query is slow, you add an index, and nothing changes. EXPLAIN ANALYZE tells you why. Here's how to read its output, walked through real plans on a million-row table, plus a Go test that catches missing indexes before production does."
pubDate: 2026-11-07
tags: [postgres, performance, databases, sql, go]
draft: false
---

An endpoint that lists a customer's orders takes 15 ms in staging and gets slower every month in production. Someone adds an index on `created_at`, because the query sorts by it, and nothing improves. Someone else adds another. Still nothing.

Guessing at indexes is slow and leaves junk behind. Postgres will tell you exactly how it runs a query, and what each step costs, if you ask it with `EXPLAIN ANALYZE`.

Every plan below is real output from Postgres 17, run against a table of one million orders. The setup is at the end, so you can reproduce it.

## EXPLAIN vs EXPLAIN ANALYZE

`EXPLAIN` shows the plan the planner **would** use, with its estimates. `EXPLAIN ANALYZE` **runs the query** and adds what actually happened.

That second part matters for writes. The docs are blunt: because it "actually runs the query, any side-effects will happen as usual" ([Using EXPLAIN](https://www.postgresql.org/docs/17/using-explain.html)). To analyse an `UPDATE` or `DELETE` safely, wrap it:

```sql
BEGIN;
EXPLAIN ANALYZE DELETE FROM orders WHERE created_at < '2024-02-01';
ROLLBACK;
```

I use `EXPLAIN (ANALYZE, BUFFERS)` throughout. `BUFFERS` adds how many 8 kB pages each step touched, which is often a better measure of work than time. From Postgres 18 it's included automatically with `ANALYZE` ([EXPLAIN](https://www.postgresql.org/docs/18/sql-explain.html)).

## Reading one line

```
Parallel Seq Scan on orders  (cost=0.00..15518.33 rows=9 width=50) (actual time=2.351..13.367 rows=5 loops=3)
```

- **The first parentheses are estimates.** `cost` is in arbitrary planner units, not milliseconds: the startup cost before the first row, then the total. `rows` is how many rows the planner expects this step to produce. `width` is the average row size in bytes.
- **The second parentheses are what happened.** `actual time` is in milliseconds: time to the first row, then to the last. `rows` is how many rows really came out.
- **`loops` multiplies everything.** `actual time` and `rows` are **per loop**. Here three processes (two parallel workers and the leader) each ran the scan, so it produced about 5 × 3 = 15 rows in total.

The plan is a tree. Each step's input comes from the indented steps beneath it, and the time on a parent includes its children. Read it from the inside out.

## A sequential scan

The query: one customer's orders. There's no index on `customer_id` yet.

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE customer_id = 4242;
```

```
 Gather  (cost=1000.00..16520.43 rows=21 width=50) (actual time=3.762..15.718 rows=16 loops=1)
   Workers Planned: 2
   Workers Launched: 2
   Buffers: shared hit=10310
   ->  Parallel Seq Scan on orders  (cost=0.00..15518.33 rows=9 width=50) (actual time=2.351..13.367 rows=5 loops=3)
         Filter: (customer_id = 4242)
         Rows Removed by Filter: 333328
         Buffers: shared hit=10310
 Planning Time: 0.182 ms
 Execution Time: 15.743 ms
```

The two lines that matter:

- **`Rows Removed by Filter: 333328`**, per loop, so about a million rows were read and thrown away to find 16.
- **`Buffers: shared hit=10310`**: it touched 10,310 pages, which is the whole table. `hit` means they came from Postgres's cache; `read` would mean they had to come from disk.

15 ms sounds fine. But the cost grows with the table, not with the result: twice the orders, twice the time. That's the endpoint that "gets slower every month".

## Adding the right index

```sql
CREATE INDEX orders_customer_id ON orders (customer_id);
```

```
 Bitmap Heap Scan on orders  (cost=4.59..86.01 rows=21 width=50) (actual time=0.026..0.044 rows=16 loops=1)
   Recheck Cond: (customer_id = 4242)
   Heap Blocks: exact=16
   Buffers: shared hit=19 read=3
   ->  Bitmap Index Scan on orders_customer_id  (cost=0.00..4.58 rows=21 width=0) (actual time=0.022..0.022 rows=16 loops=1)
         Index Cond: (customer_id = 4242)
         Buffers: shared hit=3 read=3
 Execution Time: 0.054 ms
```

From 15.7 ms to 0.054 ms, and from 10,310 pages to 22.

This is a **bitmap scan**, a two-step plan. The `Bitmap Index Scan` finds where the matching rows live, and the `Bitmap Heap Scan` above it fetches them from the table, sorted into physical order so each page is read once. `Heap Blocks: exact=16` says 16 table pages were visited. The planner tends to prefer it over a plain index scan when it expects more than a few rows, spread across different pages.

Also look at the estimate: `rows=21` estimated, 16 actual. That's close, and a close estimate is why the planner chose well.

## When the index can do the sorting too

Now a different screen: the 20 newest pending orders.

```sql
SELECT id, customer_id, created_at FROM orders
WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20;
```

Without a suitable index, Postgres scans everything, keeps the matching rows, and sorts them:

```
 Limit  (actual time=15.320..16.572 rows=20 loops=1)
   ->  Gather Merge  (actual time=15.319..16.569 rows=20 loops=1)
         ->  Sort  (actual time=13.937..13.937 rows=16 loops=3)
               Sort Key: created_at DESC
               Sort Method: top-N heapsort  Memory: 27kB
               ->  Parallel Seq Scan on orders  (actual time=0.011..13.553 rows=3335 loops=3)
                     Filter: (status = 'pending'::text)
                     Rows Removed by Filter: 329998
 Execution Time: 16.595 ms
```

(Trimmed for width.) A separate index on `created_at` wouldn't fix this, and neither would one on `status` alone: the planner would still have to sort ten thousand pending orders. What helps is one index that **filters and sorts**:

```sql
CREATE INDEX orders_status_created ON orders (status, created_at);
```

```
 Limit  (cost=0.42..25.85 rows=20 width=24) (actual time=0.026..0.056 rows=20 loops=1)
   Buffers: shared hit=20 read=3
   ->  Index Scan Backward using orders_status_created on orders  (cost=0.42..13050.47 rows=10267 width=24) (actual time=0.026..0.054 rows=20 loops=1)
         Index Cond: (status = 'pending'::text)
 Execution Time: 0.063 ms
```

The `Sort` node is gone. Within `status = 'pending'`, the index is already ordered by `created_at`, so Postgres walks it **backward** and stops after 20 rows. Notice the inner node expected 10,267 rows but produced 20. That's not a bad estimate: the `Limit` stopped it early, and the docs call this "not an estimation error".

**Column order matters.** Equality columns go first, then the column you sort or range over. An index on `(created_at, status)` couldn't jump straight to the pending orders.

## The index that wasn't used

There's now an index on `created_at`, and this query still scans the whole table:

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM orders WHERE created_at::date = '2025-06-01';
```

```
 ->  Parallel Seq Scan on orders  (actual time=0.129..24.981 rows=456 loops=3)
       Filter: ((created_at)::date = '2025-06-01'::date)
       Rows Removed by Filter: 332877
       Buffers: shared hit=10310
 Execution Time: 26.684 ms
```

The index stores `created_at` values, but the filter is on `created_at::date`, a value computed from each row. The index can't help with an expression it doesn't contain. Rewrite the condition so the column stands alone:

```sql
SELECT count(*) FROM orders
WHERE created_at >= '2025-06-01' AND created_at < '2025-06-02';
```

```
 Aggregate  (cost=46.89..46.90 rows=1 width=8) (actual time=0.157..0.157 rows=1 loops=1)
   Buffers: shared hit=1 read=7
   ->  Index Only Scan using orders_created_at on orders  (cost=0.42..43.50 rows=1354 width=0) (actual time=0.032..0.116 rows=1368 loops=1)
         Index Cond: ((created_at >= '2025-06-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-06-02 00:00:00+00'::timestamp with time zone))
         Heap Fetches: 0
 Execution Time: 0.164 ms
```

Same 1,368 rows, 26.7 ms down to 0.16 ms. The same trap shows up with `lower(email) = ...`, `date_trunc(...)`, and arithmetic on a column. The fix is either rewriting the condition like this, or an index on the expression itself.

The range form is also explicit about time zones. A cast to `date` uses the session's `TimeZone` setting, so the "same" query can count a different day depending on who runs it.

## Index-only scans and Heap Fetches

That last plan was an **Index Only Scan**: the query needed only `created_at`, which is in the index, so Postgres didn't have to read the table at all. Mostly.

An index doesn't know whether a row is visible to your transaction. Postgres checks the table's **visibility map**, which marks pages where every row is visible to everyone, and it can skip the table only for those pages ([Index-Only Scans](https://www.postgresql.org/docs/17/indexes-index-only-scans.html)). `Heap Fetches` counts the times it had to go to the table anyway.

To see it, I turned off autovacuum on the table and updated that day's 1,368 orders:

```
 ->  Index Only Scan using orders_created_at on orders  (actual time=0.016..2.792 rows=1368 loops=1)
       Heap Fetches: 2736
       Buffers: shared hit=2747
 Execution Time: 2.847 ms
```

After `VACUUM orders`, which updates the visibility map:

```
 ->  Index Only Scan using orders_created_at on orders  (actual time=0.007..0.065 rows=1368 loops=1)
       Heap Fetches: 0
       Buffers: shared hit=11
 Execution Time: 0.114 ms
```

2,747 pages down to 11. Same plan, same index; the difference is how recently the table was vacuumed. If an index-only scan is slower than expected on a busy table, check `Heap Fetches` and whether autovacuum is keeping up.

To make an index cover a query without adding the extra columns to its search key, there's `INCLUDE`: `CREATE INDEX ON orders (customer_id) INCLUDE (total_cents)`.

## When the estimate is wrong

The planner picks plans from its **row estimates**, so the most useful habit is comparing estimated `rows` with actual `rows` on each node. In this table, `city` is completely determined by `country`: every German order is in Berlin.

```sql
EXPLAIN ANALYZE SELECT count(*) FROM orders WHERE country = 'DE' AND city = 'Berlin';
```

```
 ->  Parallel Seq Scan on orders  (cost=0.00..16573.97 rows=16407 width=0) (actual time=0.004..14.602 rows=66802 loops=3)
       Filter: ((country = 'DE'::text) AND (city = 'Berlin'::text))
```

Estimated 16,407 rows per process, actual 66,802: **four times too low**. The planner assumes conditions on different columns are independent, so it multiplies "1 in 5 orders is German" by "1 in 5 orders is in Berlin" and gets 1 in 25. The true answer is 1 in 5.

Here the plan is a sequential scan either way, so the mistake costs nothing. But the same gap inside a join can lead the planner to pick a strategy that suits 40,000 rows, such as a nested loop, for 200,000. Extended statistics tell the planner about the dependency:

```sql
CREATE STATISTICS orders_country_city (dependencies) ON country, city FROM orders;
ANALYZE orders;
```

```
 ->  Parallel Seq Scan on orders  (cost=0.00..16574.00 rows=84639 width=0) (actual time=0.005..14.114 rows=66802 loops=3)
```

Now it's in the right range. More generally, a big gap between estimated and actual rows usually means stale statistics (run `ANALYZE`), correlated columns (extended statistics), or a condition the planner can't see into.

## Catching it in tests

Plain `EXPLAIN` without `ANALYZE` plans a query **without running it**, and `FORMAT JSON` makes the plan easy to inspect from code. That's enough to fail a test when a hot query starts scanning a big table:

```go
// Node is one step of a query plan, as EXPLAIN (FORMAT JSON) describes it.
type Node struct {
	Type     string  `json:"Node Type"`
	Relation string  `json:"Relation Name"`
	Index    string  `json:"Index Name"`
	PlanRows float64 `json:"Plan Rows"`
	Plans    []Node  `json:"Plans"`
}

// Plan asks Postgres how it would run query. Plain EXPLAIN plans the query
// but does not execute it, so this is safe for writes too.
func Plan(ctx context.Context, db *sql.DB, query string, args ...any) (Node, error) {
	var raw []byte
	if err := db.QueryRowContext(ctx, "EXPLAIN (FORMAT JSON) "+query, args...).Scan(&raw); err != nil {
		return Node{}, err
	}
	var out []struct {
		Plan Node `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return Node{}, err
	}
	if len(out) != 1 {
		return Node{}, fmt.Errorf("unexpected EXPLAIN output: %s", raw)
	}
	return out[0].Plan, nil
}

// SeqScans lists the tables the plan reads with a sequential scan.
func SeqScans(n Node) []string {
	var out []string
	if n.Type == "Seq Scan" {
		out = append(out, n.Relation)
	}
	for _, child := range n.Plans {
		out = append(out, SeqScans(child)...)
	}
	return out
}
```

```go
// The queries the app runs on hot paths must not scan the whole orders table.
func TestHotQueriesUseIndexes(t *testing.T) {
	db := shopDB(t)
	hot := map[string][]any{
		`SELECT * FROM orders WHERE customer_id = $1`:                                           {4242},
		`SELECT id, created_at FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 20`: {"pending"},
		`SELECT count(*) FROM orders WHERE created_at >= $1 AND created_at < $2`:                {"2025-06-01", "2025-06-02"},
	}
	for q, args := range hot {
		plan, err := Plan(context.Background(), db, q, args...)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		if tables := SeqScans(plan); slices.Contains(tables, "orders") {
			t.Errorf("sequential scan on orders:\n  %s", q)
		}
	}
}
```

The same suite checks that the `created_at::date` version **does** get flagged, and that planning a `DELETE` this way leaves the table untouched.

One caveat: the planner is right to choose a sequential scan on a small table, so this test only means something against realistic data volumes. Run it against a seeded copy, or, to check that an index *can* be used at all, `SET enable_seqscan = off` for the test session.

## Checklist

- [ ] Run `EXPLAIN (ANALYZE, BUFFERS)`, and wrap writes in `BEGIN` … `ROLLBACK`
- [ ] Multiply per-loop `rows` and `actual time` by `loops`
- [ ] Look for big `Rows Removed by Filter` and whole-table `Buffers` counts
- [ ] Compare estimated and actual `rows`; a large gap is the first thing to fix
- [ ] Build composite indexes with equality columns first, then the sort or range column
- [ ] Keep indexed columns bare in `WHERE`: ranges instead of casts and functions
- [ ] Check `Heap Fetches` on index-only scans, and keep autovacuum healthy
- [ ] Test that hot queries don't sequentially scan large tables

Don't guess at indexes. Read the plan first, and let it tell you which index it needs.

## The test data

All the plans above come from this table, with 1M rows (about 80 MB) on Postgres 17, default settings:

```sql
SELECT setseed(0.42);

CREATE TABLE orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint      NOT NULL,
    status      text        NOT NULL,
    country     text        NOT NULL,
    city        text        NOT NULL,
    total_cents bigint      NOT NULL,
    created_at  timestamptz NOT NULL
);

-- 1M orders: 50k customers, 1% pending, two years of dates,
-- and city always determined by country.
INSERT INTO orders (customer_id, status, country, city, total_cents, created_at)
SELECT (random() * 49999)::bigint + 1,
       CASE WHEN random() < 0.01 THEN 'pending' ELSE 'delivered' END,
       c.country, c.city,
       (random() * 20000)::bigint + 100,
       timestamptz '2024-01-01' + random() * interval '730 days'
FROM generate_series(1, 1000000) g
CROSS JOIN LATERAL (
    SELECT (ARRAY['DE','FR','US','JP','BR'])[k] AS country,
           (ARRAY['Berlin','Paris','Chicago','Osaka','Recife'])[k] AS city
    FROM (SELECT (floor(random() * 5) + 1 + g * 0)::int AS k) r
) c;

ANALYZE orders;
```

---

**Further reading**

- [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/17/using-explain.html)
- [PostgreSQL: Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/17/indexes-index-only-scans.html)
- [PostgreSQL: EXPLAIN (v18, BUFFERS by default)](https://www.postgresql.org/docs/18/sql-explain.html)
- [PostgreSQL: CREATE STATISTICS](https://www.postgresql.org/docs/17/sql-createstatistics.html)
