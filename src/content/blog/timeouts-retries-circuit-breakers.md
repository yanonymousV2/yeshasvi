---
title: "Timeouts, retries and circuit breakers: getting the order right"
description: "Timeouts, retries and circuit breakers each protect you from a failing dependency, but stacked in the wrong order they make an outage worse. Here's the order that works, why, and a Go implementation with tests."
pubDate: 2026-11-07
tags: [reliability, go, http, grpc, distributed-systems]
draft: true
---

A checkout service calls an inventory service. One afternoon the inventory database starts struggling and responses that usually take 40 ms start taking eight seconds.

The checkout service uses Go's `http.DefaultClient`, which has no timeout at all. Every request to checkout now holds a goroutine and a connection for eight seconds instead of 40 ms. Requests pile up behind it, and checkout starts timing out for its own callers.

Earlier, someone added "retry three times" to the mobile app, to the API gateway, and to checkout itself. Each of those layers sees a timeout and tries again. A single tap on "Pay" now turns into up to 3 × 3 × 3 = **27** requests to the inventory service, and the inventory service is already struggling. It doesn't recover until somebody turns traffic off.

Nothing in that story is exotic. Every piece was a reasonable idea on its own. The trouble is how they were combined.

## Three tools, three jobs

- A **timeout** limits how long you wait. Without one, a slow dependency becomes your slow service.
- A **retry** gets past *transient* failures: a dropped connection, one bad instance, a brief `503`.
- A **circuit breaker** stops calling a dependency that is clearly unhealthy, so you fail fast and give it room to recover.

Each one can make the others worse. Retries without a deadline turn one slow call into four slow calls. A timeout that wraps the retries can cut off the retry that would have worked. A breaker in the wrong place never sees most of the failures, so it opens far too late, while the retries keep hammering.

## The order, outermost first

1. **Total deadline** for the whole operation, including every retry.
2. **Retry loop**, with backoff, jitter and a budget.
3. **Circuit breaker**, consulted on every attempt.
4. **Per-attempt timeout**, around a single call.

