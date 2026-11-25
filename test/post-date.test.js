"use strict";

// Post date/time editing (create/update). Drives the actual admin HTTP API
// end-to-end, isolated content/media/auth dirs, same pattern as admin.test.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-post-date-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";

const PASSWORD = "testpassword123";
const RECOVERY = "abcd-1234";
fs.writeFileSync(
  process.env.AUTH_CONFIG,
  JSON.stringify({
    passwordHash: bcrypt.hashSync(PASSWORD, 8),
    totpSecret: "JBSWY3DPEHPK3PXP",
    recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
  })
);

const app = require("../server");

let base;
let server;
let cookie = "";

async function api(method, p, body) {
  const headers = Object.assign({}, cookie ? { cookie } : {});
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
}

test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  assert.strictEqual(res.status, 200, await res.text());
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("create with explicit date persists it", async () => {
  const res = await api("POST", "/admin/api/post", {
    title: "Backdated Post",
    tags: "",
    body: "Body.",
    type: "post",
    date: "2020-01-15T10:30:00.000Z",
  });
  const data = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(data));

  const got = await (await api("GET", "/admin/api/post/post/" + data.slug)).json();
  assert.strictEqual(got.date, "2020-01-15T10:30:00.000Z");
});

test("create with no date defaults to ~now", async () => {
  const before = Date.now();
  const res = await api("POST", "/admin/api/post", {
    title: "Undated Post",
    tags: "",
    body: "Body.",
    type: "post",
  });
  const data = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(data));

  const got = await (await api("GET", "/admin/api/post/post/" + data.slug)).json();
  const gotMs = new Date(got.date).getTime();
  assert.ok(gotMs >= before && gotMs <= Date.now() + 5000, `expected ~now, got ${got.date}`);
});

test("update with date changes it", async () => {
  const create = await (
    await api("POST", "/admin/api/post", { title: "To Be Redated", tags: "", body: "Body.", type: "post" })
  ).json();

  const put = await api("PUT", "/admin/api/post/post/" + create.slug, {
    title: "To Be Redated",
    tags: "",
    body: "Body.",
    date: "2019-06-01T00:00:00.000Z",
  });
  assert.strictEqual(put.status, 200, await put.text());

  const got = await (await api("GET", "/admin/api/post/post/" + create.slug)).json();
  assert.strictEqual(got.date, "2019-06-01T00:00:00.000Z");
});

test("update without date preserves the original", async () => {
  const create = await (
    await api("POST", "/admin/api/post", {
      title: "Keep My Date",
      tags: "",
      body: "Body.",
      type: "post",
      date: "2018-03-03T03:03:03.000Z",
    })
  ).json();

  const put = await api("PUT", "/admin/api/post/post/" + create.slug, {
    title: "Keep My Date Edited",
    tags: "",
    body: "Edited body.",
  });
  assert.strictEqual(put.status, 200, await put.text());

  const got = await (await api("GET", "/admin/api/post/post/" + create.slug)).json();
  assert.strictEqual(got.date, "2018-03-03T03:03:03.000Z");
});

// Investigation note (see task-2-report.md for detail): real bulk-imported
// legacy dates (bare, space-separated, e.g. "2016-10-14 11:53:07") are valid
// YAML 1.1 timestamps -- gray-matter/js-yaml parses them into a real Date,
// so they round-trip fine and are NOT the unparseable case. A genuinely
// unparseable string (never produced by this app, but not impossible in
// hand-edited or corrupted frontmatter) is what exercises the "leave it
// alone" code path, so this test writes one directly to disk.
test("update on a post with an already-unparseable date, saved without touching the field, leaves it byte-for-byte unchanged", async () => {
  const slug = "unparseable-date-post";
  const filePath = path.join(TMP, "content", "posts", `${slug}.md`);
  fs.writeFileSync(
    filePath,
    ["---", "title: Weird Date Post", "date: not-a-real-date", `slug: ${slug}`, "---", "Original body.", ""].join(
      "\n"
    )
  );

  const put = await api("PUT", "/admin/api/post/post/" + slug, {
    title: "Weird Date Post Edited",
    tags: "",
    body: "Edited body.",
  });
  assert.strictEqual(put.status, 200, await put.text());

  const onDisk = fs.readFileSync(filePath, "utf8");
  assert.match(onDisk, /^date: not-a-real-date$/m, onDisk);
});

test("invalid date string on create -> 400, nothing written to disk", async () => {
  const before = fs.readdirSync(path.join(TMP, "content", "posts"));
  const res = await api("POST", "/admin/api/post", {
    title: "Should Not Be Created",
    tags: "",
    body: "Body.",
    type: "post",
    date: "not-a-date-at-all",
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /date/i);

  const after = fs.readdirSync(path.join(TMP, "content", "posts"));
  assert.deepStrictEqual(after.sort(), before.sort());
});

test("invalid date string on update -> 400, nothing written to disk", async () => {
  const create = await (
    await api("POST", "/admin/api/post", { title: "Update Invalid Date Target", tags: "", body: "Body.", type: "post" })
  ).json();
  const filePath = path.join(TMP, "content", "posts", `${create.slug}.md`);
  const before = fs.readFileSync(filePath, "utf8");

  const res = await api("PUT", "/admin/api/post/post/" + create.slug, {
    title: "Update Invalid Date Target",
    tags: "",
    body: "Body.",
    date: "not-a-date-at-all",
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /date/i);

  const after = fs.readFileSync(filePath, "utf8");
  assert.strictEqual(after, before);
});
