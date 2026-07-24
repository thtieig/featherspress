"use strict";

// docs/DEPLOY.md wires a production box with explicit CONTENT_DIR / MEDIA_DIR
// (not SITE_PACKAGE) and documents /var/lib/featherspress/skins/ as the home of
// "your per-site custom skin(s)". `import` writes a package's custom skin there.
// The runtime must therefore find it there too — otherwise a restored site with
// a custom skin cannot boot. Runs in its own process (node --test isolates files).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "fp-datadir-"));
fs.mkdirSync(path.join(DATA, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(DATA, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(DATA, "media"), { recursive: true });
// The custom skin sits beside content/, exactly where `import` puts it.
fs.mkdirSync(path.join(DATA, "skins", "gvm", "templates"), { recursive: true });
fs.writeFileSync(
  path.join(DATA, "skins", "gvm", "templates", "home.njk"),
  "<!doctype html><html><body>DATADIR-SKIN-MARKER::{{ site.title }}</body></html>"
);
fs.writeFileSync(
  path.join(DATA, "site.json"),
  JSON.stringify({ title: "Restored", skin: "gvm", homeMode: "feed", nav: [] })
);

// The production wiring: explicit dirs, no SITE_PACKAGE.
delete process.env.SITE_PACKAGE;
process.env.CONTENT_DIR = path.join(DATA, "content");
process.env.MEDIA_DIR = path.join(DATA, "media");
delete process.env.SITE_MANIFEST;
delete process.env.SITE_SKINS_DIR;

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
test.after(() => {
  if (server) server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test("a custom skin in the data dir (beside content/) is found without SITE_PACKAGE", async () => {
  const r = await get("/");
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /DATADIR-SKIN-MARKER::Restored/);
});
