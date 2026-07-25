"use strict";

// Drives the auth-gated admin API end-to-end using the one-time recovery-code
// login path (no TOTP clock needed). Everything runs against isolated temp
// dirs so dev content is never touched.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

// Isolated content/media/auth: set BEFORE requiring config/server.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-admin-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");

const PASSWORD = "testpassword123";
const RECOVERY = "abcd-1234";
// A second, independent code so the SameSite cookie test below does not
// consume the recovery code the login-flow tests rely on (which would make
// the suite order-dependent).
const RECOVERY2 = "efgh-5678";
fs.writeFileSync(
  process.env.AUTH_CONFIG,
  JSON.stringify({
    passwordHash: bcrypt.hashSync(PASSWORD, 8),
    totpSecret: "JBSWY3DPEHPK3PXP",
    recoveryCodeHashes: [
      crypto.createHash("sha256").update(RECOVERY).digest("hex"),
      crypto.createHash("sha256").update(RECOVERY2).digest("hex"),
    ],
  })
);

const app = require("../server");

// 1x1 PNG so file-type validates it.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

let base;
let server;
let cookie = "";

async function api(method, p, body, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, cookie ? { cookie } : {});
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
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
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("unauthenticated API is 401", async () => {
  const res = await api("GET", "/admin/api/posts");
  assert.strictEqual(res.status, 401);
});

test("login with password + recovery code succeeds", async () => {
  const res = await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  assert.strictEqual(res.status, 200, await res.text());
  assert.ok(cookie.includes("connect.sid"));
});

test("the session cookie declares SameSite", async () => {
  const res = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, code: RECOVERY2 }),
  });
  const set = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).join(";");
  assert.match(set, /SameSite=Strict/i);
});

test("wrong password is rejected", async () => {
  // use a throwaway cookie jar
  const res = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nope", code: "000000" }),
  });
  assert.strictEqual(res.status, 401);
});

test("create post -> live + searchable", async () => {
  const res = await api("POST", "/admin/api/post", {
    title: "Hello Admin World",
    tags: "alpha, beta",
    body: "This is the **first** post created via the admin API.",
    type: "post",
  });
  const data = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(data));
  assert.strictEqual(data.slug, "hello-admin-world");
  assert.strictEqual(data.status, "published");

  // Public page live immediately (no build):
  const page = await fetch(base + "/hello-admin-world/");
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /<h1>Hello Admin World<\/h1>/);

  // Searchable:
  const search = await (await fetch(base + "/search?q=first%20post")).json();
  assert.ok(search.some((r) => r.url === "/hello-admin-world/"));
});

test("edit post updates content", async () => {
  const res = await api("PUT", "/admin/api/post/post/hello-admin-world", {
    title: "Hello Admin World",
    tags: "alpha",
    body: "Edited body with a new UNIQUEWORD marker.",
  });
  assert.strictEqual(res.status, 200, await res.text());
  const page = await (await fetch(base + "/hello-admin-world/")).text();
  assert.match(page, /UNIQUEWORD/);
  const search = await (await fetch(base + "/search?q=UNIQUEWORD")).json();
  assert.ok(search.some((r) => r.url === "/hello-admin-world/"));
});

test("draft: 404 on public, 200 on authed preview", async () => {
  const res = await api("POST", "/admin/api/post", {
    title: "Secret Draft",
    tags: "hidden",
    body: "Not for the public yet.",
    type: "post",
    status: "draft",
  });
  assert.strictEqual((await res.json()).status, "draft");

  const pub = await fetch(base + "/secret-draft/");
  assert.strictEqual(pub.status, 404);

  const preview = await api("GET", "/admin/preview/post/secret-draft");
  assert.strictEqual(preview.status, 200);
  assert.match(await preview.text(), /<h1>Secret Draft<\/h1>/);

  // Not in the public tag cloud / lists either:
  const tag = await fetch(base + "/tag/hidden/");
  assert.strictEqual(tag.status, 404);
});

test("publish toggle makes a draft live", async () => {
  const res = await api("POST", "/admin/api/post/post/secret-draft/status", { status: "published" });
  assert.strictEqual((await res.json()).status, "published");
  const pub = await fetch(base + "/secret-draft/");
  assert.strictEqual(pub.status, 200);
});

