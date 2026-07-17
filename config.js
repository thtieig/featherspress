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

module.exports = config;
