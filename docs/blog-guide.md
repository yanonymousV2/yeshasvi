# Blog writing checklist

How each weekly backend post gets written.

## Steps

1. Take the first unchecked topic from [`blog-backlog.md`](blog-backlog.md). If none is left, pick a backend topic not already covered in `src/content/blog/` and add it to the backlog first.
2. Research from primary sources: RFCs and IETF drafts, official docs (Go, Postgres, Redis, Kubernetes…), vendor engineering docs. Check every factual claim; don't rely on memory for versions, status codes, defaults or limits. State a standard's real status (e.g. "Internet-Draft, not an RFC yet").
3. Write and **run** all code. Go code must pass `go vet` and `go test -race` in a scratch module; SQL should be valid Postgres. The code in the post must be identical to the code that was tested.
4. Save as `src/content/blog/<slug>.md` with `draft: true`, then check it renders with `npm run dev`.
5. Tick the topic in the backlog with the post's slug.

## Front matter

```md
---
title: "Plain, specific title"
description: "One or two sentences: the problem and what the reader will learn."
pubDate: YYYY-MM-DD
tags: [lowercase, kebab-case]
draft: true
---
```

## Style

- Explain a backend technique: the problem, the idea, a working implementation, production concerns, a checklist. Roughly 1,200–2,000 words.
- Plain, direct English. Lead with a concrete failure scenario, not a definition.
- Stick to general explainers. Only include real, first-hand stories.
- Don't name employers or describe internal products.
- No team-lead framing; no counts of endpoints or services owned.
- Accuracy over everything: if unsure about a claim, leave it out.
- End with a **Further reading** list linking the sources used.

## Publishing

Posts stay `draft: true` until reviewed. Flip to `false` to publish.
