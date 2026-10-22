---
title: "Idempotency keys: how to make retries safe"
description: "A timeout doesn't tell you whether your request failed or just lost its reply. Idempotency keys let clients retry without charging a card twice. Here's how they work, with a Go implementation."
pubDate: 2026-10-23
tags: [api-design, reliability, go, http]
draft: false
---

A client sends `POST /orders`. The server creates the order, charges the card, and starts writing the response. Then the connection drops.

From the client's side, this looks exactly like a request that never arrived. It got a timeout, nothing else. So it does the reasonable thing and retries. Now the customer has two orders and two charges.

The network can't tell you the difference between *"my request was lost"* and *"my request worked, but the reply was lost"*. Retries are the only way to build reliable clients, and retries are also how you create duplicates. Idempotency keys resolve that tension.

## Some methods are already safe to retry

HTTP defines an **idempotent** method as one where sending the same request several times has the same effect on the server as sending it once ([RFC 9110, §9.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2)). `GET`, `HEAD`, `PUT` and `DELETE` are idempotent by definition. Deleting order 42 twice leaves order 42 deleted.

`POST` and `PATCH` are not. "Create an order" run twice creates two orders. Those are exactly the calls you most need to retry, because they're the ones that change things.

## The idea

The client makes up a unique key for each **logical operation**, like "place this order", and sends it with every attempt of that operation:

```http
POST /orders HTTP/1.1
Content-Type: application/json
Idempotency-Key: "8e03978e-40d5-43e8-bc93-6894a57f9324"

{"sku": "book-123", "qty": 1}
```

The server remembers which keys it has seen and what it answered. When a retry arrives with a key it knows, it doesn't run the operation again. It sends back the original response.

That's the whole trick. Most of the work is in the edge cases.

## The five cases a server has to handle

There's an IETF Internet-Draft standardising the `Idempotency-Key` header ([draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)). It isn't an RFC yet, but it's a sensible reference, and it suggests these responses:

| Situation | What to do |
|---|---|
| New key | Run the request, store the result |
| Known key, same request, finished | Return the stored response; don't run anything |
| Known key, same request, **still running** | `409 Conflict`. The client can retry later. |
| Known key, **different** request | `422 Unprocessable Content`. The client has a bug. |
| Key missing on an endpoint that requires one | `400 Bad Request` |

The "different request" case matters more than it looks. If a client reuses a key by mistake, say for a second, genuinely different order, silently replaying the first order's response would hide a real bug. So the server stores a **fingerprint** of the request, usually a hash of the method, path and body, and rejects mismatches.

The "still running" case is the one people forget. A client with an aggressive timeout can send its retry while the first attempt is still executing. Without a check, both attempts run.

## A Go implementation

Here's a working middleware using only the standard library. It keeps keys in memory, which is fine for understanding the logic. Production storage comes after.

```go
// record is what we remember about one idempotency key.
type record struct {
	fingerprint string // hash of the request, to catch key reuse with a different payload
	done        bool   // false while the first request is still running
	status      int
	header      http.Header
	body        []byte
	created     time.Time
}

type Store struct {
	mu   sync.Mutex
	data map[string]*record
	ttl  time.Duration
}

func NewStore(ttl time.Duration) *Store {
	return &Store{data: map[string]*record{}, ttl: ttl}
}

// begin reserves the key for this request. If the key is already known,
// it returns a copy of the existing record and reserved=false.
func (s *Store) begin(key, fp string) (prev record, reserved bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.data[key]; ok && time.Since(r.created) < s.ttl {
		return *r, false
	}
	s.data[key] = &record{fingerprint: fp, created: time.Now()}
	return record{}, true
}

func (s *Store) complete(key string, status int, h http.Header, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.data[key]; ok {
		r.done, r.status, r.header, r.body = true, status, h, body
	}
}

// release forgets the key so the client can retry from scratch.
func (s *Store) release(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
}
```

The important property is that `begin` checks and reserves the key **in one locked step**. If two requests with the same key arrive at the same moment, exactly one of them gets `reserved == true`.

Now the middleware:

```go
func Idempotent(store *Store, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodPatch {
			next.ServeHTTP(w, r) // GET, PUT and DELETE are already idempotent by definition
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			http.Error(w, "Idempotency-Key is missing", http.StatusBadRequest)
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "could not read body", http.StatusBadRequest)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		sum := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), body...))
		fp := hex.EncodeToString(sum[:])

		prev, reserved := store.begin(key, fp)
		if !reserved {
			switch {
			case prev.fingerprint != fp:
				http.Error(w, "Idempotency-Key was already used with a different request", http.StatusUnprocessableEntity)
			case !prev.done:
				http.Error(w, "A request with this Idempotency-Key is still in progress", http.StatusConflict)
			default:
				for k, v := range prev.header {
					w.Header()[k] = v
				}
				w.Header().Set("Idempotent-Replayed", "true")
				w.WriteHeader(prev.status)
				w.Write(prev.body)
			}
			return
		}

		// If the handler panics, free the key instead of leaving it "in progress" forever.
		defer func() {
			if p := recover(); p != nil {
				store.release(key)
				panic(p)
			}
		}()

		rec := &recorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		if rec.status >= 500 {
			store.release(key) // a server error is safe to retry
			return
		}
		store.complete(key, rec.status, w.Header().Clone(), rec.buf.Bytes())
	})
}

// recorder captures the response so it can be replayed later.
type recorder struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (r *recorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.buf.Write(b)
	return r.ResponseWriter.Write(b)
}
```

