"use strict";

const path = require("node:path");
// Point the engine at the fixtures BEFORE requiring config/server.
const FIXTURES = path.join(__dirname, "fixtures");
process.env.CONTENT_DIR = FIXTURES;
process.env.MEDIA_DIR = path.join(FIXTURES, "media");

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
        res.on("end", () => resolve({ status: res.statusCode, body, type: res.headers["content-type"] }));
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

test("home 200 in feed mode (no manifest → synthesized default)", async () => {
  const r = await get("/");
  assert.strictEqual(r.status, 200);
  // Feed mode lists published posts newest-first.
  assert.match(r.body, /Beta Post/);
  assert.match(r.body, /Alpha Post/);
  assert.ok(!r.body.includes("Gamma Draft")); // drafts excluded from the feed
  assert.match(r.body, /tag-cloud/); // sidebar rendered
});

test("skin assets are linked and served", async () => {
  const r = await get("/");
  assert.match(r.body, /<link rel="stylesheet" href="\/theme\/assets\/style\.css">/);
  const css = await get("/theme/assets/style.css");
  assert.strictEqual(css.status, 200);
  assert.match(css.type, /text\/css/);
  assert.match(css.body, /\.masthead/);
});

test("post 200 with title in <title> and <h1>", async () => {
  const r = await get("/alpha-post/");
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /<title>Alpha Post · Featherspress<\/title>/);
  assert.match(r.body, /<h1>Alpha Post<\/h1>/);
  assert.match(r.body, /<code>inline code<\/code>/);
});

test("post works without trailing slash too", async () => {
  const r = await get("/alpha-post");
  assert.strictEqual(r.status, 200);
});

test("draft 404 on public URL", async () => {
  const r = await get("/gamma-draft/");
  assert.strictEqual(r.status, 404);
});

test("posts index (/posts/) lists published posts newest-first, excludes drafts", async () => {
  const r = await get("/posts/");
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Beta Post/);
  assert.match(r.body, /Alpha Post/);
  assert.match(r.body, /Delta Legacy Status/);
  assert.ok(!r.body.includes("Gamma Draft"));
  // newest-first: Beta (2022) appears before Alpha (2020)
  assert.ok(r.body.indexOf("Beta Post") < r.body.indexOf("Alpha Post"));
});

test("tag archive lists tagged published posts", async () => {
  const r = await get("/tag/linux/");
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Tag: linux/);
  assert.match(r.body, /Beta Post/);
  assert.match(r.body, /Alpha Post/);
});

test("tag with only draft posts 404s", async () => {
  const r = await get("/tag/secret/");
  assert.strictEqual(r.status, 404);
});

test("page renders", async () => {
  const r = await get("/about/");
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /<h1>About<\/h1>/);
});

test("unknown slug 404s with the notFound page", async () => {
  const r = await get("/does-not-exist/");
  assert.strictEqual(r.status, 404);
  assert.match(r.body, /flew the coop/);
});

test("search returns JSON results", async () => {
  const r = await get("/search?q=beta");
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /application\/json/);
  const items = JSON.parse(r.body);
  assert.ok(items.length >= 1);
  assert.strictEqual(items[0].url, "/beta-post/");
  assert.match(items[0].excerpt, /<mark>/i);
});

test("search excludes drafts", async () => {
  const r = await get("/search?q=draft"); // gamma-draft body contains 'draft'
  const items = JSON.parse(r.body);
  assert.ok(!items.some((i) => i.url === "/gamma-draft/"));
});

test("empty search returns empty array", async () => {
  const r = await get("/search?q=");
  assert.deepStrictEqual(JSON.parse(r.body), []);
});

test("media served, directory listing off", async () => {
  const file = await get("/media/2020/01/pixel.txt");
  assert.strictEqual(file.status, 200);
  assert.strictEqual(file.body, "hello-media");
  const dir = await get("/media/2020/01/");
  assert.strictEqual(dir.status, 404); // no directory listing
});

test("favicon served", async () => {
  const r = await get("/favicon.ico");
  assert.strictEqual(r.status, 200);
});