test("upload + orphan cleanup on delete", async () => {
  // Upload an image.
  const form = new FormData();
  form.append("file", new Blob([PNG_1x1], { type: "image/png" }), "shot.png");
  const up = await api("POST", "/admin/api/upload", form);
  const upData = await up.json();
  assert.strictEqual(up.status, 200, JSON.stringify(upData));
  const mediaUrl = upData.url;
  assert.match(mediaUrl, /^\/media\/\d{4}\/\d{2}\/shot\.png$/);

  // It resolves publicly.
  assert.strictEqual((await fetch(base + mediaUrl)).status, 200);

  // Create a post that references it.
  await api("POST", "/admin/api/post", {
    title: "Post With Image",
    tags: "",
    body: `Here is an image: ![shot](${mediaUrl})`,
    type: "post",
  });

  // It's now a true orphan of that post.
  const orphans = await (await api("GET", "/admin/api/post/post/post-with-image/orphans")).json();
  assert.ok(orphans.orphans.includes(mediaUrl));

  // Delete the post with orphan cleanup.
  const del = await api("DELETE", "/admin/api/post/post/post-with-image", { deleteOrphans: true });
  const delData = await del.json();
  assert.ok(delData.deletedAttachments.includes(mediaUrl));

  // Post gone from public, media file gone.
  assert.strictEqual((await fetch(base + "/post-with-image/")).status, 404);
  assert.strictEqual((await fetch(base + mediaUrl)).status, 404);
});

test("media list reflects state; in-use delete is guarded", async () => {
  // Upload and reference a file, then try to delete it without force.
  const form = new FormData();
  form.append("file", new Blob([PNG_1x1], { type: "image/png" }), "keep.png");
  const up = await api("POST", "/admin/api/upload", form);
  const url = (await up.json()).url;
  await api("POST", "/admin/api/post", {
    title: "Uses Keep",
    tags: "",
    body: `![keep](${url})`,
    type: "post",
  });

  const list = await (await api("GET", "/admin/api/media")).json();
  const entry = list.find((f) => f.path === url);
  assert.ok(entry, "uploaded file listed");
  assert.strictEqual(entry.usage.length, 1);

  // In-use delete without force -> 409.
  const guarded = await api("DELETE", "/admin/api/media", { path: url });
  assert.strictEqual(guarded.status, 409);
  // Still present.
  assert.strictEqual((await fetch(base + url)).status, 200);
  // Force delete works.
  const forced = await api("DELETE", "/admin/api/media", { path: url, force: true });
  assert.strictEqual(forced.status, 200);
});

test("re-typing an existing tag reuses its canonical slug (no near-dup)", async () => {
  // Seed a post whose 'linux' tag carries a WordPress-artifact slug 'linux-2'.
  fs.writeFileSync(
    path.join(TMP, "content", "posts", "seed-linux.md"),
    "---\ntitle: Seed Linux\ndate: 2020-01-01\nslug: seed-linux\npostTags:\n  - name: linux\n    slug: linux-2\n---\n\nbody\n"
  );
  // Create a new post typing the plain name "linux".
  const res = await api("POST", "/admin/api/post", {
    title: "Another Linux Post",
    tags: "linux",
    body: "x",
    type: "post",
  });
  assert.strictEqual(res.status, 200, await res.text());
  // It must reattach to the existing tag's slug, not mint a fresh 'linux'.
  const got = await (await api("GET", "/admin/api/post/post/another-linux-post")).json();
  assert.deepStrictEqual(got.postTags, [{ name: "linux", slug: "linux-2" }]);

  // And the tag audit reports no near-duplicates.
  const audit = await (await api("GET", "/admin/api/tag-audit")).json();
  assert.strictEqual(audit.nearDuplicates.length, 0);
});

test("duplicate slug is rejected", async () => {
  const res = await api("POST", "/admin/api/post", {
    title: "Hello Admin World",
    tags: "",
    body: "dup",
    type: "post",
  });
  assert.strictEqual(res.status, 409);
});

// Regression: the body is Markdown, not HTML, so it must be stored verbatim.
// Previously it was run through sanitizeHtml(discard), which deleted any
// <word> placeholder prose on every save (data loss).
test("angle-bracket placeholder text survives a save round-trip", async () => {
  const body = "Set the <hostname> and <your-ip> before running the script.";
  const res = await api("POST", "/admin/api/post", {
    title: "Placeholder Prose",
    tags: "",
    body,
    type: "post",
  });
  assert.strictEqual(res.status, 200, await res.text());
  const got = await (await api("GET", "/admin/api/post/post/placeholder-prose")).json();
  assert.ok(got.body.includes("<hostname>"), `stored body lost placeholders: ${got.body}`);
  assert.ok(got.body.includes("<your-ip>"));
  // And it renders as visible (escaped) text on the public page, not stripped.
  const page = await (await fetch(base + "/placeholder-prose/")).text();
  assert.match(page, /&lt;hostname&gt;/);
});

