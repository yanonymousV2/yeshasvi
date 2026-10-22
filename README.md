# Yeshasvi — portfolio + blog

An [Astro](https://astro.build) site. Plain HTML/CSS/JS on the page, no client framework.

```sh
npm install        # once
npm run dev        # http://localhost:4321 (drafts visible)
npm run build      # static site in dist/ (drafts excluded)
npm run preview    # serve the built dist/
```

## Where things live

| Path | What |
|---|---|
| `src/data/content.ts` | **All homepage text** (hops, roles, WAF rules, timeline, services, stack, contact). Edit here. |
| `src/pages/index.astro` | Homepage ("Motion" layout): kinetic hero, pinned packet journey, bento, marquee |
| `src/styles/` | `motion.css` (homepage), `blog.css` (blog) |
| `src/content/blog/*.md` | Blog posts |
| `public/kit/kit.css`, `kit.js` | Design kit: 7 visual styles, 6 font pairings, interactive widgets, style/font toolbar |
| `public/` | Images and the `og.png` share image |
| `_legacy/` | Retired versions, kept for reference and not built: the pre-Astro HTML site, and in `_legacy/astro/` the Rail, Pipeline, Trace, Diagram and Bento layouts |

## Writing a post

Create `src/content/blog/my-post.md`:

```md
---
title: "Post title"
description: "One or two sentences shown in the list and in link previews."
pubDate: 2026-11-01
tags: [go, grpc]
draft: true    # visible in `npm run dev`, hidden from the live site
---

Your post in Markdown. Code blocks are highlighted and follow the visitor's chosen style.
```

Flip `draft` to `false` to publish. The URL is `/blog/my-post/`.

Posts follow the checklist in [`docs/blog-guide.md`](docs/blog-guide.md) and take topics from [`docs/blog-backlog.md`](docs/blog-backlog.md).

## Deployment

Pushing to `main` builds the site and publishes it to GitHub Pages via `.github/workflows/deploy.yml`.
Live at **https://yanonymousv2.github.io/yeshasvi/**.

- One-time setup: repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
- The site is configured for the `/yeshasvi` subpath (`base` in `astro.config.mjs`). All internal links go through `src/lib/url.ts`, so a custom domain later is a two-line change: set `site` to the domain and `base` to `'/'`.
- No résumé PDF is published on purpose: the site links to LinkedIn and offers the résumé on request.
