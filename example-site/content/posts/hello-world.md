---
title: Hello, world
date: 2024-01-15 10:00:00
slug: hello-world
postTags:
  - name: getting-started
    slug: getting-started
---

Welcome to **Featherspress**, a small, self-hosted blog engine. You are looking
at the bundled `example-site/` package: a complete, minimal Site Package the
engine serves out of the box so a fresh install just works.

## Writing

Posts and pages are Markdown files with a little front matter (see the top of
this file). Hitting **publish** in the admin is instant: the engine just writes
the `.md` and re-reads it; there is no build step.

Fenced code blocks are syntax-highlighted and take an optional caption:

```sh title="hello.sh"
echo "hello from Featherspress"
```

Angle-bracket placeholders in prose survive exactly as written, so set the
`<hostname>` and `<your-ip>` values before you run anything.

## Media

Images live under `/media/` and are referenced with a normal Markdown image:

![A sample placeholder image](/media/2024/01/sample.png)

## Make it yours

Copy `example-site/` somewhere, edit `site.json` (title, tagline, nav, which
skin to wear), replace this content, and point the engine at it with
`SITE_PACKAGE=/path/to/your-package npm start`. Migrating from WordPress? See
`docs/MIGRATING-FROM-WORDPRESS.md`.
