"use strict";

// The SITE MANIFEST is a blog's "ID card". It carries everything site-specific
// that used to be hardcoded in the engine: title, tagline, url, which skin to
// wear, the home mode, and the nav menu. The engine reads it once at boot; the
// active skin receives it as `site` on every render.
//
// Resolution order (first hit wins):
//   1. config.SITE_MANIFEST                     (explicit path, incl. a package's site.json)
//   2. <CONTENT_DIR>/../site.json               (sits beside content/ + media/)
//   3. synthesized from SITE_TITLE/TAGLINE/URL env  (back-compat: the live box
//      has no site.json yet, so it keeps rendering with the notepad skin)

const fs = require("fs");
const path = require("path");
const config = require("../config");

// homeMode: "feed" (a reverse-chronological post feed) or "page:<slug>" (a
// pinned page shown as the home). Nav is a list of { label, href, newTab? }.
// postsPath: the URL of the full post listing (a generic archive); a real page
// at the same slug overrides it. postsHeading: that listing's heading.
// pinnedPage (optional): a page slug shown ABOVE the feed when homeMode is
// "feed" (ignored in "page:<slug>" mode, which already replaces the whole
// home). Lets a site pin a static intro above its chronological feed.
function synthesize() {
  return {
    title: config.SITE_TITLE,
    tagline: config.SITE_TAGLINE,
    url: config.SITE_URL,
    skin: config.DEFAULT_SKIN,
    homeMode: "feed",
    postsPath: "/posts/",
    postsHeading: "All posts",
    nav: [
      { label: "Home", href: "/" },
      { label: "All posts", href: "/posts/" },
    ],
  };
}

// Canonicalize postsPath to a leading+trailing-slashed form ("/posts/"); never
// let it collapse to "/" (that would collide with the home route).
function normalizePostsPath(p) {
  let s = String(p == null ? "" : p).trim();
  if (!s) return "/posts/";
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.endsWith("/")) s += "/";
  return s === "/" ? "/posts/" : s;
}

function candidatePaths() {
  const out = [];
  if (config.SITE_MANIFEST) out.push(config.SITE_MANIFEST);
  out.push(path.join(config.CONTENT_DIR, "..", "site.json"));
  return out;
}

/** Load the manifest, filling any missing field from the synthesized defaults. */
function load() {
  const defaults = synthesize();
  for (const p of candidatePaths()) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        skin: parsed.skin || defaults.skin,
        nav: Array.isArray(parsed.nav) ? parsed.nav : defaults.nav,
        postsPath: normalizePostsPath(parsed.postsPath || defaults.postsPath),
        postsHeading: parsed.postsHeading || defaults.postsHeading,
        source: p,
      };
    } catch (e) {
      if (e.code !== "ENOENT") throw e; // a malformed site.json should be loud
    }
  }
  return { ...defaults, source: "(synthesized from env)" };
}

module.exports = { load, synthesize };
