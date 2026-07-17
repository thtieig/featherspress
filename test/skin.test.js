"use strict";

// Verifies the v2 skin layer: a manifest with homeMode "page:<slug>" pins a
// page as the home, raw-HTML (format: html) content renders verbatim, and the
// nav menu is driven by the manifest (labels, order, newTab). Runs in its own
// process (node --test isolates each file), so it sets its own env.

const path = require("node:path");
const FIXTURES = path.join(__dirname, "fixtures");
process.env.CONTENT_DIR = FIXTURES;
process.env.MEDIA_DIR = path.join(FIXTURES, "media");
process.env.SITE_MANIFEST = path.join(__dirname, "fixtures-pagemode.json");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../server");

let server;
let base;

function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(base + p, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test("home in page mode renders the pinned page's raw HTML verbatim", async () => {
  const r = await get("/");
  assert.strictEqual(r.status, 200);
  // format: html body is served as-is (markdown renderer would have escaped the tags).
  assert.match(r.body, /<span class="hero-mark">Yes, correct\.<\/span>/);
  // Home title is the site title alone (no per-page prefix).
  assert.match(r.body, /<title>Page Mode Blog<\/title>/);
});

test("nav is driven by the manifest (labels, order, newTab)", async () => {
  const r = await get("/");
  assert.match(r.body, /<a href="\/contatti\/" target="_blank" rel="noopener">Contatti<\/a>/);
  // Home link is marked current on the home route.
  assert.match(r.body, /<a href="\/" class="current">Home<\/a>/);
});

test("manifest title/tagline drive the masthead", async () => {
  const r = await get("/");
  assert.match(r.body, /home is a pinned page/); // tagline
});