// Regression: admin listing was sorted by String(Date), i.e. by weekday name.
// A 2023 post must list before a 2017 post regardless of weekday.
test("admin listing is chronological, not weekday-alphabetical", async () => {
  fs.writeFileSync(
    path.join(TMP, "content", "posts", "old-2017.md"),
    "---\ntitle: Old 2017\ndate: 2017-02-16 16:16:19\nslug: old-2017\n---\n\nbody\n"
  );
  fs.writeFileSync(
    path.join(TMP, "content", "posts", "new-2023.md"),
    "---\ntitle: New 2023\ndate: 2023-07-15 09:00:00\nslug: new-2023\n---\n\nbody\n"
  );
  const list = await (await api("GET", "/admin/api/posts")).json();
  const iOld = list.findIndex((p) => p.slug === "old-2017");
  const iNew = list.findIndex((p) => p.slug === "new-2023");
  assert.ok(iOld !== -1 && iNew !== -1, "both seeded posts listed");
  assert.ok(iNew < iOld, "2023 must sort before 2017");
});

// Regression: a title of only non-ASCII/symbol chars slugified to "" → an
// unreachable ".md". It must get a usable, reachable fallback slug.
test("non-ASCII title gets a usable fallback slug", async () => {
  const res = await api("POST", "/admin/api/post", {
    title: "你好世界",
    tags: "",
    body: "hi",
    type: "post",
  });
  const data = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(data));
  assert.ok(data.slug && data.slug.length > 0, `empty slug: ${JSON.stringify(data)}`);
  const page = await fetch(base + data.url);
  assert.strictEqual(page.status, 200, `fallback slug not reachable at ${data.url}`);
});

// Regression: PUT with a JSON null title called null.trim() → 500.
test("PUT with a null title does not crash (keeps existing title)", async () => {
  const res = await api("PUT", "/admin/api/post/post/hello-admin-world", {
    title: null,
    body: "Body edited while title omitted.",
  });
  assert.strictEqual(res.status, 200, await res.text());
  const got = await (await api("GET", "/admin/api/post/post/hello-admin-world")).json();
  assert.strictEqual(got.title, "Hello Admin World");
});

// ---- backup admin API ----------------------------------------------------
// These run after the login test above, so `cookie` is an authed session.

test("backup-status: unconfigured returns configured:false", async () => {
  const res = await api("GET", "/admin/api/backup-status");
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.strictEqual(j.configured, false);
});

test("backup-config writes an apply request with the posted fields", async () => {
  const res = await api("POST", "/admin/api/backup-config", {
    destination: { type: "local", localDir: "/var/backups/featherspress" },
    keepLast: 7,
    schedule: { preset: "daily", timeOfDay: "01:00" },
  });
  const j = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(j));
  assert.ok(Number.isInteger(j.requestId));
  const reqFile = require("../config").BACKUP_REQUEST_FILE;
  const written = JSON.parse(fs.readFileSync(reqFile, "utf8"));
  assert.strictEqual(written.action, "apply");
  assert.strictEqual(written.keepLast, 7);
  assert.strictEqual(written.requestId, j.requestId);
});

// Regression: backup-config previously dropped the `sections` field on the
// floor when writing backup-request.json, so the /admin scope checkboxes
// were silently ignored and the root agent always applied all five sections.
test("backup-config forwards the posted sections into the request file", async () => {
  const res = await api("POST", "/admin/api/backup-config", {
    destination: { type: "local", localDir: "/var/backups/featherspress" },
    keepLast: 7,
    schedule: { preset: "daily", timeOfDay: "01:00" },
    sections: ["content", "media"],
  });
  const j = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(j));
  const written = JSON.parse(fs.readFileSync(require("../config").BACKUP_REQUEST_FILE, "utf8"));
  assert.deepStrictEqual(written.sections, ["content", "media"]);
});

test("backup-run writes a run-now request", async () => {
  const res = await api("POST", "/admin/api/backup-run", {});
  assert.strictEqual(res.status, 200);
  const written = JSON.parse(fs.readFileSync(require("../config").BACKUP_REQUEST_FILE, "utf8"));
  assert.strictEqual(written.action, "run-now");
});

test("backup endpoints require auth", async () => {
  const res = await fetch(base + "/admin/api/backup-status");
  assert.strictEqual(res.status, 401);
});

// ---- export (Site Package download) --------------------------------------

test("export: content-only package downloads as a non-empty archive", async () => {
  const res = await api("GET", "/admin/api/export?sections=content");
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/(gzip|octet-stream)/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0, "archive body must not be empty");
});

test("export: unknown section is rejected", async () => {
  const res = await api("GET", "/admin/api/export?sections=bogus");
  assert.strictEqual(res.status, 400);
});

test("export: credentials without a configured age recipient is refused", async () => {
  const res = await api("GET", "/admin/api/export?sections=credentials");
  assert.strictEqual(res.status, 409);
  const j = await res.json();
  assert.match(j.error, /encrypt/i);
});
