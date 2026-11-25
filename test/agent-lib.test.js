"use strict";

// tools/agent-lib.js: helpers shared by the root agents and the site-package CLI.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("../tools/agent-lib");

test("readRequestNoFollow refuses a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    fs.writeFileSync(path.join(dir, "real"), "{}");
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "req"));
    assert.throws(() => lib.readRequestNoFollow(path.join(dir, "req")), /symlink|ELOOP|NOFOLLOW/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRequestNoFollow refuses an oversize request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const big = JSON.stringify({ requestId: 1, action: "apply", pad: "x".repeat(70 * 1024) });
    fs.writeFileSync(path.join(dir, "req"), big);
    assert.throws(() => lib.readRequestNoFollow(path.join(dir, "req")), /too large/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRequestNoFollow reads a plain request file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    fs.writeFileSync(path.join(dir, "req"), JSON.stringify({ requestId: 1, action: "apply" }));
    const req = lib.readRequestNoFollow(path.join(dir, "req"));
    assert.strictEqual(req.requestId, 1);
    assert.strictEqual(req.action, "apply");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAppliedId defaults to 0 when the status file is absent or unreadable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    assert.strictEqual(lib.readAppliedId(path.join(dir, "nope.json")), 0);
    fs.writeFileSync(path.join(dir, "bad.json"), "not json");
    assert.strictEqual(lib.readAppliedId(path.join(dir, "bad.json")), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAppliedId reads appliedRequestId back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "status.json");
    fs.writeFileSync(p, JSON.stringify({ appliedRequestId: 7 }));
    assert.strictEqual(lib.readAppliedId(p), 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusFile writes atomically and is re-readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "status.json");
    lib.writeStatusFile(p, { appliedRequestId: 9, lastOk: true, lastErr: null, appliedAt: "2026-01-01T00:00:00Z" });
    const written = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(written.appliedRequestId, 9);
    assert.strictEqual(written.lastOk, true);
    assert.strictEqual(fs.existsSync(p + ".tmp"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeRequest deletes only when the request still holds the same id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "req.json");
    fs.writeFileSync(p, JSON.stringify({ requestId: 1, action: "apply" }));
    lib.consumeRequest(p, 2); // different id: a newer request landed since — leave it
    assert.strictEqual(fs.existsSync(p), true);
    lib.consumeRequest(p, 1); // same id: safe to remove
    assert.strictEqual(fs.existsSync(p), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeRequest is a no-op when the request file is already gone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    assert.doesNotThrow(() => lib.consumeRequest(path.join(dir, "nope.json"), 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile reads REPO_REF/NODE_BIN/NPM_BIN/SERVICE/FP_USER out of update.conf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "update.conf");
    fs.writeFileSync(
      p,
      ["AUTO_APPLY=0", "REPO_REF=develop", "NODE_BIN=/usr/bin/node", "NPM_BIN=/usr/bin/npm",
        "SERVICE=myservice", "FP_USER=someuser"].join("\n") + "\n"
    );
    const conf = lib.parseEnvFile(p);
    assert.strictEqual(conf.REPO_REF, "develop");
    assert.strictEqual(conf.NODE_BIN, "/usr/bin/node");
    assert.strictEqual(conf.NPM_BIN, "/usr/bin/npm");
    assert.strictEqual(conf.SERVICE, "myservice");
    assert.strictEqual(conf.FP_USER, "someuser");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile returns {} for a missing file, without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    assert.deepStrictEqual(lib.parseEnvFile(path.join(dir, "nope.conf")), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnv accepts an export prefix and strips one layer of quotes", () => {
  const conf = lib.parseEnv(
    ["# comment", "export AGE_RECIPIENT=age1abc", 'NODE_BIN="/usr/bin/node"', "SERVICE='fp'", "not a line"].join("\n")
  );
  assert.deepStrictEqual(conf, { AGE_RECIPIENT: "age1abc", NODE_BIN: "/usr/bin/node", SERVICE: "fp" });
});
