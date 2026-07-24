"use strict";

// Featherspress: a single Node process serving the public blog (and /admin,
// added in Task 5) from one shared in-memory post list. Render on request,
// no build step, no cache.

const fs = require("fs");
const path = require("path");
const express = require("express");
const config = require("./config");
const posts = require("./src/posts");
const render = require("./src/render");
const search = require("./src/search");
const manifest = require("./src/manifest");
const skin = require("./src/skin");
const contract = require("./src/contract");

// Load the site manifest and mount the skin it names BEFORE routes are wired,
// because asset serving and rendering both need the active skin. These are
// synchronous (only the syntax highlighter and content read, in init(), are async).
const site = manifest.load();
contract.setSite(site);
skin.load(site.skin);

const app = express();
app.set("x-powered-by", false);
// Behind Apache's reverse proxy in production: honor X-Forwarded-Proto so
// secure session cookies work (Apache terminates TLS, forwards plain HTTP).
app.set("trust proxy", 1);

// ---- health --------------------------------------------------------------
app.get("/healthz", (req, res) => {
  res.type("text/plain").send("featherspress ok\n");
});

// ---- admin (auth-gated CRUD + media + drafts + preview) -------------------
app.use("/admin", require("./admin/router"));

// ---- favicon / icons (part of the product, served from the repo) ---------
const ICONS = {
  "/favicon.ico": "favicon.ico",
  "/icon-192.png": "icon-192.png",
  "/icon-512.png": "icon-512.png",
  "/apple-touch-icon.png": "apple-touch-icon.png",
};
for (const [route, file] of Object.entries(ICONS)) {
  app.get(route, (req, res) => {
    // First root that actually has this icon: a per-site favicon/ (what `import`
    // restores) beats the engine's bundled placeholders, and an explicit
    // FAVICON_DIR beats both. See config.FAVICON_ROOTS.
    const root = config.FAVICON_ROOTS.find((r) => fs.existsSync(path.join(r, file)));
    if (!root) return res.status(404).end();
    res.sendFile(path.join(root, file), (err) => {
      if (err) res.status(404).end();
    });
  });
}

// ---- skin assets (static; the active skin's assets/ served at /theme/assets/)
app.use(
  "/theme/assets",
  express.static(skin.assetsDir(), {
    index: false,
    redirect: false,
    fallthrough: true,
  })
);

// ---- media (static; directory listing off) -------------------------------
app.use(
  "/media",
  express.static(config.MEDIA_DIR, {
    index: false,
    redirect: false,
    fallthrough: true,
  })
);

// ---- search (JSON) -------------------------------------------------------
app.get("/search", (req, res) => {
  res.json(search.search(req.query.q));
});

// ---- home ----------------------------------------------------------------
app.get("/", (req, res) => {
  res.type("html").send(contract.home());
});

// ---- all posts (a generic archive at the manifest's postsPath) ------------
// Registered before the catch-all /:slug so it isn't shadowed. If a real page
// or post occupies the same slug, we fall through and let /:slug render it,
// so an author can override the auto-listing with a hand-written page.
{
  const postsSlug = site.postsPath.replace(/^\/|\/$/g, ""); // "/posts/" -> "posts"
  app.get([`/${postsSlug}`, `/${postsSlug}/`], (req, res, next) => {
    if (posts.bySlug(postsSlug)) return next(); // a real page/post overrides it
    res.type("html").send(contract.postsIndex(posts.publishedPosts()));
  });
}

// ---- tag archive ---------------------------------------------------------
app.get(["/tag/:slug", "/tag/:slug/"], (req, res, next) => {
  const list = posts.byTag(req.params.slug);
  if (!list.length) return next(); // unknown/empty tag → 404
  res.type("html").send(contract.tagPage(posts.tagName(req.params.slug), list));
});

// ---- post or page (drafts 404 on the public site) ------------------------
app.get(["/:slug", "/:slug/"], (req, res, next) => {
  const item = posts.bySlug(req.params.slug);
  if (!item) return next();
  if (item.status === "draft") return next(); // drafts are admin-preview only
  const bodyHtml = render.render(item);
  const html =
    item.type === "page"
      ? contract.pageView(item, bodyHtml)
      : contract.postPage(item, bodyHtml);
  res.type("html").send(html);
});

// ---- 404 -----------------------------------------------------------------
app.use((req, res) => {
  res.status(404).type("html").send(contract.notFound());
});

// ---- boot ----------------------------------------------------------------
let initialized = false;
async function init() {
  if (initialized) return;
  await render.initHighlighter();
  const counts = posts.load(config.CONTENT_DIR);
  initialized = true;
  return counts;
}
app.init = init;

if (require.main === module) {
  init().then((counts) => {
    // Bind to HOST (default 127.0.0.1): in production the engine sits behind
    // Apache's reverse proxy and must NOT be reachable directly from the
    // internet. Set HOST=0.0.0.0 only if you deliberately want that.
    app.listen(config.PORT, config.HOST, () => {
      console.log(`Featherspress listening on http://${config.HOST}:${config.PORT}`);
      console.log(`  posts=${counts.posts} pages=${counts.pages}`);
      console.log(`  CONTENT_DIR = ${config.CONTENT_DIR}`);
      console.log(`  MEDIA_DIR   = ${config.MEDIA_DIR}`);
      console.log(`  skin        = ${site.skin}  homeMode = ${site.homeMode}`);
      console.log(`  manifest    = ${site.source}`);
    });
  });
}

module.exports = app;
