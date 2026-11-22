---
title: "gRPC deadlines and cancellation: making every hop give up together"
description: "A client that times out doesn't stop the work it started three services away, unless every hop passes its deadline and cancellation along. Here's how gRPC carries deadlines on the wire, where propagation breaks, and a tested Go implementation."
pubDate: 2026-11-22
tags: [grpc, go, reliability, distributed-systems]
draft: true
---

A mobile app calls `GetProfile` on a user service with a 2-second deadline. The user service calls a billing service to fetch recent transactions, and billing runs a slow database query.

At the two-second mark the app gives up and shows an error. The user pulls to refresh, and the app sends the request again.

Meanwhile, nothing downstream has noticed. The user service called billing with `context.Background()`, so billing has no deadline and no idea the app has gone. It keeps the query running for another ten seconds and returns a result nobody is waiting for. Every refresh starts another one. The database is now busy with queries whose callers have all hung up, so the new queries are slow too, and more apps time out and refresh.

The app did the right thing by setting a deadline. The deadline just stopped at the first hop.

## Deadlines and cancellation are one signal

A **deadline** is the point in time after which the caller no longer wants the answer. **Cancellation** is the caller saying the same thing early: the user navigated away, a sibling request already failed, the process is shutting down. gRPC treats them as one signal. Its cancellation guide lists deadline expiry and I/O errors as things that "also trigger cancellation", and says that cancellation "should ideally propagate to all ongoing computation in the system that was initiated due to the original client RPC call" ([gRPC: Cancellation](https://grpc.io/docs/guides/cancellation/)).

In Go, both live in a `context.Context`. A deadline is a context that cancels itself at a certain time. That makes the rule simple to state: **every piece of work started for a request must use a context derived from that request's context.** The rest of this post is about the places where that rule quietly breaks.

## What actually goes over the wire

By default, gRPC sets no deadline at all, so a client "can end up waiting for a response effectively forever" ([gRPC: Deadlines](https://grpc.io/docs/guides/deadlines/)). When you do set one, it travels as a request header defined in the gRPC-over-HTTP/2 spec:

```text
grpc-timeout = 1S
```

The value is a positive integer of at most 8 digits followed by a unit: `H`, `M`, `S`, `m` (milliseconds), `u` (microseconds) or `n` (nanoseconds). If the header is missing, the server "should assume an infinite timeout" ([PROTOCOL-HTTP2.md](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md#requests)).

Notice that it's a *timeout*, a duration, and not a timestamp. The client converts its deadline into "time remaining" just before sending, and the server turns that back into a local deadline when the request arrives. The deadlines guide explains why: the two machines' clocks may disagree, and converting to a timeout "shields your system from any clock skew issues". The flip side is that time spent in transit isn't deducted, so each hop's deadline ends up slightly later than the original. In the tests below, two in-process hops added a couple of milliseconds. Over a real network, this is one more reason to keep some headroom.

You can see the conversion in gRPC-Go's transport. The client reads `ctx.Deadline()`, computes `time.Until(dl)`, and writes it with the smallest unit that fits in 8 digits, rounding up: 50 ms goes out as `50000000n`, 2 s as `2000000u`. If the deadline has already passed, the client doesn't send the request at all and fails at once with `DEADLINE_EXCEEDED`. On the server, a `grpc-timeout` header becomes a `context.WithTimeout` around the handler's context, plus a timer that resets the stream with an HTTP/2 `CANCEL` when it fires. (All of this is from the [`internal/transport`](https://github.com/grpc/grpc-go/tree/master/internal/transport) package in grpc-go v1.85.0.)

When a client cancels, the same `RST_STREAM` with `CANCEL` goes to the server. The spec maps it to "call cancellation when sent by a client" ([PROTOCOL-HTTP2.md, Errors](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md#errors)), and in Go that means the handler's `ctx.Done()` closes.

## Propagation in Go is just passing `ctx`

The deadlines guide says automatic propagation is enabled by default in Java and Go. In Go, "automatic" has a very specific meaning: the deadline goes downstream if, and only if, you pass the handler's `ctx` (or something derived from it) to the outgoing call. gRPC-Go has no hidden per-request state. Pass `context.Background()` and the chain is cut, which is exactly the bug in the opening story.

There's a second half that no library can do for you. The guide is blunt about it: "the server application is responsible for stopping any activity it has spawned to service the RPC." gRPC cancels the context. Your code has to look at it.

## A Go implementation

The code below uses gRPC-Go v1.85.0 and, to avoid a page of generated code, the `TestService` from gRPC's own interop test protos (`google.golang.org/grpc/interop/grpc_testing`). A client calls a frontend, which calls a backend.

### Server side: no deadline-less calls, no hopeless calls

Two kinds of incoming call deserve special treatment. A call with **no deadline** could run forever, so the server gives it a default. A call with **almost no time left** can never succeed, so the server rejects it before doing any work. The deadlines guide describes that second case, a deadline too short to ever finish in time, as one that wastes server resources.

```go
// ServerDeadlines gives calls without a deadline a default one, and rejects
// calls that arrive with less than min left, before any work starts.
func ServerDeadlines(fallback, min time.Duration) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		dl, ok := ctx.Deadline()
		if !ok {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, fallback)
			defer cancel()
		} else if left := time.Until(dl); left < min {
			return nil, status.Errorf(codes.DeadlineExceeded,
				"%s: %v left, need at least %v", info.FullMethod, left.Round(time.Millisecond), min)
		}
		return handler(ctx, req)
	}
}
```

### Work that notices cancellation

The backend does its work in steps and checks the context between them. In a real service the "step" might be a database query, a call to another service, or one pass through a loop.

```go
func (b *Backend) UnaryCall(ctx context.Context, req *testpb.SimpleRequest) (*testpb.SimpleResponse, error) {
	if b.Started != nil {
		b.Started(ctx)
	}
	for i := 0; i < b.Steps; i++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err() // gRPC-Go maps this to DEADLINE_EXCEEDED or CANCELLED
		case <-time.After(b.Step): // stand-in for one chunk of real work
		}
	}
	return &testpb.SimpleResponse{Username: "backend"}, nil
}
```

Returning `ctx.Err()` directly is fine. When a handler returns a plain error, gRPC-Go converts it with `status.FromContextError`, so `context.DeadlineExceeded` becomes `DEADLINE_EXCEEDED` and `context.Canceled` becomes `CANCELLED`. Any other non-status error becomes `UNKNOWN`.

### Calling downstream with headroom

If the frontend passed its full deadline to the backend, a slow backend would use up every last millisecond, and the frontend would have no time left to do anything useful with the failure. So it gives the backend a slightly earlier deadline:

```go
// ErrNoTimeLeft is the cause recorded when a downstream call runs out of its share.
var ErrNoTimeLeft = errors.New("downstream call used up its share of the deadline")

// WithHeadroom returns a context that expires `reserve` before ctx does, so
// the caller still has time to act on a downstream timeout.
func WithHeadroom(ctx context.Context, reserve time.Duration) (context.Context, context.CancelFunc) {
	dl, ok := ctx.Deadline()
	if !ok {
		return context.WithCancel(ctx)
	}
	return context.WithDeadlineCause(ctx, dl.Add(-reserve), ErrNoTimeLeft)
}
```

`context.WithDeadlineCause` (added in Go 1.21) records *why* the context ended. `ctx.Err()` still reports `context.DeadlineExceeded`, so gRPC and every other library behave normally, but `context.Cause(ctx)` returns `ErrNoTimeLeft`. That makes logs far easier to read than a wall of identical "context deadline exceeded" messages.

The frontend uses it like this:

```go
func (f *Frontend) UnaryCall(ctx context.Context, req *testpb.SimpleRequest) (*testpb.SimpleResponse, error) {
	callCtx, cancel := WithHeadroom(ctx, 50*time.Millisecond)
	defer cancel()

	resp, err := f.Backend.UnaryCall(callCtx, req)
	if status.Code(err) == codes.DeadlineExceeded && ctx.Err() == nil {
		// The backend ran out of its share, but our caller is still waiting.
		resp, err = &testpb.SimpleResponse{Username: "fallback"}, nil
	}
	if err != nil {
		return nil, err
	}

	// Must happen even if the caller hangs up right now.
	Detach(ctx, 2*time.Second, func(ctx context.Context) {
		f.Audit(ctx, "served "+resp.GetUsername())
	})
	return resp, nil
}
```

The check `ctx.Err() == nil` matters. It separates "the backend was too slow, but my caller is still waiting" (serve a fallback) from "my caller has already gone" (just return; nobody will read the reply).

### Work that must outlive the request

Some work shouldn't stop when the caller hangs up: an audit record, a cache fill, the second half of something that already changed state. Starting it with `context.Background()` loses the request's values, like trace IDs and auth info. `context.WithoutCancel` (also Go 1.21) keeps the values but drops the cancellation and the deadline. Its documentation says the result "returns no Deadline or Err, and its Done channel is nil". So give it a timeout of its own:

```go
// Detach runs fn in the background with ctx's values (trace IDs, auth) but
// not its cancellation, bounded by its own timeout.
func Detach(ctx context.Context, timeout time.Duration, fn func(context.Context)) {
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	go func() {
		defer cancel()
		fn(dctx)
	}()
}
```

Detaching should be a deliberate, visible choice, not an accident. A grep for `WithoutCancel` should find every place where your service keeps working after its caller has left.

### Blocking calls that don't take a context

Some APIs block without accepting a context. A raw `net.Conn` read is the classic example. `context.AfterFunc` (Go 1.21) runs a function in its own goroutine when a context is done, which is enough to unblock them. This follows the `AfterFunc` connection example in the `context` package documentation:

```go
// ReadContext reads from conn, but gives up when ctx is done, even though
// conn.Read itself knows nothing about contexts.
func ReadContext(ctx context.Context, conn net.Conn, b []byte) (int, error) {
	fired := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		conn.SetReadDeadline(time.Now()) // unblocks the pending Read
		close(fired)
	})

	n, err := conn.Read(b)
	if !stop() {
		// The AfterFunc ran: wait for it, then clear the deadline so the
		// connection is still usable.
		<-fired
		conn.SetReadDeadline(time.Time{})
		return n, context.Cause(ctx)
	}
	return n, err
}
```

The `stop()` dance matters. If `stop` returns false, the function has already started, so the code waits for it and then clears the read deadline. Otherwise a late-firing `AfterFunc` would leave a deadline in the past, and the next read on the same connection would fail.

### What the tests check

The tests run the whole chain over gRPC's in-memory `bufconn` listener, and pass under `go test -race`:

- The backend's deadline is about 50 ms earlier than the client's: propagated, minus the headroom.
- When the client cancels mid-call, the backend's context is cancelled with `context.Canceled`.
- A frontend that calls with `context.Background()` leaves the backend working on its own 5-second default long after the client got `DEADLINE_EXCEEDED`. This is the opening story in miniature.
- A call arriving with 20 ms left at a server that needs 100 ms is rejected with `DEADLINE_EXCEEDED`, and the handler never runs.
- A call with no deadline is cut off by the server's default, and the client sees `DEADLINE_EXCEEDED` from the returned `ctx.Err()`.
- A slow backend produces the fallback response while the client still has time.
- Detached work finishes after the RPC is over, keeps context values, and ends on its own timeout.
- `ReadContext` unblocks a read that would otherwise wait forever, returns the cancellation cause, and leaves the connection usable for the next read.

## Production concerns

**`DEADLINE_EXCEEDED` doesn't mean nothing happened.** The status code docs say it "may be returned even if the operation has completed successfully" ([gRPC status codes](https://grpc.github.io/grpc/core/md_doc_statuscodes.html)). The gRPC deadlines blog post makes the same point: client and server decide independently whether a call succeeded, so the server can finish while the client times out ([gRPC and Deadlines](https://grpc.io/blog/deadlines/)). Retrying a state-changing call after a deadline needs an [idempotency key](../idempotency-keys/).

**Budget the whole chain.** A deadline is shared by every hop below it. If the frontend's caller allows 2 seconds and the frontend makes three serial calls, those three calls share 2 seconds, minus the frontend's own work and headroom. Retries come out of the same budget; the [timeouts and retries post](../timeouts-retries-circuit-breakers/) covers the ordering.

**Check before expensive work.** The deadlines blog post recommends checking "if there is still a client waiting" before starting expensive processing. The interceptor's minimum-time check is one way; a `ctx.Err()` check before a large query or a fan-out is another.

**Don't give servers infinite patience.** Clients that forget a deadline send no `grpc-timeout` at all. A server-side default, like the interceptor's `fallback`, puts an upper bound on how long any one request can hold resources.

**Make deadlines configurable.** The same blog post suggests reading the deadline from a flag, so you can raise or lower it during an incident without shipping a new build.

**Log the cause, not just the code.** `context.Cause` tells you *which* layer ran out of time. Without it, every hop's log line says the same thing and you're left matching timestamps.

## Checklist

- [ ] Every client call sets a deadline; nothing relies on gRPC's default of none
- [ ] Handlers pass their incoming `ctx` to every downstream call, query and goroutine
- [ ] No `context.Background()` or `context.TODO()` inside request handling
- [ ] Long-running work checks `ctx.Done()` between steps
- [ ] Servers set a default deadline for calls that arrive without one
- [ ] Calls with too little time left are rejected before any work starts
- [ ] Downstream calls get some headroom, so the caller can still respond
- [ ] Work that must outlive the request uses `context.WithoutCancel` plus its own timeout
- [ ] State-changing calls that hit `DEADLINE_EXCEEDED` are retried only with an idempotency key

A deadline is a promise about when the answer stops mattering. It's only useful if every hop hears it.

---

**Further reading**

- [gRPC: Deadlines](https://grpc.io/docs/guides/deadlines/) and [gRPC: Cancellation](https://grpc.io/docs/guides/cancellation/), official guides
- [gRPC and Deadlines](https://grpc.io/blog/deadlines/), gRPC blog
- [gRPC over HTTP/2 (PROTOCOL-HTTP2.md)](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md), the wire spec, including `grpc-timeout` and `RST_STREAM` mapping
- [gRPC status codes](https://grpc.github.io/grpc/core/md_doc_statuscodes.html)
- [grpc-go deadline example](https://github.com/grpc/grpc-go/tree/master/examples/features/deadline) and [cancellation example](https://github.com/grpc/grpc-go/tree/master/examples/features/cancellation)
- [Go `context` package](https://pkg.go.dev/context): `WithDeadlineCause`, `WithoutCancel`, `AfterFunc`, `Cause`