You don't have to take my word for this. Microsoft's standard resilience handler for `HttpClient` chains its strategies in exactly this order, from outermost to innermost: rate limiter, total timeout, retry, circuit breaker, attempt timeout. Its defaults are a 30 s total timeout, 3 retries with exponential backoff and jitter, and a 10 s attempt timeout ([.NET docs](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience#standard-resilience-handler-defaults)). gRPC makes the same choice for its built-in retries: the call deadline "applies across all attempts", so an RPC fails once the deadline passes "regardless of how many attempts were configured" ([gRPC A6](https://github.com/grpc/proposal/blob/master/A6-client-retries.md)).

Here's why each layer sits where it does.

**The total deadline is outermost** because it's the only number your caller cares about. If the request to *your* service has two seconds left, nothing inside it should plan to take three.

**The per-attempt timeout is inside the retry loop.** If you only had a total timeout, one hung attempt would use up all of it and there'd be nothing left to retry with. With a per-attempt timeout, a hung attempt is cut off and becomes an ordinary failure that can be retried. Polly's documentation shows both arrangements side by side as sequence diagrams ([Polly: resilience pipelines](https://www.pollydocs.org/pipelines#diagrams)).

**The breaker sits between the two.** Inside the retry loop, it sees every attempt, so four failed attempts count as four failures, not one. Outside the per-attempt timeout, it counts an attempt that timed out as a failure, which is right: for a dependency that's falling over, slowness is the most common symptom. And when the breaker is open, the retry loop should get an immediate "no" and stop, rather than sleep and ask again.

## A Go implementation

The rest of this post builds the stack with only the standard library. Here's the breaker. It opens after a number of consecutive failures, stays open for a cooldown, then lets **one** probe call through. If the probe works, the circuit closes. If it fails, the circuit opens again.

```go
// ErrOpen is returned without calling the dependency while the circuit is open.
var ErrOpen = errors.New("circuit breaker is open")

type state int

const (
	closed state = iota
	open
	halfOpen
)

// Breaker opens after `threshold` consecutive failures, stays open for
// `cooldown`, then lets a single probe through to test the dependency.
type Breaker struct {
	mu        sync.Mutex
	threshold int
	cooldown  time.Duration
	state     state
	failures  int
	openedAt  time.Time
	gen       uint64 // bumped on every state change, so stale results are ignored
}

func NewBreaker(threshold int, cooldown time.Duration) *Breaker {
	return &Breaker{threshold: threshold, cooldown: cooldown}
}

// Allow asks permission for one call. The returned generation must be
// passed to Record or Cancel when the call finishes.
func (b *Breaker) Allow() (uint64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case open:
		if time.Since(b.openedAt) < b.cooldown {
			return 0, ErrOpen
		}
		b.setState(halfOpen) // this caller becomes the probe
	case halfOpen:
		return 0, ErrOpen // a probe is already in flight
	}
	return b.gen, nil
}

// Record reports the outcome of a call that Allow let through.
func (b *Breaker) Record(gen uint64, failed bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if gen != b.gen {
		return // the call started before the last state change
	}
	if !failed {
		b.failures = 0
		if b.state == halfOpen {
			b.setState(closed)
		}
		return
	}
	b.failures++
	if b.state == halfOpen || b.failures >= b.threshold {
		b.openedAt = time.Now()
		b.setState(open)
	}
}

// Cancel ends a call without counting it, e.g. because the caller gave up.
// A cancelled probe hands the job to the next caller.
func (b *Breaker) Cancel(gen uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if gen == b.gen && b.state == halfOpen {
		b.setState(open) // openedAt is old, so the next Allow probes at once
	}
}

func (b *Breaker) setState(s state) {
	b.state = s
	b.failures = 0
	b.gen++
}
```

Two details matter here.

- **Only one probe at a time.** While a probe is in flight, everyone else still gets `ErrOpen`. Otherwise every waiting caller would rush through the moment the cooldown ends.
- **Stale results are ignored.** A call that started before the circuit opened can finish after it did. The generation number stops that late success from closing a circuit that just opened for good reason.

Next, a retry budget. A breaker protects a dependency that's *down*. A budget protects one that's *degraded*, failing just often enough that the breaker stays closed while retries quietly multiply the load. This one copies gRPC's `retryThrottling`: each failure costs a token, each success earns back `tokenRatio` of one, and retries stop while the bucket is at or below half full ([gRPC A6, Throttling](https://github.com/grpc/proposal/blob/master/A6-client-retries.md#throttling-retry-attempts-and-hedged-rpcs)). A6's example configuration uses `maxTokens: 10` and `tokenRatio: 0.1`.

```go
// Budget throttles retries the way gRPC's retryThrottling does: failures
// cost a token, successes earn back a fraction of one, and retries stop
// while the bucket is at or below half full.
type Budget struct {
	mu     sync.Mutex
	tokens float64
	max    float64
	ratio  float64
}

func NewBudget(maxTokens int, ratio float64) *Budget {
	return &Budget{tokens: float64(maxTokens), max: float64(maxTokens), ratio: ratio}
}

func (b *Budget) record(failed bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if failed {
		b.tokens = max(b.tokens-1, 0)
	} else {
		b.tokens = min(b.tokens+b.ratio, b.max)
	}
}

func (b *Budget) canRetry() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.tokens > b.max/2
}
```

Now the retry loop, which ties everything together:

```go
type Policy struct {
	MaxAttempts    int           // including the first one
	BaseDelay      time.Duration // backoff before the first retry
	MaxDelay       time.Duration // cap on any single backoff
	AttemptTimeout time.Duration // limit for one attempt
}

// Permanent marks an error that retrying cannot fix, such as a 400.
func Permanent(err error) error { return permanentError{err} }

type permanentError struct{ err error }

func (p permanentError) Error() string { return p.err.Error() }
func (p permanentError) Unwrap() error { return p.err }

// retryAfter is implemented by errors that carry a server-suggested delay.
type retryAfter interface{ RetryAfter() time.Duration }

// Do calls fn until it succeeds, the attempts run out, or ctx ends.
// Layers, outermost first: ctx deadline > retries > breaker > attempt timeout.
func Do(ctx context.Context, p Policy, br *Breaker, bu *Budget, fn func(context.Context) error) error {
	var err error
	for attempt := 1; ; attempt++ {
		err = try(ctx, p, br, bu, fn)
		var perm permanentError
		switch {
		case err == nil:
			return nil
		case errors.As(err, &perm), errors.Is(err, ErrOpen):
			return err // retrying won't help, or the breaker says stop
		case ctx.Err() != nil:
			return fmt.Errorf("gave up after %d attempts: %w", attempt, ctx.Err())
		case attempt == p.MaxAttempts:
			return fmt.Errorf("gave up after %d attempts: %w", attempt, err)
		case !bu.canRetry():
			return fmt.Errorf("retry budget exhausted: %w", err)
		}

		delay := backoff(p, attempt)
		var ra retryAfter
		if errors.As(err, &ra) && ra.RetryAfter() > 0 {
			delay = ra.RetryAfter() // the server knows better than our formula
		}
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) < delay {
			return fmt.Errorf("no time left to retry: %w", err)
		}
		t := time.NewTimer(delay)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return fmt.Errorf("gave up after %d attempts: %w", attempt, ctx.Err())
		}
	}
}

// try runs one attempt through the breaker with its own timeout.
func try(ctx context.Context, p Policy, br *Breaker, bu *Budget, fn func(context.Context) error) error {
	gen, err := br.Allow()
	if err != nil {
		return err
	}
	actx, cancel := context.WithTimeout(ctx, p.AttemptTimeout)
	defer cancel()

	err = fn(actx)
	var perm permanentError
	switch {
	case err == nil:
		br.Record(gen, false)
		bu.record(false)
	case ctx.Err() != nil:
		br.Cancel(gen) // the caller gave up; that says nothing about the dependency
	case errors.As(err, &perm):
		br.Record(gen, false) // the dependency answered; the request was wrong
	default:
		br.Record(gen, true) // includes this attempt timing out
		bu.record(true)
	}
	return err
}

// backoff is "full jitter": a random delay between 0 and an exponential cap.
func backoff(p Policy, attempt int) time.Duration {
	ceiling := min(p.MaxDelay, p.BaseDelay<<(attempt-1))
	if ceiling <= 0 {
		return 0
	}
	return rand.N(ceiling)
}
```

Read `Do` from the top and you can see the order:

- **The caller's `ctx` is the total deadline.** Every attempt's context is derived from it, and the loop checks it before sleeping. If the deadline will pass before the next attempt could even start, it gives up at once instead of sleeping until the deadline and then failing.
- **`try` asks the breaker first,** then wraps the call in `context.WithTimeout` for the per-attempt limit.
- **Not every error counts against the dependency.** If the *caller* gave up, the attempt is cancelled without being counted. A `Permanent` error, like a `404`, counts as a success for the breaker: the dependency answered correctly, the request was wrong. Only real failures, including attempt timeouts, push the breaker toward open.
- **Backoff uses "full jitter".** The delay is a random value between zero and an exponential cap. Without the randomness, every client that failed at the same moment retries at the same moment too. gRPC's own retries use a gentler version of the same idea, multiplying each backoff by a random factor between 0.8 and 1.2.

Finally, an HTTP wrapper that decides which responses are worth retrying:

```go
// StatusError is a non-2xx response.
type StatusError struct {
	Code  int
	Delay time.Duration // from Retry-After, if the server sent one
}

func (e *StatusError) Error() string             { return fmt.Sprintf("unexpected status %d", e.Code) }
func (e *StatusError) RetryAfter() time.Duration { return e.Delay }

// Get fetches url with retries. Only use this pattern for idempotent requests.
func Get(ctx context.Context, c *http.Client, p Policy, br *Breaker, bu *Budget, url string) ([]byte, error) {
	var body []byte
	err := Do(ctx, p, br, bu, func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return Permanent(err)
		}
		resp, err := c.Do(req)
		if err != nil {
			return err // connection refused, reset, attempt timeout...
		}
		defer resp.Body.Close()

		switch {
		case resp.StatusCode == http.StatusTooManyRequests,
			resp.StatusCode == http.StatusBadGateway,
			resp.StatusCode == http.StatusServiceUnavailable,
			resp.StatusCode == http.StatusGatewayTimeout:
			secs, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
			return &StatusError{Code: resp.StatusCode, Delay: time.Duration(secs) * time.Second}
		case resp.StatusCode >= 300:
			return Permanent(&StatusError{Code: resp.StatusCode})
		}
		// Read the body inside the attempt: its context is cancelled when we return.
		body, err = io.ReadAll(resp.Body)
		return err
	})
	return body, err
}
```

`429`, `502`, `503` and `504` are retried. Network errors are retried. Any other non-`2xx` response is `Permanent`. If the server sends `Retry-After` with a number of seconds, that delay replaces the computed backoff. RFC 9110 defines the header as either an HTTP date or a number of seconds, and says a `503` may include it to tell clients how long to wait ([RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)). This code only handles the seconds form. An HTTP date falls back to normal backoff.

One Go-specific trap: **read the body inside the attempt.** The request context "controls the entire lifetime of a request and its response", including reading the body ([`http.NewRequestWithContext`](https://pkg.go.dev/net/http#NewRequestWithContext)). `try` cancels the attempt context as soon as `fn` returns, so a body read afterwards would fail.

Using it looks like this: one deadline from the caller, one breaker and one budget per dependency, shared by every request.

```go
h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	body, err := resilience.Get(ctx, client, policy, inventoryBreaker, inventoryBudget, url)
	if err != nil {
		http.Error(w, "inventory unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Write(body)
})
```

The tests cover the cases that matter: a transient `503` is retried, a `404` isn't and doesn't move the breaker, a hung attempt is cut off and retried, a 120 ms deadline holds even with 100 attempts allowed, an open breaker stops the loop after two calls, and against a dependency that always fails, the budget turns 20 calls into 23 requests instead of 80. They pass under `go test -race`.

## Production concerns

**Retry at one layer.** The 27× in the opening story came from three layers each retrying three times. Pick one layer, usually the one closest to the failing dependency, and let the others pass failures up. If you can't avoid retries at several layers, budgets keep the multiplication bounded.

**Only retry what's safe to repeat.** A timeout doesn't tell you whether the server did the work. Retrying a `GET` is fine. Retrying `POST /payments` needs an [idempotency key](../idempotency-keys/). Microsoft's handler retries all HTTP methods by default and provides `DisableForUnsafeHttpMethods` to turn off retries for `POST`, `PATCH`, `PUT`, `DELETE` and `CONNECT`. gRPC's design doc gives the same warning: retry only status codes that mean the server didn't process the request, unless you know the method is idempotent.

**Choose timeouts from data.** gRPC's guide suggests starting "with an educated guess based on what you know about your system", then validating it with load testing ([gRPC: Deadlines](https://grpc.io/docs/guides/deadlines/)). Then check the arithmetic: attempts × attempt timeout, plus the backoff, should fit inside the total deadline. Otherwise your later retries can never actually happen.

**Propagate deadlines.** When your service calls another service, derive the outgoing context from the incoming one (`r.Context()` in a Go HTTP handler), so the downstream call can't outlive the request that caused it. gRPC propagates deadlines automatically in Go and Java, and turns the deadline into a remaining *timeout* on the wire, so clock skew between servers doesn't matter. On the server side, gRPC cancels the call once the deadline passes, but your code still has to notice `ctx.Done()` and stop working.

**One breaker per dependency.** A breaker shared across all your dependencies opens on one bad service and blocks calls to the healthy ones. Keep a breaker per downstream service, or per host.

**Consider a ratio-based breaker under real traffic.** Counting consecutive failures is easy to reason about, but at high request rates one success resets the count. Polly's breaker opens on a failure *ratio* over a sampling window. Its defaults are a ratio of 0.1, a 30 s window, a minimum of 100 calls in that window, and a 5 s break ([Polly: circuit breaker](https://www.pollydocs.org/strategies/circuit-breaker#defaults)). The minimum-throughput rule stops the breaker from opening because three of your first five calls failed.

**Make state changes visible.** Log or count every time a breaker opens, closes or half-opens. A breaker that opens silently looks, from the outside, exactly like the dependency being down.

## Checklist

- [ ] Every outgoing call has a timeout. Nothing uses a client with no timeout.
- [ ] The total deadline wraps the retries; a per-attempt timeout sits inside them
- [ ] The breaker sees every attempt and counts timeouts as failures
- [ ] An open breaker ends the retry loop immediately
- [ ] Retries use exponential backoff with jitter and a retry budget
- [ ] Only one layer retries, and only idempotent operations are retried
- [ ] `Retry-After` is honoured, but never past the deadline
- [ ] Deadlines propagate to downstream calls
- [ ] Breaker state changes are logged and graphed

A slow dependency will happen. What you control is whether your service absorbs it or passes it on, multiplied.

---

**Further reading**

- [gRPC A6: Client Retries](https://github.com/grpc/proposal/blob/master/A6-client-retries.md), the gRPC design proposal for retries, backoff, throttling and pushback
- [gRPC: Deadlines](https://grpc.io/docs/guides/deadlines/)
- [Build resilient HTTP apps: standard resilience handler](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience), .NET documentation
- [Polly: resilience pipelines](https://www.pollydocs.org/pipelines) and [circuit breaker strategy](https://www.pollydocs.org/strategies/circuit-breaker)
- [RFC 9110 §10.2.3: Retry-After](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)
- [Go `net/http`: `Client` and `NewRequestWithContext`](https://pkg.go.dev/net/http)
