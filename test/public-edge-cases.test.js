"use strict";

// Public-site edge cases from the 2026-11-27 review: frontmatter values that
// YAML turns into numbers, dates or bare strings must not take pages down;
// search must see inside code; an item whose slug is an engine route must not
// be created; a draft must not hide the posts listing.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-public-edge-"));
const POSTS = path.join(TMP, "content", "posts");
fs.mkdirSync(POSTS, { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
const post = (name, text) => fs.writeFileSync(path.join(POSTS, name), text);

post("normal.md", "---\ntitle: Normal\ndate: 2026-01-05T10:00:00Z\npostTags:\n  - name: linux\n    slug: linux\n---\n\nplain words\n");
// Unquoted: YAML makes these a number, a date and bare strings.
post("orwell.md", "---\ntitle: 1984\ndate: 2026-01-04T10:00:00Z\npostTags:\n  - {name: 2024, slug: 2024}\n  - {name: zed, slug: zed}\n---\n\nbig brother\n");
post("dated.md", "---\ntitle: 2024-01-01\ndate: 2026-01-03T10:00:00Z\n---\n\na day\n");
post("bare-tags.md", "---\ntitle: Bare Tags\ndate: 2026-01-02T10:00:00Z\npostTags: [foo, bar]\nslug: 42\n---\n\nshort tags\n");
post("code.md", "---\ntitle: Restarting\ndate: 2026-01-01T10:00:00Z\n---\n\nThen:\n\n```bash\nsystemctl restart nginx\n```\n\nand check `journalctl -xe`.\n");
post("accents.md", "---\ntitle: Accents\ndate: 2025-12-31T10:00:00Z\n---\n\nİİİİ hello world foo bar\n");

process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";
delete process.env.SITE_PACKAGE;
delete process.env.SITE_MANIFEST;

const RECOVERY = "abcd-1234";
fs.writeFileSync(process.env.AUTH_CONFIG, JSON.stringify({
  passwordHash: bcrypt.hashSync("pw", 4),
  totpSecret: "JBSWY3DPEHPK3PXP",
  recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
}));

const app = require("../server");

let base, server, cookie;
test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "pw", code: RECOVERY }),
  });
  assert.strictEqual(res.status, 200);
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, text: await res.text() };
};
const search = async (q) => JSON.parse((await get("/search?q=" + encodeURIComponent(q))).text);

test("unquoted numbers, dates and bare tags in frontmatter do not break any page", async () => {
  for (const p of ["/", "/posts/", "/tag/linux/", "/tag/zed/", "/orwell/", "/no-such-page/"]) {
    const r = await get(p);
    assert.ok(r.status === 200 || (p === "/no-such-page/" && r.status === 404), `${p} gave ${r.status}`);
  }
  assert.match((await get("/orwell/")).text, /1984/);
  assert.match((await get("/dated/")).text, /2024-01-01/);
});

test("bare tag names become real tags, and a numeric slug still has a URL", async () => {
  assert.strictEqual((await get("/tag/foo/")).status, 200);
  assert.strictEqual((await get("/tag/2024/")).status, 200);
  assert.strictEqual((await get("/42/")).status, 200);
});

test("search works with a numeric title in the posts", async () => {
  const r = await get("/search?q=zzz");
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(JSON.parse(r.text), []);
  assert.deepStrictEqual((await search("1984")).map((x) => x.url), ["/orwell/"]);
});

test("search finds words inside code blocks and inline code", async () => {
  assert.deepStrictEqual((await search("systemctl")).map((x) => x.url), ["/code/"]);
  assert.deepStrictEqual((await search("journalctl")).map((x) => x.url), ["/code/"]);
});

test("search highlights the right word after letters that change length when lowercased", async () => {
  const [hit] = await search("foo");
  assert.match(hit.excerpt, /<mark>foo<\/mark>/);
});

test("the admin will not create an item at an engine route", async () => {
  for (const title of ["Search", "Admin", "Healthz"]) {
    const res = await fetch(base + "/admin/api/post", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title, body: "x", type: "post" }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.notStrictEqual(data.slug, title.toLowerCase(), `"${title}" must not take the engine's /${title.toLowerCase()}/`);
    const page = await get(data.url);
    assert.strictEqual(page.status, 200, `${data.url} must show the new post`);
    assert.match(page.text, new RegExp(title));
  }
});

test("a draft named like the posts listing does not hide the listing", async () => {
  const res = await fetch(base + "/admin/api/post", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Posts", body: "draft", type: "page", status: "draft" }),
  });
  assert.strictEqual(res.status, 200);
  const list = await get("/posts/");
  assert.strictEqual(list.status, 200);
  assert.match(list.text, /Normal/);
});

test("the admin lists, opens and previews those hand-edited files too", async () => {
  const api = async (p) => {
    const res = await fetch(base + "/admin" + p, { headers: { cookie } });
    return { status: res.status, text: await res.text() };
  };
  for (const p of ["/api/posts", "/api/meta", "/api/tag-audit", "/api/media",
    "/api/post/post/orwell", "/api/post/post/42", "/preview/post/42"]) {
    const r = await api(p);
    assert.strictEqual(r.status, 200, `${p}: ${r.text.slice(0, 200)}`);
  }
  const opened = JSON.parse((await api("/api/post/post/42")).text);
  assert.deepStrictEqual(opened.postTags.map((t) => t.name), ["foo", "bar"]);
  assert.strictEqual(JSON.parse((await api("/api/post/post/orwell")).text).title, "1984");
});
