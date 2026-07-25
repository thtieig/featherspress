"use strict";

// admin/archive.js: the age encryption helper (key-based both ways — `age -p`
// cannot be driven from a web app, see the module header). buildSettings now
// lives in src/settings.js (test/settings.test.js) — archive.js just
// re-exports it for admin/router.js. The age round-trip tests SKIP (not fail)
// when `age`/`age-keygen` are absent, so the suite still runs on a dev box
// without them.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const archive = require("../admin/archive");

const HAVE_AGE = (() => {
  try {
    execFileSync("age", ["--version"], { stdio: "pipe" });
    execFileSync("age-keygen", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

if (!HAVE_AGE) {
  // A silent skip of the ONLY tests covering the encryption path is dangerous:
  // it is easy to ship a broken encrypt/decrypt round-trip and have the suite
  // stay green. Make the gap loud instead.
  console.warn(
    "SKIPPING age tests: age binary not found — encryption path is UNVERIFIED on this machine"
  );
}

test("age round-trip with a piped identity", { skip: !HAVE_AGE }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-age-"));
  execFileSync("age-keygen", ["-o", path.join(dir, "key.txt")], { stdio: "pipe" });
  const identity = fs.readFileSync(path.join(dir, "key.txt"), "utf8");
  const recipient = identity.match(/public key: (age1\w+)/)[1];
  fs.writeFileSync(path.join(dir, "plain.txt"), "the site");
  archive.encryptToRecipient(path.join(dir, "plain.txt"), path.join(dir, "c.age"), recipient);
  archive.decryptWithIdentity(path.join(dir, "c.age"), path.join(dir, "out.txt"), identity);
  assert.strictEqual(fs.readFileSync(path.join(dir, "out.txt"), "utf8"), "the site");
  // The decrypted artifact may carry credentials — must never be world-readable.
  assert.strictEqual(fs.statSync(path.join(dir, "out.txt")).mode & 0o777, 0o600);
});

test("decrypting with the wrong identity throws", { skip: !HAVE_AGE }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-age-"));
  execFileSync("age-keygen", ["-o", path.join(dir, "key.txt")], { stdio: "pipe" });
  const identity = fs.readFileSync(path.join(dir, "key.txt"), "utf8");
  const recipient = identity.match(/public key: (age1\w+)/)[1];

  execFileSync("age-keygen", ["-o", path.join(dir, "wrong-key.txt")], { stdio: "pipe" });
  const wrongIdentity = fs.readFileSync(path.join(dir, "wrong-key.txt"), "utf8");

  fs.writeFileSync(path.join(dir, "plain.txt"), "the site");
  archive.encryptToRecipient(path.join(dir, "plain.txt"), path.join(dir, "c.age"), recipient);

  // Prove the CORRECT identity decrypts first. Without this, a totally broken
  // decryptWithIdentity (e.g. every call throws regardless of identity) would
  // make the "wrong identity throws" assertion below pass for the wrong
  // reason — exactly what happened when `-i /dev/stdin` broke the round-trip
  // but this test still reported green.
  archive.decryptWithIdentity(path.join(dir, "c.age"), path.join(dir, "out-correct.txt"), identity);
  assert.strictEqual(fs.readFileSync(path.join(dir, "out-correct.txt"), "utf8"), "the site");

  assert.throws(
    () => archive.decryptWithIdentity(path.join(dir, "c.age"), path.join(dir, "out.txt"), wrongIdentity),
    /could not decrypt/
  );
});
