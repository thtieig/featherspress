"use strict";

// src/auth-config.js: the atomic-write helper plus the --password-only reset
// logic. Pure module test -- no server, no network, just the file on disk.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bcrypt = require("bcryptjs");

const { resetPassword, writeAuthConfigAtomic } = require("../src/auth-config");

function makeConfig(dir, overrides = {}) {
  const configPath = path.join(dir, "auth-config.json");
  const data = Object.assign(
    {
      passwordHash: bcrypt.hashSync("old-password", 8),
      totpSecret: "JBSWY3DPEHPK3PXP",
      recoveryCodeHashes: ["deadbeef", "cafef00d"],
    },
    overrides
  );
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  return { configPath, data };
}

let TMP;

test.beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-auth-config-"));
});

test.afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("resetPassword: new password's hash verifies, old one no longer does", () => {
  const { configPath } = makeConfig(TMP);
  resetPassword(configPath, "new-password-123");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(bcrypt.compareSync("new-password-123", written.passwordHash));
  assert.ok(!bcrypt.compareSync("old-password", written.passwordHash));
});

test("resetPassword: leaves totpSecret and recoveryCodeHashes untouched", () => {
  const { configPath, data } = makeConfig(TMP);
  resetPassword(configPath, "new-password-123");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.strictEqual(written.totpSecret, data.totpSecret);
  assert.deepStrictEqual(written.recoveryCodeHashes, data.recoveryCodeHashes);
});

test("resetPassword: file mode stays 0600", () => {
  const { configPath } = makeConfig(TMP);
  resetPassword(configPath, "new-password-123");
  const mode = fs.statSync(configPath).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test("resetPassword: rejects a password under 8 chars, leaves the file unmodified", () => {
  const { configPath } = makeConfig(TMP);
  const before = fs.readFileSync(configPath);
  assert.throws(() => resetPassword(configPath, "short"));
  const after = fs.readFileSync(configPath);
  assert.ok(before.equals(after));
});

test("resetPassword: rejects a missing password, leaves the file unmodified", () => {
  const { configPath } = makeConfig(TMP);
  const before = fs.readFileSync(configPath);
  assert.throws(() => resetPassword(configPath, ""));
  const after = fs.readFileSync(configPath);
  assert.ok(before.equals(after));
});

test("resetPassword: missing config file throws and creates nothing", () => {
  const configPath = path.join(TMP, "does-not-exist.json");
  assert.throws(() => resetPassword(configPath, "new-password-123"));
  assert.ok(!fs.existsSync(configPath));
  assert.ok(!fs.existsSync(configPath + ".tmp"));
});

test("resetPassword: a file that fails to parse throws without writing", () => {
  const configPath = path.join(TMP, "auth-config.json");
  fs.writeFileSync(configPath, "not valid json", { mode: 0o600 });
  const before = fs.readFileSync(configPath);
  assert.throws(() => resetPassword(configPath, "new-password-123"));
  const after = fs.readFileSync(configPath);
  assert.ok(before.equals(after));
});

test("writeAuthConfigAtomic: writes JSON at 0600 and leaves no .tmp file behind", () => {
  const configPath = path.join(TMP, "auth-config.json");
  writeAuthConfigAtomic(configPath, { hello: "world" });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { hello: "world" });
  assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(configPath + ".tmp"));
});
