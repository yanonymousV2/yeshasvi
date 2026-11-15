---
title: "Rate limiting: token bucket vs sliding window"
description: "A fixed \"100 requests per minute\" counter can let 200 requests through in a tenth of a second. Here's how fixed windows, sliding windows and token buckets actually behave, how to return 429 properly, and how to share a limit across instances with Redis, with tested Go code."
pubDate: 2026-11-15
tags: [rate-limiting, api-design, reliability, go, redis, http]
draft: true
---

An API allows each client 100 requests per minute. The implementation is the obvious one: a counter per client per minute, reset when the clock ticks over. It's simple, it's fast, and it's easy to explain in the docs.

Then a client sends 150 requests at 12:00:59.9 and another 150 at 12:01:00.0. The counter for 12:00 lets 100 through. A tenth of a second later the counter for 12:01 starts at zero and lets another 100 through. The database behind the API, sized for "100 a minute" per client, just took 200 requests from one client in 100 milliseconds.

Nothing was broken. The limit did exactly what it was written to do. The problem is that "100 requests per minute" doesn't say *which* minute, or how bursty those 100 requests may be. Different algorithms answer that question differently, and the answer is what your downstream systems actually feel.

Here is the same burst run against the three limiters built in this post, each configured for 100 per minute:

```text
fixed window   allowed 200 of 300 within 100ms
sliding window allowed 100 of 300 within 100ms
token bucket   allowed 100 of 300 within 100ms
```

## Two questions every limit has to answer

Before picking an algorithm, be clear about what you're limiting:

1. **The sustained rate.** How much work a client may do over a long period, like 100 requests a minute.
2. **The burst.** How much of that it may do all at once. A client that's been quiet for an hour might reasonably send 20 requests in one go. Should it be allowed to send 100?

And you need to decide **who** is being limited: an API key, a user, a tenant, an IP address. That's the key the counters hang off.

HTTP gives you a status code for "you've exceeded it": `429 Too Many Requests`, defined in [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4). The RFC says the response "MAY include a Retry-After header indicating how long to wait before making a new request", and it deliberately doesn't define how the server identifies the user or counts requests. That part is up to you.

## Fixed window

