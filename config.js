"use strict";

// Featherspress configuration.
//
// A real site's content and media live OUTSIDE this repo (the engine is the
// shareable product). Point at them with SITE_PACKAGE (or the individual dir
// vars). With NOTHING set, the engine falls back to the bundled `example-site/`
// package, so a fresh clone renders a working demo immediately.

const path = require("path");

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// A SITE PACKAGE is one self-contained blog: { site.json, content/, media/ }.
// Point the engine at a package with SITE_PACKAGE and content/media/manifest are
// all derived from it. Any of CONTENT_DIR / MEDIA_DIR / SITE_MANIFEST may still
// be set explicitly to override (this is how the live box is wired today, so it
// keeps working untouched).
const PKG = env("SITE_PACKAGE", "");
const pkg = (sub) => (PKG ? path.join(PKG, sub) : null);

// The bundled example package: the last-resort default so a bare `npm start`
// (no env at all) serves a working demo. A real deployment always overrides it.
const EXAMPLE = path.join(__dirname, "example-site");

const config = {
  // The package root, if the engine was pointed at one ("" = not used).
  SITE_PACKAGE: PKG,

  // Where the .md content lives. Expected subdirs: posts/ and pages/.
  CONTENT_DIR: env("CONTENT_DIR", pkg("content") || path.join(EXAMPLE, "content")),

  // Where uploaded media lives, served at /media/.
  MEDIA_DIR: env("MEDIA_DIR", pkg("media") || path.join(EXAMPLE, "media")),

  // The site manifest (identity + skin + nav + home mode). Resolved by
  // src/manifest.js; "" here means "look next to the content / synthesize".
  SITE_MANIFEST: env("SITE_MANIFEST", pkg("site.json") || ""),

  // Where skins live (they ship with the engine; they ARE the product).
  SKINS_DIR: env("SKINS_DIR", path.join(__dirname, "skins")),

  // Skin used when the manifest names none.
  DEFAULT_SKIN: env("DEFAULT_SKIN", "notepad"),

  // Static favicon/icon assets. Neutral placeholders ship with the engine;
  // override per-site by pointing this at your own icon dir.
  FAVICON_DIR: env("FAVICON_DIR", path.join(__dirname, "public", "favicon")),

  // Auth + admin.
  AUTH_CONFIG: env("AUTH_CONFIG", path.join(__dirname, "auth-config.json")),
  SESSION_SECRET: env("SESSION_SECRET", "dev-insecure-change-me"),

  PORT: parseInt(env("PORT", "3000"), 10),
  // Bind address. Defaults to 127.0.0.1: in production the engine runs behind
  // Apache's reverse proxy and must not be exposed directly.
  HOST: env("HOST", "127.0.0.1"),

  // Site chrome, used only when there is no site.json to read (the manifest is
  // synthesized from these). Neutral defaults; a real site sets its own in
  // site.json or via these env vars.
  SITE_TITLE: env("SITE_TITLE", "Featherspress"),
  SITE_TAGLINE: env("SITE_TAGLINE", ""),
  SITE_URL: env("SITE_URL", "http://localhost:3000"),
};

// The PER-SITE skins dir: where a site's own skins/<name>/ lives, overriding a
// bundled skin of the same name. With SITE_PACKAGE it is the package's skins/;
// with the explicit-dirs wiring docs/DEPLOY.md prescribes it sits beside
// content/ in the data dir — which is where `import` unpacks a package's custom
// skin, so the runtime and the importer must agree on this one path.
config.SITE_SKINS_DIR = env(
  "SITE_SKINS_DIR",
  PKG ? path.join(PKG, "skins") : path.join(config.CONTENT_DIR, "..", "skins")
);

// The PER-SITE favicon dir, resolved exactly like SITE_SKINS_DIR and for the
// same reason: `import` writes a package's favicon/ beside content/, so the
// runtime has to look there or a restored site silently serves the engine's
// placeholder icons.
config.SITE_FAVICON_DIR = env(
  "SITE_FAVICON_DIR",
  PKG ? path.join(PKG, "favicon") : path.join(config.CONTENT_DIR, "..", "favicon")
);

// Ordered favicon roots, first hit wins — "custom takes priority, default stays",
// as with skins. An explicitly-set FAVICON_DIR wins outright; then the per-site
// dir; then the engine's bundled placeholders.
const BUNDLED_FAVICON = path.join(__dirname, "public", "favicon");
config.FAVICON_ROOTS = [];
if (path.resolve(config.FAVICON_DIR) !== path.resolve(BUNDLED_FAVICON)) {
  config.FAVICON_ROOTS.push(config.FAVICON_DIR);
}
config.FAVICON_ROOTS.push(config.SITE_FAVICON_DIR, BUNDLED_FAVICON);

// Update status file: written by the root update timer (deploy/update.sh) into
// the data root, and READ (only) by the admin UI to show an "update available"
// banner. Defaults beside content/ so it lives in the writable data dir.
config.UPDATE_STATUS_FILE = env(
  "UPDATE_STATUS_FILE",
  path.join(config.CONTENT_DIR, "..", "update-status.json")
);

// Backup control files, both beside content/ in the writable data dir:
//  - REQUEST: the app WRITES a desired-config here; the root agent reads it.
//  - STATUS:  the root agent WRITES here; the app reads it (read-only) for the
//             Backups panel. Same split as UPDATE_STATUS_FILE.
config.BACKUP_REQUEST_FILE = env(
  "BACKUP_REQUEST_FILE",
  path.join(config.CONTENT_DIR, "..", "backup-request.json")
);
config.BACKUP_STATUS_FILE = env(
  "BACKUP_STATUS_FILE",
  path.join(config.CONTENT_DIR, "..", "backup-status.json")
);

module.exports = config;
