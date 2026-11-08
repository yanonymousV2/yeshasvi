---
title: "Backpressure in Go with bounded channels"
description: "When work arrives faster than you can finish it, something has to give, and by default it's your memory. Here's how bounded channels, worker pools and load shedding let a Go service say \"not now\" on purpose, with tested code."
pubDate: 2026-11-08
tags: [go, concurrency, reliability, backpressure, http]
draft: false
---

An ingest service receives events over HTTP and forwards each one to a downstream API. To keep responses fast, the handler doesn't wait for the forward. It runs `go forward(event)` and returns `202 Accepted` straight away.

This works for months. Then the downstream API slows from 20 ms to 20 seconds. Events still arrive at the same rate, but each forwarding goroutine now lives a thousand times longer. Goroutines are cheap, but they aren't free: each one holds its stack, the event body, and probably a connection. Memory climbs until the process is killed, and every event still waiting in those goroutines is lost.

The bug isn't the slow dependency. The bug is that the service had no limit on how much work it would accept but not yet finish. When the work coming in is faster than the work going out, the difference has to live somewhere. Without a limit, it lives in memory until there isn't any left.

**Backpressure** is the fix: when you're full, you push back on whoever is sending you work, so they slow down, wait, or go elsewhere.

## Measuring the problem

A test makes this concrete. It simulates a dependency that has stopped answering and sends 10,000 events at it, first with a goroutine per event, then through the bounded pool built later in this post (8 workers, a queue of 100):

```text
unbounded: 10000 goroutines; bounded: 8 goroutines, 100 queued at most, 9900 refused
```

The unbounded version holds all 10,000 events in memory with no end in sight. The bounded one holds at most 108 (8 running, 100 waiting) and tells the other senders "no" right away. (The refused count varies slightly from run to run, depending on how many jobs the workers had already picked up.) Refusing work feels worse than accepting it, but a refusal is something a client can act on. A process that runs out of memory loses everything.

## The idea: put a number on it

There are only three things a full system can do with new work:

1. **Block** the sender until there's room. The pressure travels upstream.
2. **Drop** the work and tell the sender, so it can retry later or go elsewhere. This is load shedding.
3. **Buffer** it without limit. This is the option that kills the process.

Good designs use the first two and never the third. In Go, the tool for both is a buffered channel, because its size is fixed when you create it. The Go spec says a buffered channel's communication "succeeds without blocking if the buffer is not full (sends) or not empty (receives)" ([The Go Programming Language Specification: Channel types](https://go.dev/ref/spec#Channel_types)). Once it's full, a send blocks. That's backpressure, built into the language.

Whether you block or drop comes down to one `select`. A plain send blocks. A `select` with a `default` case doesn't, because when no other case can proceed, "if there is a default case, that case is chosen" ([Select statements](https://go.dev/ref/spec#Select_statements)).

## A bounded worker pool

Here's a pool with a fixed number of workers and a fixed-size queue. It offers both behaviours: `TrySubmit` drops when full, and `Submit` waits, but only as long as the caller's context allows.

```go
var (
	ErrFull   = errors.New("queue is full")
	ErrClosed = errors.New("queue is closed")
)

// Pool runs jobs on a fixed number of workers, fed by a bounded queue.
type Pool struct {
	jobs   chan func()
	wg     sync.WaitGroup
	mu     sync.RWMutex // guards closed, and stops Close racing a send
	closed bool
}

func NewPool(workers, queueSize int) *Pool {
	p := &Pool{jobs: make(chan func(), queueSize)}
	for i := 0; i < workers; i++ {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			for job := range p.jobs {
				job()
			}
		}()
	}
	return p
}

// TrySubmit queues job if there is room right now, and fails fast if not.
func (p *Pool) TrySubmit(job func()) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		return ErrClosed
	}
	select {
	case p.jobs <- job:
		return nil
	default:
		return ErrFull
	}
}

// Submit waits for room in the queue until ctx is done.
func (p *Pool) Submit(ctx context.Context, job func()) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		return ErrClosed
	}
	select {
	case p.jobs <- job:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
```

