"use strict";

// A Site Package can ship its own skins/<name>/ that OVERRIDES a bundled skin of
// the same name, while the bundled skins remain the fallback. Here a package
// provides its own "notepad" skin; the engine must render through it, not the
// bundled one. Runs in its own process (node --test isolates files).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PKG = fs.mkdtempSync(path.join(os.tmpdir(), "fp-skinovr-"));
fs.mkdirSync(path.join(PKG, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(PKG, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(PKG, "media"), { recursive: true });
fs.mkdirSync(path.join(PKG, "skins", "notepad", "templates"), { recursive: true });
// A self-contained home template with a marker unique to the package skin.
fs.writeFileSync(
  path.join(PKG, "skins", "notepad", "templates", "home.njk"),
  "<!doctype html><html><body>PACKAGE-SKIN-MARKER::{{ site.title }}</body></html>"
);
fs.writeFileSync(
  path.join(PKG, "site.json"),
  JSON.stringify({ title: "Overridden", skin: "notepad", homeMode: "feed", nav: [] })
);
process.env.SITE_PACKAGE = PKG;
// Clear any per-dir overrides a sibling test file might have set in this env.
delete process.env.CONTENT_DIR;
delete process.env.MEDIA_DIR;
delete process.env.SITE_MANIFEST;

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
  fs.rmSync(PKG, { recursive: true, force: true });
});

test("a package's skins/<name>/ overrides the bundled skin of the same name", async () => {
  const r = await get("/");
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /PACKAGE-SKIN-MARKER::Overridden/);
  // The bundled notepad's masthead markup must NOT be present.
  assert.ok(!r.body.includes("masthead"), "bundled skin rendered instead of the package override");
});
