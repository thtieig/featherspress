"use strict";

// The SKIN RUNTIME. A skin is a folder the engine wears:
//
//   skins/<name>/
//     skin.json          { name, templates?, assets? }  (metadata; all optional)
//     templates/*.njk    one per page kind: base, home, post, page, archive, notFound
//     assets/…           style.css, images, fonts…  → served at /theme/assets/…
//
// The engine's ONLY contract with a skin is: "here is a data object, give me an
// HTML string." Everything visual (CSS, markup, layout) lives in the skin;
// the engine ships zero site chrome of its own. Skins are authored in Nunjucks
// (HTML-first, closest to hand-crafting a theme), but that is a skin-internal
// detail: the engine just asks for a rendered page kind by name.

const fs = require("fs");
const path = require("path");
const nunjucks = require("nunjucks");
const config = require("./../config");

let active = null; // { name, dir, templatesDir, assetsDir, env, meta }

function formatDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Long form, e.g. "30 July 2023" (used by skins that mirror a WP theme).
function formatDateLong(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ISO 8601 for <time datetime="…">.
function isoDate(date) {
  return date instanceof Date && !isNaN(date.getTime()) ? date.toISOString() : "";
}

// Ordered skin roots, first match wins: a Site Package may ship its own
// skins/<name>/ that overrides a bundled one by name, while the bundled skins
// (SKINS_DIR) remain the fallback. "Custom takes priority, default stays."
function skinRoots() {
  const roots = [];
  if (config.SITE_SKINS_DIR) roots.push(config.SITE_SKINS_DIR);
  roots.push(config.SKINS_DIR);
  return roots;
}

/** Resolve, load, and compile a skin. Call once at boot with the manifest skin. */
function load(skinName) {
  const name = skinName || config.DEFAULT_SKIN;
  let dir = null;
  for (const root of skinRoots()) {
    if (fs.existsSync(path.join(root, name, "templates"))) {
      dir = path.join(root, name);
      break;
    }
  }
  if (!dir) {
    const looked = skinRoots()
      .map((r) => path.join(r, name))
      .join(", ");
    throw new Error(
      `Skin "${name}" not found (looked in: ${looked}). ` +
        `Check the manifest's "skin", SITE_PACKAGE/skins, and SKINS_DIR.`
    );
  }
  const templatesDir = path.join(dir, "templates");

  let meta = { name };
  try {
    meta = { ...meta, ...JSON.parse(fs.readFileSync(path.join(dir, "skin.json"), "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  // autoescape ON: templates opt specific values into raw HTML with `| safe`
  // (only the server-rendered post/page bodyHtml, which is trusted).
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(templatesDir), {
    autoescape: true,
    throwOnUndefined: false,
  });
  env.addFilter("date", formatDate);
  env.addFilter("longdate", formatDateLong);
  env.addFilter("isodate", isoDate);

  active = {
    name,
    dir,
    templatesDir,
    assetsDir: path.join(dir, "assets"),
    env,
    meta,
  };
  return active;
}

function current() {
  if (!active) throw new Error("skin.load() must run before rendering");
  return active;
}

/** Render a page kind (e.g. "home", "post") to an HTML string. */
function render(kind, context) {
  return current().env.render(`${kind}.njk`, context);
}

/** Absolute path to the active skin's assets/ dir (served at /theme/assets/). */
function assetsDir() {
  return current().assetsDir;
}

module.exports = { load, render, current, assetsDir, formatDate };
