"use strict";

// A one-time recovery code must stay used. Two sign-ins at the same moment,
// each with its own recovery code, used to write the remaining codes from
// stale copies, so one of the used codes came back to life.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-recovery-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";

const PASSWORD = "testpassword123";
const CODES = ["aaaa-1111", "bbbb-2222", "cccc-3333"];
fs.writeFileSync(process.env.AUTH_CONFIG, JSON.stringify({
  passwordHash: bcrypt.hashSync(PASSWORD, 8),
  totpSecret: "JBSWY3DPEHPK3PXP",
  recoveryCodeHashes: CODES.map((c) => crypto.createHash("sha256").update(c).digest("hex")),
}));

// Make the 2FA check take a moment, as it can under load, so both sign-ins
// are inside it at the same time. Patched before the router takes its copy.
// (Its exports are getters, so the cached module object is swapped instead.)
const otplib = require("otplib");
require.cache[require.resolve("otplib")].exports = {
  ...otplib,
  verify: async (...args) => {
    await new Promise((r) => setTimeout(r, 200));
    return otplib.verify(...args);
  },
};

const app = require("../server");

let base, server;
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

const login = (code) => fetch(base + "/admin/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: PASSWORD, code }),
}).then((r) => r.status);

test("two recovery codes used at the same moment both stay used", async () => {
  assert.deepStrictEqual(await Promise.all([login(CODES[0]), login(CODES[1])]), [200, 200]);
  assert.strictEqual(await login(CODES[0]), 401, "the first code must not work again");
  assert.strictEqual(await login(CODES[1]), 401, "the second code must not work again");
  assert.strictEqual(await login(CODES[2]), 200, "the unused code must still work");
});