Three details are worth calling out:

- **The body is read once and put back.** We need it for the fingerprint, and the real handler still needs to read it.
- **`recorder` tees the response.** It writes to the client as normal and keeps a copy to replay later. The replayed response gets an `Idempotent-Replayed: true` header, so clients and logs can tell the two apart.
- **A crash must not leave a key stuck.** Without the `recover`, a panic would leave the key marked "in progress", and every retry would get `409` until it expired.

## Should errors be replayed too?

This middleware stores `2xx` and `4xx` responses but **forgets the key on a `5xx`**, so a retry runs the request again. The reasoning: a `5xx` usually means "something went wrong on our side, try again", and replaying it would block a retry that might succeed.

There's a catch. If the handler had already done half its work before failing, running it again could double that half. Stripe's v1 API makes the opposite choice and replays the saved response for a key, **including `500` errors** ([Stripe docs](https://docs.stripe.com/api/idempotent_requests)). Both choices are defensible. What matters is that your handler either completes fully or not at all, which brings us to storage.

## Making it production-ready

An in-memory map breaks the moment you run two instances behind a load balancer: the retry might land on the other one. Keys need shared storage.

**Postgres** works well, and it gives you the most important property for free:

```sql
CREATE TABLE idempotency_keys (
    user_id     bigint      NOT NULL,
    key         text        NOT NULL,
    fingerprint text        NOT NULL,
    status      int,                    -- NULL while the request is in progress
    response    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

-- Reserve the key. Zero rows returned means it already existed.
INSERT INTO idempotency_keys (user_id, key, fingerprint)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, key) DO NOTHING
RETURNING key;
```

The property is this: **write the business change and mark the key complete in the same database transaction.** If the order insert and the "key done" update commit together, there's no window where the order exists but the key says otherwise, even if the process dies between the two steps.

**Redis** is a common alternative for the reservation step, using `SET key value NX EX 86400`, which only sets the key if it doesn't exist and expires it after 24 hours. It's fast, but it can't share a transaction with your database, so you have to think harder about the crash cases.

A few more rules worth following:

- **Scope keys to the caller.** Notice `user_id` in the primary key. Two customers who happen to generate the same key must never see each other's responses.
- **Expire them.** Keys don't need to live forever, just longer than any client would keep retrying. Stripe, for example, may prune keys once they're at least 24 hours old. Whatever you choose, document it.
- **Don't put sensitive data in keys.** A random UUID is ideal. An email address is not.

## The client's side of the deal

None of this helps if the client generates a new key for every attempt. The key belongs to the **operation**, not the HTTP request:

```go
func newKey() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// createOrder retries safely: one key per logical operation, reused on every attempt.
func createOrder(ctx context.Context, client *http.Client, url string, payload []byte) (*http.Response, error) {
	key := newKey()
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)

		resp, err := client.Do(req)
		switch {
		case err != nil:
			lastErr = err // network error: the order may or may not exist, so retry with the same key
		case resp.StatusCode == http.StatusConflict || resp.StatusCode >= 500:
			resp.Body.Close()
			lastErr = fmt.Errorf("server returned %d", resp.StatusCode)
		default:
			return resp, nil
		}

		select {
		case <-time.After(time.Duration(100<<attempt) * time.Millisecond): // 100ms, 200ms, 400ms...
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return nil, lastErr
}
```

It generates the key once, outside the loop, and reuses it for every attempt. It retries on network errors, `409` and `5xx`, and backs off between attempts. It doesn't retry other `4xx` errors, because those mean the request itself needs fixing.

## Checklist

- [ ] Every `POST`/`PATCH` that creates or moves something accepts an `Idempotency-Key`
- [ ] The key is reserved atomically, so concurrent duplicates get `409`
- [ ] A fingerprint catches key reuse with a different payload (`422`)
- [ ] Keys are scoped per user or tenant
- [ ] The business write and "key complete" commit in one transaction
- [ ] Keys expire, and the expiry is documented
- [ ] Clients generate one key per operation and reuse it on retries

Timeouts will always be ambiguous. Idempotency keys turn "did it happen?" into a question the server can answer.

---

**Further reading**

- [The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/), IETF Internet-Draft
- [RFC 9110 §9.2.2: Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2)
- [Stripe API: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