The fixed window counter is the one from the opening: one counter per client per window, reset at each boundary. The Redis documentation for [`INCR`](https://redis.io/docs/latest/commands/incr/) presents it as its first rate limiter pattern: a key per IP per second, incremented, with an expiry so old counters clean themselves up.

It's cheap (one integer per client) and easy to reason about. Its weakness is the boundary. A client can use a full window's quota at the end of one window and another full quota at the start of the next. For many APIs that's acceptable. For a limit that protects something fragile, it isn't.

## Sliding window log

The exact answer to "no more than 100 in *any* 60 seconds" is to remember the timestamp of every allowed request, drop the ones older than 60 seconds, and refuse when 100 remain. That's a sliding window log. It's precise, but it stores one entry per request per client. At 100 requests a minute that's tolerable; at 10,000 a second it's a lot of memory spent just counting.

## Sliding window counter

The sliding window counter keeps the cheap counters of the fixed window and smooths out the boundary. It keeps two numbers: the count for the current fixed window and the count for the previous one. It then estimates how many requests happened in the last 60 seconds by assuming the previous window's requests were spread evenly across it:

```text
estimate = previous × (fraction of the previous window still inside the last 60s) + current
```

Fifteen seconds into a window, three quarters of the previous window still overlaps the last minute, so 75% of its count is added. Here it is in Go. All the limiters in this post take the current time as an argument, which keeps the tests deterministic:

```go
// Decision is the answer to "may this request go ahead?".
type Decision struct {
	Allowed    bool
	Remaining  int           // requests the caller could still make right now
	RetryAfter time.Duration // when refused: how long until one more request would be allowed
}
```

```go
func (s *SlidingWindow) Allow(now time.Time) Decision {
	s.mu.Lock()
	defer s.mu.Unlock()

	if ws := now.Truncate(s.window); !ws.Equal(s.start) {
		if ws.Sub(s.start) == s.window {
			s.prev = s.count // we moved into the very next window
		} else {
			s.prev = 0 // idle for more than a whole window
		}
		s.start, s.count = ws, 0
	}

	overlap := 1 - float64(now.Sub(s.start))/float64(s.window)
	estimate := float64(s.prev)*overlap + float64(s.count)
	if estimate+1 <= float64(s.limit) {
		s.count++
		return Decision{Allowed: true, Remaining: int(float64(s.limit) - estimate - 1)}
	}
	return Decision{RetryAfter: s.retryAfter(now)}
}
```

In the opening scenario, the first 100 requests fill the 12:00 window. At 12:01:00.0 that whole window still overlaps, so the estimate starts at 100 and the next 150 requests are refused. The boundary burst is gone, and it costs two integers per client.

The `retryAfter` helper (in the tested code) solves the same formula for the moment one more request would fit, so a refusal can tell the client exactly how long to wait. The tests check that it's accurate to the millisecond: still refused just before that time, allowed just after.

## Token bucket

The token bucket comes at the problem from a different direction. Each client has a bucket that holds up to `burst` tokens and refills at `rate` tokens per second. A request takes a token. No token, no request.

The two numbers map directly onto the two questions from earlier. `rate` is the sustained rate; `burst` is how much a quiet client may save up. "100 a minute, at most 20 at once" is `rate = 100.0/60`, `burst = 20`, which neither window algorithm can express.

The implementation doesn't need a timer. It refills lazily, adding the tokens earned since the last call:

```go
func (b *TokenBucket) Allow(now time.Time) Decision {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Refill lazily: add the tokens earned since the last call, capped at burst.
	if !b.last.IsZero() {
		if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
			b.tokens = math.Min(b.burst, b.tokens+elapsed*b.rate)
		}
	}
	if now.After(b.last) {
		b.last = now
	}

	if b.tokens >= 1 {
		b.tokens--
		return Decision{Allowed: true, Remaining: int(b.tokens)}
	}
	wait := (1 - b.tokens) / b.rate // seconds until the next whole token
	return Decision{RetryAfter: time.Duration(wait * float64(time.Second))}
}
```

`RetryAfter` falls straight out of the arithmetic: if you have 0.4 tokens and earn 10 a second, the next whole token arrives in 60 ms.

You rarely need to write this yourself in a single Go process. [`golang.org/x/time/rate`](https://pkg.go.dev/golang.org/x/time/rate) provides a `Limiter` that, in its own words, "implements a 'token bucket' of size b, initially full and refilled at rate r tokens per second". It's safe for concurrent use and offers three ways to spend a token: `Allow` returns false when none is available, `Reserve` tells you how long to wait for one, and `Wait` blocks until one is available or the context is cancelled. `Allow` is the one for servers that reject; `Wait` is the one for clients that want to pace themselves under someone else's limit.

## Neither one means "100 in any 60 seconds"

This is the part that's easy to miss. Both the sliding window counter and a token bucket with `burst = 100` fix the boundary burst, but neither guarantees that a client never gets more than 100 requests into some 60-second span.

The test below runs a client that starts at 12:00:59 and sends a request whenever it's allowed, checking every 100 ms. It then looks for the busiest 60-second span:

```text
*ratelimit.SlidingWindow: most requests in any 60s span = 198
*ratelimit.TokenBucket: most requests in any 60s span = 199
```

The reasons are different. The sliding window's estimate assumes the previous window's requests were evenly spread. Here they all arrived in its last second, so the estimate forgets them steadily over the next minute while they're actually still inside it. The token bucket is working as designed: a full bucket of 100, plus 100 more tokens earned over the next minute.

For ordinary traffic neither effect matters much. But if a downstream system truly falls over above 100 requests in a minute, you have two honest options: use a sliding log, which is exact, or set the limit based on the worst case rather than the average. With a token bucket, that usually means a smaller `burst`.

| | Memory per client | Boundary burst | Worst 60 s at "100/min" | Expresses burst separately |
|---|---|---|---|---|
| Fixed window | 1 counter | Yes, up to 2× | ~200 | No |
| Sliding log | 1 entry per request | No | 100 | No |
| Sliding window counter | 2 counters | No | ~200 (adversarial timing) | No |
| Token bucket | 2 numbers | No | `burst` + 100 | Yes |

## Saying no properly

A limit only helps if clients can tell they've hit it and know when to come back. Here's a middleware that keeps one token bucket per client and returns `429`:

```go
// Middleware rate-limits each caller, as identified by keyOf.
func Middleware(lim *Keyed, keyOf func(*http.Request) string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d := lim.Allow(keyOf(r), time.Now())
		if !d.Allowed {
			secs := int(math.Ceil(d.RetryAfter.Seconds()))
			if secs < 1 {
				secs = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			w.Header().Set("RateLimit", fmt.Sprintf(`"default";r=0;t=%d`, secs))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		w.Header().Set("RateLimit", fmt.Sprintf(`"default";r=%d`, d.Remaining))
		next.ServeHTTP(w, r)
	})
}
```

`Retry-After` takes either an HTTP date or a whole number of seconds ([RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)), so the wait is rounded up, never down. A client told "0" would retry immediately and be refused again.

The `RateLimit` header comes from [RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/), an **IETF Internet-Draft from the HTTPAPI working group, not an RFC yet**, so its syntax may still change. It exists because the familiar `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers mean different things on different APIs; the draft notes that the reset value is variously seconds, milliseconds, a Unix timestamp or a date. The current draft defines two fields:

- `RateLimit-Policy: "default";q=100;w=60` describes a policy: a quota (`q`) over a window in seconds (`w`).
- `RateLimit: "default";r=50;t=30` gives the current state: remaining quota (`r`) and, optionally, the seconds in which that remaining quota applies (`t`).

The draft also says that when a response has both, `Retry-After` takes precedence, and that clients must not assume a positive remaining quota guarantees the next request will succeed. If you adopt the draft now, document that you're following a draft, and treat the plain `429` plus `Retry-After` as the contract clients can rely on.

## Don't let the limiter leak memory

One bucket per client means a map that grows with every new API key or IP address. A bucket that has been idle long enough to refill completely behaves exactly like a brand-new bucket, so it's safe to delete:

```go
// Sweep forgets buckets idle long enough to have refilled completely.
// A full bucket behaves exactly like a new one, so nothing is lost.
func (k *Keyed) Sweep(now time.Time) int {
	full := time.Duration(float64(k.burst) / k.rate * float64(time.Second))
	k.mu.Lock()
	defer k.mu.Unlock()
	n := 0
	for key, e := range k.buckets {
		if now.Sub(e.lastSeen) >= full {
			delete(k.buckets, key)
			n++
		}
	}
	return n
}
```

Call it from a ticker every minute or so. For keys that come straight from the network, such as IP addresses, also think about an upper bound on the map's size, since an attacker controls how many distinct keys you see.

## More than one instance

An in-process limiter counts only the requests that reach that process. Behind a load balancer with four instances, a "100 per minute" limit is really up to 400. Sometimes that's fine, and you can divide the limit by the instance count. When it isn't, the state has to live somewhere shared.

Redis is the usual choice. The read-refill-write cycle of a token bucket has to be atomic, or two instances will both read "1 token left" and both spend it. A Lua script gives you that: Redis "guarantees the script's atomic execution", and blocks other activity while it runs ([Redis: Scripting with Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/)).

```go
// tokenBucketScript runs atomically inside Redis, using the Redis server's clock.
// KEYS[1] = bucket key; ARGV[1] = rate (tokens/second); ARGV[2] = burst.
// Returns {allowed (0/1), remaining tokens, retry-after in milliseconds}.
var tokenBucketScript = redis.NewScript(`
local rate  = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t     = redis.call('TIME')
local now   = tonumber(t[1]) + tonumber(t[2]) / 1000000

local state  = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts     = tonumber(state[2]) or now
if now > ts then
  tokens = math.min(burst, tokens + (now - ts) * rate)
  ts = now
end

local allowed, retry = 0, 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000))
return {allowed, math.floor(tokens), retry}
`)
```

A few deliberate choices in there:

- **The clock is Redis's**, via `TIME`, so instances with slightly different clocks can't hand out extra tokens. Calling `TIME` from a script is fine on modern Redis: script effects replication is the default from Redis 5.0 and the only mode from 7.0, which removes the old restrictions on non-deterministic commands in scripts.
- **The key expires once the bucket would be full again**, the same rule as `Sweep`, so idle clients cost nothing.
- **The bucket key is passed in `KEYS`**, not built inside the script. Redis requires that so scripts run correctly in a cluster.
- **Fractional tokens are stored as strings.** The bucket's state keeps its fractions by writing them with `tostring`. The reply is different: Redis converts Lua numbers in a script's reply to integers by dropping the decimal part, so the script rounds with `math.floor` itself, which makes that visible in the code.

The Go side is a thin wrapper. go-redis's `Script.Run` tries `EVALSHA` first and falls back to `EVAL` if the server doesn't have the script cached:

```go
func AllowRedis(ctx context.Context, rdb redis.Scripter, key string, rate float64, burst int) (Decision, error) {
	res, err := tokenBucketScript.Run(ctx, rdb, []string{key}, rate, burst).Int64Slice()
	if err != nil {
		return Decision{}, err
	}
	return Decision{
		Allowed:    res[0] == 1,
		Remaining:  int(res[1]),
		RetryAfter: time.Duration(res[2]) * time.Millisecond,
	}, nil
}
```

The test fires 50 concurrent calls at a bucket of 10 against a real Redis 7 server, and exactly 10 are allowed.

## Production concerns

- **Pick the key carefully.** Limit authenticated traffic by account or API key, not IP: many users can share one address, and one user can have many. Only trust `X-Forwarded-For` when it was set by your own proxy; otherwise any client can pick its own key and dodge the limit.
- **Decide what happens when Redis is down.** Failing open keeps the API up but unprotected; failing closed protects the backend and takes the API down with Redis. A common middle ground is to fall back to a local, per-instance limiter.
- **Limit before expensive work.** Check the limit before parsing large bodies or touching the database, or the limiter protects nothing.
- **Count cost, not just requests**, when requests differ wildly. A token bucket handles this naturally: an expensive call takes more tokens. `x/time/rate` has `AllowN` for exactly that.
- **Make clients cooperate.** Clients should honour `Retry-After` and back off with jitter, as described in [timeouts, retries and circuit breakers](../timeouts-retries-circuit-breakers/). In gRPC, the equivalent of `429` is `RESOURCE_EXHAUSTED`, which the [status code docs](https://github.com/grpc/grpc/blob/master/doc/statuscodes.md) describe as covering "perhaps a per-user quota".
- **A per-client limit isn't overload protection.** A thousand well-behaved clients can still overwhelm you. Pair rate limits with a global concurrency limit and load shedding, as in [backpressure with bounded channels](../backpressure-bounded-channels/).

## Checklist

- [ ] The limit states both a sustained rate and a burst size
- [ ] The algorithm matches what the downstream can survive in its worst 60 seconds, not its average
- [ ] Clients are keyed by account or API key; IPs only when there's nothing better
- [ ] Refusals return `429` with `Retry-After` in whole seconds, rounded up
- [ ] Any `RateLimit` headers are documented as following an Internet-Draft
- [ ] Idle per-client state is evicted, and the number of keys is bounded
- [ ] Shared limits update atomically, using one clock
- [ ] There's a decided behaviour for when the limit store is unavailable
- [ ] The limit is checked before expensive work

A rate limit is a promise to your backend about the worst it will see. Make sure the algorithm you pick keeps the promise you think it does.

---

**Further reading**

- [RFC 6585 §4: 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585#section-4)
- [RFC 9110 §10.2.3: Retry-After](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)
- [RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/), IETF Internet-Draft ([working group repository](https://github.com/ietf-wg-httpapi/ratelimit-headers))
- [`golang.org/x/time/rate`](https://pkg.go.dev/golang.org/x/time/rate)
- [Redis `INCR`: the rate limiter pattern](https://redis.io/docs/latest/commands/incr/)
- [Redis: Scripting with Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [gRPC status codes](https://github.com/grpc/grpc/blob/master/doc/statuscodes.md)
