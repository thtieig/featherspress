# 🪶 Featherspress

*A blog engine light as feathers. Plural, because one feather is just sad.*

Featherspress is a small, self-hosted blogging engine. Think WordPress after a
really effective diet: you write in Markdown, it serves a fast little site, and
hitting **publish** is *instant*, with none of the fifteen-second "please hold
while I regenerate the entire universe" ritual.

The engine imposes **no look of its own**. It stores your content, lets you edit
it, and serves it through a **skin**: a swappable folder of templates + CSS. The
same engine can *be* a minimalist notepad or a full-bleed magazine; you just
change the skin. Two blogs, two completely different sites, one binary.

## The assembly line

```
  WordPress backup ──▶ [converter] ──▶ Site Package ──▶ [engine + skin] ──▶ live site
   (.zip from WP)      run once/blog    one tidy box       one engine,
                                        per blog           swappable skins
```

1. **Converter** (`converter/`) turns a WordPress backup into a Site Package.
   Run it once per blog.
2. **Site Package** is a self-contained box for ONE blog: the writing, the media,
   and a small `site.json` "ID card". Nothing site-specific lives in the engine.
3. **Engine + Skins**: the engine opens a package and serves it; the skin is the
   look, and it's swappable.

## Quick start

```sh
npm install
npm start                                        # serves on http://127.0.0.1:3000
```

A bare `npm start` boots the bundled **`example-site/`** demo package, so a
fresh clone renders a working blog immediately. Visit it, then run
`npm run setup` and log in at `/admin` to add posts. Point the engine at your
own package with `SITE_PACKAGE=/path/to/your-package npm start`.

## The Site Package

One directory, everything a blog needs:

```
your-package/
  site.json               the manifest (identity + which skin + nav + home mode)
  content/
    posts/<slug>.md
    pages/<slug>.md
  media/YYYY/MM/…          served at /media/…
```

Point the engine at it with `SITE_PACKAGE=your-package`. (You can also set
`CONTENT_DIR`, `MEDIA_DIR`, and `SITE_MANIFEST` individually if your layout
differs.)

### `site.json`

```json
{
  "title":    "My Blog",
  "tagline":  "small thoughts, served fast",
  "url":      "https://blog.example.com",
  "skin":     "notepad",
  "homeMode": "feed",
  "nav": [
    { "label": "Home", "href": "/" },
    { "label": "About", "href": "/about/" }
  ]
}
```

- **`skin`**: which skin to wear (`notepad`, or your own; see below).
- **`homeMode`**: either `"feed"` (a reverse-chronological post list) or
  `"page:<slug>"` (pin a page as the home, e.g. a welcome screen).
- **`nav`**: the menu, one `{ label, href, newTab? }` entry per item.
- **`postsPath`**: URL of the all-posts listing (default `/posts/`). It's an
  overridable placeholder: create a page at that slug and your page wins.
- Optional extras a skin may read: **`author`** (single-author byline) and
  **`options`** (skin-specific, e.g. `{ "heroImage": "/media/2023/06/hero.jpg" }`).

If `site.json` is missing, the engine synthesizes one from environment variables
so it still boots.

### Content files

Each post/page is Markdown with front matter:

````markdown
---
title: My First Post
date: 2024-03-11 13:38:55
slug: my-first-post
postTags:
  - { name: Linux, slug: linux }
status: draft          # optional; anything but "draft" is published
---

Body in Markdown. Fenced code takes an optional caption:

```sh title="setup.sh"
echo hello
```
````

- Drafts (`status: draft`) 404 on the public site; preview them from the admin.
- Media is referenced as `/media/YYYY/MM/…`.
- A page with `format: html` in its front matter is served **verbatim** (its body
  is trusted HTML, not Markdown), which is handy for a bespoke pinned home page.

## Skins

A skin is a folder the engine loads by name:

```
skins/<name>/
  skin.json               metadata
  templates/*.njk         base · home · post · page · archive · notFound
  assets/                 style.css, fonts, images…  → served at /theme/assets/…
```

Templates are [Nunjucks](https://mozilla.github.io/nunjucks/). Each receives a
small, documented data object (see `src/contract.js`): always `site` +
`tagCloud` + `currentPath`; then `recentPosts`/`page` for home, `post`, `page`,
or `{ heading, posts }` for archives. Search is client-side against the engine's
`/search` JSON API.

The engine ships one skin, **`notepad`**, which is the default look: sticky
masthead, two-column layout with a search + tag-cloud sidebar, warm paper
palette, light/dark.

To make your own, copy `skins/notepad`, rename it, edit the templates/CSS, and
set `"skin": "<name>"` in `site.json`. A Site Package can also carry its own
`skins/<name>/`, which **overrides** a bundled skin of the same name, so a
site's look travels with its content and the bundled default stays the
fallback.

## Converting a WordPress blog

You need two things WordPress already keeps: a **dump of your database** (posts,
pages, tags) and a **zip of your `wp-content/uploads`** (media). No backup
plugin required. Feed them to the converter and you get a Site Package:

```sh
python3 -m venv converter/.venv && converter/.venv/bin/pip install -r converter/requirements.txt

converter/.venv/bin/python converter/wp_to_package.py \
  --db      wordpress.sql.gz \
  --uploads uploads.zip \
  --url     https://your-old-blog.com \
  --title   "Your Blog" --tagline "…" \
  --skin    notepad \
  --out     ./your-package
```

It writes a complete Site Package, copying only the media your posts reference,
then you serve it with `SITE_PACKAGE=./your-package npm start`. Tags come across
(not categories); published posts by default; the look is a skin you choose, not
your old theme.

**Full walkthrough, including how to get the dump (`mysqldump`, phpMyAdmin) and
exactly what does and doesn't migrate: [docs/MIGRATING-FROM-WORDPRESS.md](docs/MIGRATING-FROM-WORDPRESS.md).**

## Admin

`/admin` is an authenticated area to write, edit, and delete **posts and pages**
(and manage media). Site identity (nav, skin, home mode) lives in `site.json`,
not the UI. Run `npm run setup` once to create the admin login (password + TOTP).

## Configuration

All optional; sensible defaults for local dev.

| Variable | Purpose |
|---|---|
| `SITE_PACKAGE` | Path to a Site Package (derives the three below). |
| `CONTENT_DIR` / `MEDIA_DIR` | Content and media roots (override individually). |
| `SITE_MANIFEST` | Explicit path to `site.json`. |
| `SKINS_DIR` / `DEFAULT_SKIN` | Where skins live / fallback skin. |
| `PORT` / `HOST` | Bind address (default `127.0.0.1:3000`). |
| `SESSION_SECRET` | Set a real value in production. |

## Deploying

Featherspress runs as one small Node process behind a reverse proxy (Apache
templates in `deploy/`). The step-by-step guide covers the service user,
isolated Node, systemd, TLS, and backups: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## What it proudly does *not* do

No plugin marketplace. No comment spam. No forty-seven database tables. No
"upgrade to Pro to unlock the color blue." It does blogging. That is the entire
personality, and it's very comfortable with that.
