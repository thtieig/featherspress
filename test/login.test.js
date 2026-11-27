"use strict";

// Login hardening: a successful login gets a fresh session id (no session
// fixation), and a TOTP code that was already accepted can't be used again.
// Its own file (own process) because the login rate limit is per process.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { generate, generateSecret } = require("otplib");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-login-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";

const PASSWORD = "testpassword123";
const TOTP_SECRET = generateSecret();
const RECOVERY = ["abcd-1234", "efgh-5678"];
fs.writeFileSync(
  process.env.AUTH_CONFIG,
  JSON.stringify({
    passwordHash: bcrypt.hashSync(PASSWORD, 8),
    totpSecret: TOTP_SECRET,
    recoveryCodeHashes: RECOVERY.map((c) => crypto.createHash("sha256").update(c).digest("hex")),
  })
);

const app = require("../server");

let base;
let server;
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

async function login(code, cookie) {
  const res = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ password: PASSWORD, code }),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie: set };
}

async function authed(cookie) {
  const res = await fetch(base + "/admin/api/posts", { headers: { cookie } });
  await res.text();
  return res.status === 200;
}

test("a login gets a new session id, and the old one stops working", async () => {
  const first = await login(RECOVERY[0]);
  assert.strictEqual(first.status, 200);
  assert.ok(await authed(first.cookie));

  // Log in again while presenting the existing session cookie.
  const second = await login(RECOVERY[1], first.cookie);
  assert.strictEqual(second.status, 200);
  assert.match(second.cookie, /connect\.sid=/);
  assert.notStrictEqual(second.cookie, first.cookie);
  assert.ok(await authed(second.cookie));
  assert.ok(!(await authed(first.cookie)), "the pre-login session id must not stay valid");
});

test("an accepted TOTP code can't be used again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const code = await generate({ secret: TOTP_SECRET, epoch: now });
  assert.strictEqual((await login(code)).status, 200);
  assert.strictEqual((await login(code)).status, 401, "replayed code must be rejected");

  // The next time step's code (within the clock tolerance) is still fine...
  const next = await generate({ secret: TOTP_SECRET, epoch: now + 30 });
  assert.strictEqual((await login(next)).status, 200);
  // ...but after it, an older step's code is not.
  const older = await generate({ secret: TOTP_SECRET, epoch: now - 30 });
  assert.strictEqual((await login(older)).status, 401);
});

test("a wrong password and a wrong code get the same reply", async () => {
  const send = async (password, code) => {
    const res = await fetch(base + "/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, code }),
    });
    return { status: res.status, body: await res.text() };
  };
  const badPassword = await send("not-the-password", "000000");
  const badCode = await send(PASSWORD, "000000");
  assert.strictEqual(badPassword.status, 401);
  assert.deepStrictEqual(badCode, badPassword, "the reply must not say which part was wrong");
});
