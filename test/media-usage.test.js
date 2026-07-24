"use strict";

// The media USAGE INDEX must see every place a site can reference /media/...,
// not just post/page bodies. gvm.tian.it's hero image lived in site.json
// (options.heroImage), the index never looked there, the admin Media library
// called it "Unused" -- and it was deleted. These are the regression tests for
// each source the index has to cover.
//
// Runs in its own process (node --test isolates files) against a temp Site
// Package, built BEFORE requiring the server: the manifest and skin are
// resolved at module load.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const PKG = fs.mkdtempSync(path.join(os.tmpdir(), "fp-mediause-"));
const MEDIA = path.join(PKG, "media", "2023", "06");
fs.mkdirSync(path.join(PKG, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(PKG, "content", "pages"), { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(path.join(PKG, "skins", "testskin", "templates"), { recursive: true });
fs.mkdirSync(path.join(PKG, "skins", "testskin", "assets"), { recursive: true });

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// Five files, one per reference source (plus one referenced by nothing).
const HERO = "/media/2023/06/hero.png"; // site.json options.heroImage
const SKINPIC = "/media/2023/06/skinpic.png"; // hardcoded in a skin template
const CSSPIC = "/media/2023/06/csspic.png"; // hardcoded in a skin stylesheet
const BODYPIC = "/media/2023/06/bodypic.png"; // a post body
const FMPIC = "/media/2023/06/fmpic.png"; // a page's frontmatter
const LONELY = "/media/2023/06/lonely.png"; // genuinely unused
for (const url of [HERO, SKINPIC, CSSPIC, BODYPIC, FMPIC, LONELY]) {
  fs.writeFileSync(path.join(PKG, url.replace(/^\//, "")), PNG_1x1);
}

fs.writeFileSync(
  path.join(PKG, "site.json"),
  JSON.stringify({
    title: "Usage Index",
    skin: "testskin",
    homeMode: "feed",
    nav: [],
    options: { heroImage: HERO },
  })
);
fs.writeFileSync(
  path.join(PKG, "skins", "testskin", "templates", "home.njk"),
  `<!doctype html><html><body><img src="${SKINPIC}"><ol>{% for p in recentPosts %}<li>{{ p.title }}</li>{% endfor %}</ol></body></html>`
);
fs.writeFileSync(
  path.join(PKG, "skins", "testskin", "assets", "style.css"),
  `body { background-image: url("${CSSPIC}"); }`
);
// A binary asset alongside them: the walker must not choke on it.
fs.writeFileSync(path.join(PKG, "skins", "testskin", "assets", "logo.png"), PNG_1x1);

fs.writeFileSync(
  path.join(PKG, "content", "posts", "body-post.md"),
  `---\ntitle: "Body Post"\ndate: 2023-06-01 10:00:00\nslug: body-post\n---\n\nAn image: ![shot](${BODYPIC})\n`
);
fs.writeFileSync(
  path.join(PKG, "content", "pages", "fm-page.md"),
  `---\ntitle: "Frontmatter Page"\ndate: 2023-06-02 10:00:00\nslug: fm-page\ncover: ${FMPIC}\n---\n\nNo images in this body.\n`
);

const PASSWORD = "testpassword123";
const RECOVERY = "abcd-1234";
const AUTH = path.join(PKG, "auth-config.json");
fs.writeFileSync(
  AUTH,
  JSON.stringify({
    passwordHash: bcrypt.hashSync(PASSWORD, 8),
    totpSecret: "JBSWY3DPEHPK3PXP",
    recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
  })
);

process.env.SITE_PACKAGE = PKG;
process.env.AUTH_CONFIG = AUTH;
// Clear per-dir overrides a sibling test file might have left in this env.
delete process.env.CONTENT_DIR;
delete process.env.MEDIA_DIR;
delete process.env.SITE_MANIFEST;

const test = require("node:test");
const assert = require("node:assert");
const app = require("../server");

let base;
let server;
let cookie = "";

async function api(method, p, body) {
  const headers = cookie ? { cookie } : {};
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

async function mediaList() {
  const res = await api("GET", "/admin/api/media");
  const text = await res.text(); // read once: it doubles as the failure message
  assert.strictEqual(res.status, 200, text);
  return JSON.parse(text);
}

function entryFor(list, url) {
  const hit = list.find((f) => f.path === url);
  assert.ok(hit, `${url} listed`);
  return hit;
}

test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  assert.strictEqual(login.status, 200, await login.text());
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(PKG, { recursive: true, force: true });
});

test("a file referenced only by site.json counts as used", async () => {
  const hero = entryFor(await mediaList(), HERO);
  assert.deepStrictEqual(
    hero.usage.map((u) => u.type),
    ["site"]
  );
  assert.ok(hero.usage[0].title, "the site ref carries a human-readable title");
});

test("deleting a site.json-referenced file is guarded (the gvm.tian.it bug)", async () => {
  const guarded = await api("DELETE", "/admin/api/media", { path: HERO });
  assert.strictEqual(guarded.status, 409, "in-use file must not delete without force");
  assert.strictEqual((await fetch(base + HERO)).status, 200, "still on disk");
});

test("a file referenced only by the active skin counts as used", async () => {
  const list = await mediaList();
  assert.deepStrictEqual(
    entryFor(list, SKINPIC).usage.map((u) => u.type),
    ["skin"],
    "hardcoded in a skin template"
  );
  assert.deepStrictEqual(
    entryFor(list, CSSPIC).usage.map((u) => u.type),
    ["skin"],
    "hardcoded in a skin stylesheet"
  );
});

test("a file referenced only by frontmatter counts as used", async () => {
  const fm = entryFor(await mediaList(), FMPIC);
  assert.deepStrictEqual(
    fm.usage.map((u) => ({ type: u.type, slug: u.slug })),
    [{ type: "page", slug: "fm-page" }]
  );
});

test("a file referenced by a post body still counts as used", async () => {
  const body = entryFor(await mediaList(), BODYPIC);
  assert.deepStrictEqual(
    body.usage.map((u) => ({ type: u.type, slug: u.slug })),
    [{ type: "post", slug: "body-post" }]
  );
});

test("a file nothing references is still reported unused and deletable", async () => {
  const lonely = entryFor(await mediaList(), LONELY);
  assert.deepStrictEqual(lonely.usage, []);
  const del = await api("DELETE", "/admin/api/media", { path: LONELY });
  assert.strictEqual(del.status, 200, await del.text());
  assert.strictEqual((await fetch(base + LONELY)).status, 404);
});

test("orphan cleanup keeps a file the manifest still needs", async () => {
  // A post that also uses the hero: deleting it must NOT sweep the hero away,
  // because site.json still references it.
  fs.writeFileSync(
    path.join(PKG, "content", "posts", "hero-user.md"),
    `---\ntitle: "Hero User"\ndate: 2023-06-03 10:00:00\nslug: hero-user\n---\n\n![hero](${HERO})\n`
  );
  const orphans = await (await api("GET", "/admin/api/post/post/hero-user/orphans")).json();
  assert.ok(!orphans.orphans.includes(HERO), "hero is not an orphan of that post");

  const del = await api("DELETE", "/admin/api/post/post/hero-user", { deleteOrphans: true });
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await fetch(base + HERO)).status, 200, "hero survived the cleanup");
});