The workers are what limit concurrency: there are exactly `workers` goroutines, however much work arrives. The channel is what limits memory: at most `queueSize` jobs wait in it. Effective Go describes the same approach, starting "a fixed number of `handle` goroutines all reading from the request channel", and points out that the obvious alternative, a goroutine per request gated by a semaphore, "can consume unlimited resources if the requests come in too fast" unless you gate the goroutine creation as well ([Effective Go: Channels](https://go.dev/doc/effective_go#channels)).

Shutting down is the part that's easy to get wrong:

```go
// Len reports how many jobs are waiting. Export it as a metric.
func (p *Pool) Len() int { return len(p.jobs) }

// Close stops accepting jobs, lets the workers finish everything
// already queued, and waits for them.
func (p *Pool) Close() {
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		close(p.jobs)
	}
	p.mu.Unlock()
	p.wg.Wait()
}
```

Closing the channel is how the workers learn to stop: `for job := range p.jobs` keeps receiving until the buffer is empty, then exits. So every job that was accepted still runs. But "a send on a closed channel proceeds by causing a run-time panic" ([Send statements](https://go.dev/ref/spec#Send_statements)), so `Close` must never close the channel while another goroutine is in the middle of a send. That's what the `RWMutex` is for. Submitters hold the read lock while they send, and `Close` takes the write lock, so it waits for any send in progress to finish. A `Submit` blocked on a full queue still finishes, because the workers keep draining. Once `Close` holds the lock, later callers see `closed` and get `ErrClosed`.

The tests check this. One closes the pool while 50 goroutines are submitting, and asserts that the number of jobs accepted equals the number that ran: none lost, no panic, clean under `go test -race`.

## Shedding load in an HTTP handler

Back to the ingest service. The handler now queues the event instead of starting a goroutine. If the queue is full, it waits a little, then gives up and says so:

```go
// Ingest accepts an event, queues it for background processing and
// returns 202. If the queue stays full for maxWait, it sheds the request.
func Ingest(p *Pool, maxWait time.Duration, process func([]byte)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			http.Error(w, "could not read body", http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), maxWait)
		defer cancel()
		err = p.Submit(ctx, func() { process(body) })

		switch {
		case err == nil:
			w.WriteHeader(http.StatusAccepted)
		case errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrClosed):
			w.Header().Set("Retry-After", "1")
			http.Error(w, "server is overloaded, try again later", http.StatusServiceUnavailable)
		default:
			// The client went away while we waited; nobody is listening.
			http.Error(w, "request cancelled", http.StatusServiceUnavailable)
		}
	})
}
```

A short wait smooths over brief bursts without making clients hang. The wait is derived from `r.Context()`, so if the client disconnects, the handler stops waiting too.

The status code matters. RFC 9110 defines `503 Service Unavailable` as the server being "currently unable to handle the request due to a temporary overload or scheduled maintenance", and says the server may send `Retry-After` to suggest how long to wait ([RFC 9110 §15.6.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4)). That's exactly this situation. `429 Too Many Requests` is different: it means "the user has sent too many requests in a given amount of time" ([RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4)). Use `429` when one caller is over its own limit and `503` when the whole server is full. In gRPC, the matching code for a server that is temporarily out of resources is `RESOURCE_EXHAUSTED` ([gRPC status codes](https://github.com/grpc/grpc/blob/master/doc/statuscodes.md)).

One more thing about `202`. RFC 9110 calls it "intentionally noncommittal": the request "has been accepted for processing, but the processing has not been completed" ([§15.3.3](https://www.rfc-editor.org/rfc/rfc9110#section-15.3.3)). An in-memory queue matches that promise only loosely. If the process crashes, queued events are gone. If an accepted event must never be lost, write it somewhere durable before you return `202`, for example with the [outbox pattern](../outbox-pattern/).

## Limiting concurrent requests

Sometimes there's no background work at all, and the problem is simply too many requests running at once. `net/http` doesn't limit this for you: `Server.Serve` accepts connections, "creating a new service goroutine for each" ([net/http source](https://github.com/golang/go/blob/master/src/net/http/server.go)). A buffered channel used as a semaphore caps it:

```go
// LimitConcurrency lets at most n requests run next at once and
// rejects the rest immediately instead of queueing them.
func LimitConcurrency(n int, next http.Handler) http.Handler {
	sem := make(chan struct{}, n)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case sem <- struct{}{}:
			defer func() { <-sem }()
			next.ServeHTTP(w, r)
		default:
			w.Header().Set("Retry-After", "1")
			http.Error(w, "server is busy", http.StatusServiceUnavailable)
		}
	})
}
```

A token goes into the channel when a request starts and comes out when it ends. With `n` tokens in, the `default` case rejects new requests immediately. If you'd rather wait with a context, or need requests to take different amounts of capacity, `golang.org/x/sync/semaphore` provides a weighted semaphore with `Acquire(ctx, n)` and `TryAcquire(n)` ([pkg.go.dev](https://pkg.go.dev/golang.org/x/sync/semaphore)). To cap connections rather than requests, `golang.org/x/net/netutil.LimitListener` "accepts at most n simultaneous connections" ([pkg.go.dev](https://pkg.go.dev/golang.org/x/net/netutil#LimitListener)).

## Backpressure inside a pipeline

Inside a single process, you usually want to block rather than drop. If a pipeline of goroutines connects its stages with bounded channels, a slow last stage slows down every stage before it, automatically:

```go
// Stage reads from in, applies f, and writes to a channel with room
// for buf results. When the consumer is slow, out fills up, Stage
// blocks on its send, stops reading in, and the producer blocks too.
func Stage[T, U any](in <-chan T, buf int, f func(T) U) <-chan U {
	out := make(chan U, buf)
	go func() {
		defer close(out)
		for v := range in {
			out <- f(v)
		}
	}()
	return out
}
```

In the test, a producer sends 200 items through a stage with a buffer of 4 to a deliberately slow consumer. The producer was never more than 6 items ahead of the consumer: 4 in the buffer, 1 held by the stage while it waits to send, and 1 the consumer was still working on. Memory stays flat however long the pipeline runs. Replace that buffer with a slice that grows, and the producer runs as far ahead as its input allows.

## Choosing the numbers

**Workers** are set by what the downstream can handle, not by how many CPUs you have. If each job holds a database connection, the worker count should fit inside your [connection pool](../connection-pooling/).

**Queue size** is set by how long you're willing to make work wait. If 8 workers each take about 50 ms per job, the pool finishes roughly 160 jobs a second, so a queue of 100 means the last job waits around 0.6 s. A queue of 10,000 means about a minute, which is past the point where most clients have given up and retried. Long queues don't add capacity; they add latency and hide the problem until it's large.

**Don't use a huge buffer as a fix.** `make(chan T, 1_000_000)` is technically bounded, but it lets a million items pile up before anything pushes back.

## Running it in production

- **Export the queue length.** `len` on a channel gives the "number of elements queued in channel buffer" ([Length and capacity](https://go.dev/ref/spec#Length_and_capacity)). It's a snapshot that may change immediately, which is fine for a gauge. A queue that stays near full means you need more capacity or less work; one that sits at zero means it's sized fine.
- **Count rejections.** A rise in `503`s is the signal that backpressure is doing its job, and the place to look first.
- **Make clients behave.** Shedding only helps if clients back off. Pair it with retries that honour `Retry-After`, use jitter and stay within a budget, as described in [timeouts, retries and circuit breakers](../timeouts-retries-circuit-breakers/).
- **Shed early and cheaply.** Reject before doing expensive work. The `Ingest` handler reads at most 64 KB before deciding; anything costlier should come after the queue check.
- **Drain on shutdown.** Stop accepting, finish what's queued, then exit. `Close` does this. Call it after the HTTP server has stopped taking requests, so callers aren't shed with `503` during a normal shutdown.

## Checklist

- [ ] No `go f()` per request or per message without a limit around it
- [ ] Every queue between goroutines is a bounded channel, never a growing slice
- [ ] Worker count is sized for the downstream, queue size for the latency you can tolerate
- [ ] Full queues either block with a deadline or reject; nothing waits forever
- [ ] Overload returns `503` with `Retry-After` (or `429` for per-client limits, `RESOURCE_EXHAUSTED` in gRPC)
- [ ] Shutdown stops intake, drains the queue and waits for workers
- [ ] Queue length and rejection counts are exported as metrics
- [ ] Work that must survive a crash is written durably before `202`

Every system has a limit. Backpressure means you pick it, and you decide what happens when you reach it.

---

**Further reading**

- [The Go Programming Language Specification](https://go.dev/ref/spec): channel types, send statements, select statements, `len` and `cap`
- [Effective Go: Channels](https://go.dev/doc/effective_go#channels), on using buffered channels as semaphores and fixed worker pools
- [RFC 9110 §15.6.4: 503 Service Unavailable](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4) and [§15.3.3: 202 Accepted](https://www.rfc-editor.org/rfc/rfc9110#section-15.3.3)
- [RFC 6585 §4: 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585#section-4)
- [gRPC status codes](https://github.com/grpc/grpc/blob/master/doc/statuscodes.md)
- [`golang.org/x/sync/semaphore`](https://pkg.go.dev/golang.org/x/sync/semaphore) and [`golang.org/x/net/netutil`](https://pkg.go.dev/golang.org/x/net/netutil)
