# Moving from WordPress to Featherspress

This guide takes you from a **standard WordPress site** to a Featherspress
**Site Package** you can serve. You do not need any backup plugin, only the two
things WordPress already keeps: your files on disk and your database.

## What WordPress keeps, and where

A WordPress site is two halves:

1. **Files on disk.** Almost everything you care about lives in one folder,
   **`wp-content/`**:
   - `wp-content/uploads/` holds **your media** (images, PDFs…), usually in
     `YYYY/MM/` subfolders. *This is the part you keep.*
   - `wp-content/themes/` and `wp-content/plugins/` hold PHP code for the old
     look and features. **You do not migrate these** (Featherspress uses skins,
     not WordPress themes).
2. **The database** (MySQL/MariaDB) is where **your writing lives**, not in
   files. Posts, pages, titles, dates, tags, and categories are all rows in the
   database, not `.md` files on disk.

So the two inputs the converter needs are:

> **a zip of your `wp-content` (containing `uploads/…`)** for the media, and
> **a dump of your WordPress database** for the posts, pages, and tags.

## Step 1: Get the database dump

The dump is a `.sql` file (optionally gzipped). Any of these produces one:

- **`mysqldump`** (over SSH), the most direct way. Your database name, user, and
  password are in your site's **`wp-config.php`** (`DB_NAME`, `DB_USER`,
  `DB_PASSWORD`):

  ```sh
  mysqldump -u DB_USER -p DB_NAME > wordpress.sql
  # or gzip it:  mysqldump -u DB_USER -p DB_NAME | gzip > wordpress.sql.gz
  ```

- **phpMyAdmin** (from your hosting panel): pick your database → **Export** →
  format **SQL** → Go. You get a `.sql` download.

- **Your host's backup.** Many hosts hand you a `*-db.gz` or `.sql.gz`. That
  works directly.

The converter accepts `.sql`, `.sql.gz`, or `-db.gz`.

> **Table prefix:** WordPress tables are usually named `wp_posts`, `wp_terms`, …
> but the prefix is configurable (it's `$table_prefix` in `wp-config.php`). The
> converter **auto-detects** it; if detection ever fails, pass `--table-prefix`.

## Step 2: Get the uploads (media)

You want the `uploads/` tree. Zip it over SSH/SFTP:

```sh
cd wp-content
zip -r ~/uploads.zip uploads
```

Zipping the **whole `wp-content`** folder is fine too, since the converter finds
the `uploads/` inside it either way. Only the media your posts actually reference is
copied into the package, so it stays lean. Media is optional: skip `--uploads`
and you still get all the text (image links are rewritten, files just aren't
copied).

## Step 3: Run the converter

```sh
python3 -m venv converter/.venv
converter/.venv/bin/pip install -r converter/requirements.txt

converter/.venv/bin/python converter/wp_to_package.py \
  --db      wordpress.sql.gz \
  --uploads uploads.zip \
  --url     https://your-old-site.com \
  --title   "Your Blog" \
  --tagline "a short tagline" \
  --skin    notepad \
  --out     ./your-package
```

`--url` is your **old** WordPress site's address, which the converter uses to
turn internal links and media URLs into local ones. Useful extras:

| Flag | What it does |
|---|---|
| `--include-drafts` | Also import draft/pending/private/scheduled posts (as `status: draft`). Off by default. |
| `--home-mode page:<slug>` | Pin a page as the home instead of the post feed. |
| `--author "Name"` | A single-author byline some skins show. |
| `--table-prefix wp_` | Override table-prefix auto-detection. |
| `--wrap-underscore-words` | Wrap `snake_case` prose words in `code`. For code-heavy blogs only. |

You'll see a short report, e.g.:

```
table prefix: 'wp_'
parsed: 182 posts, 6 pages
skipped (not published): 4 draft, 1 private  (use --include-drafts to keep drafts/private)
content written; 210 media references
media copied: 208/210
```

The result is a complete **Site Package**:

```
your-package/
  site.json            manifest (title, tagline, url, skin, nav, home mode)
  content/posts/*.md   published posts (Markdown + front matter)
  content/pages/*.md   published pages
  media/YYYY/MM/…       the uploads your posts reference, served at /media/
```

Serve it:

```sh
SITE_PACKAGE=./your-package npm start   # http://127.0.0.1:3000
```

An existing `site.json` is **never overwritten**, so hand-edits survive re-runs.

## What the converter migrates

- **Posts and pages** → Markdown with front matter (title, date, slug).
- **Tags** → `postTags` in the front matter.
- **Media** → referenced uploads copied in; `…/wp-content/uploads/` URLs
  rewritten to `/media/…`.
- **Internal links** → links to your old domain (`?p=123` and pretty
  permalinks) become local `/slug/` links.
- **Code blocks** → `<pre>` blocks and common code shortcodes become fenced
  code, with the language detected where possible.

## What to expect, and what it does NOT do

- **Tags only; categories are not imported.** (Tags do the organizing;
  categories are dropped.)
- **Published posts only, by default.** Drafts, pending, private, and scheduled
  posts are skipped and *reported* in the summary; add `--include-drafts` to
  bring them in as drafts.
- **No comments.** Featherspress has no comment system.
- **No theme / look.** Your WordPress theme is not converted; you choose a
  Featherspress **skin** instead (styling is yours to pick or write).
- **No widgets, menus, or plugins.** The nav menu is set by hand in `site.json`;
  plugin features (forms, SEO boxes, sliders, related-posts, etc.) don't carry
  over.
- **No redirects.** If your permalinks change, set up redirects at your web
  server if you need them.
- **Shortcodes:** common ones are handled (`[caption]`, `[code]`/`[php]`/…);
  exotic or plugin-specific shortcodes may survive as text and need a quick
  hand-edit.
- **Gutenberg blocks** are flattened via HTML → Markdown; most content converts
  cleanly, but very layout-heavy block posts may want a look-over.

## What YOU must provide (the converter can't)

- **The look.** Pick a skin in `site.json` (`"skin": "notepad"`) or copy a skin
  folder and make your own. Your old CSS/theme does not come across.
- **The site identity.** Edit `site.json`: `title`, `tagline`, the **`nav`**
  menu, `homeMode` (a post `"feed"` or a pinned `"page:<slug>"`), and
  `postsPath` (the URL of the all-posts listing, default `/posts/`).
- **Any skin options**, e.g. a hero image for a magazine-style skin
  (`"options": { "heroImage": "/media/…" }`).
- **Hosting & DNS.** See [DEPLOY.md](DEPLOY.md).
- **Your admin login.** Run `npm run setup` to set a password + 2FA.
- **A review pass.** Skim the converted Markdown, especially code blocks and
  any posts that used unusual shortcodes or blocks.

## Post-conversion checklist

1. `SITE_PACKAGE=./your-package npm start` and click around: home, a few posts,
   `/posts/`, a `/tag/<slug>/` page, an image.
2. Edit `site.json`: title, tagline, nav, skin, home mode.
3. Spot-check code blocks and any shortcode-heavy posts.
4. `npm run setup` to create your admin login, then write/fix from `/admin`.
5. Deploy, following [DEPLOY.md](DEPLOY.md).
