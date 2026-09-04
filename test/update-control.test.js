"use strict";

// The root update-control agent's PURE logic: request validation and the
// O_NOFOLLOW/size-capped request read. The imperative IO (running
// deploy/update.sh, consuming the request file) is exercised end-to-end on
// the test VPS, same disclaimer as test/backup-control.test.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const uc = require("../tools/update-control");

const CTX = { appliedRequestId: 3 };
const base = { requestId: 4, action: "apply" };

test("accepts a well-formed apply request", () => {
  const r = uc.validateRequest(base, CTX);
  assert.ok(r.ok, r.error);
});

test("rejects a stale requestId", () => {
  const r = uc.validateRequest({ ...base, requestId: 3 }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /stale|invalid/i);
});

test("rejects a requestId equal to the last applied one", () => {
  assert.strictEqual(uc.validateRequest({ ...base, requestId: 3 }, { appliedRequestId: 3 }).ok, false);
});

test("rejects a non-integer requestId", () => {
  assert.strictEqual(uc.validateRequest({ ...base, requestId: 4.5 }, CTX).ok, false);
  assert.strictEqual(uc.validateRequest({ ...base, requestId: "4" }, CTX).ok, false);
  assert.strictEqual(uc.validateRequest({ ...base, requestId: null }, CTX).ok, false);
});

test("rejects a malformed action", () => {
  const r = uc.validateRequest({ ...base, action: "delete-everything" }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /action/);
});

test("rejects a missing action", () => {
  assert.strictEqual(uc.validateRequest({ requestId: 4 }, CTX).ok, false);
});

test("rejects a malformed request", () => {
  assert.strictEqual(uc.validateRequest(null, CTX).ok, false);
  assert.strictEqual(uc.validateRequest("apply", CTX).ok, false);
  assert.strictEqual(uc.validateRequest(undefined, CTX).ok, false);
});

test("readRequestNoFollow refuses a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    fs.writeFileSync(path.join(dir, "real"), "{}");
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "req"));
    assert.throws(() => uc.readRequestNoFollow(path.join(dir, "req")), /symlink|ELOOP|NOFOLLOW/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRequestNoFollow refuses an oversize request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const big = JSON.stringify({ requestId: 1, action: "apply", pad: "x".repeat(70 * 1024) });
    fs.writeFileSync(path.join(dir, "req"), big);
    assert.throws(() => uc.readRequestNoFollow(path.join(dir, "req")), /too large/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRequestNoFollow reads a plain request file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    fs.writeFileSync(path.join(dir, "req"), JSON.stringify({ requestId: 1, action: "apply" }));
    const req = uc.readRequestNoFollow(path.join(dir, "req"));
    assert.strictEqual(req.requestId, 1);
    assert.strictEqual(req.action, "apply");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAppliedId defaults to 0 when the status file is absent or unreadable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    assert.strictEqual(uc.readAppliedId(path.join(dir, "nope.json")), 0);
    fs.writeFileSync(path.join(dir, "bad.json"), "not json");
    assert.strictEqual(uc.readAppliedId(path.join(dir, "bad.json")), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAppliedId reads appliedRequestId back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const p = path.join(dir, "status.json");
    fs.writeFileSync(p, JSON.stringify({ appliedRequestId: 7 }));
    assert.strictEqual(uc.readAppliedId(p), 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusFile writes atomically and is re-readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const p = path.join(dir, "status.json");
    uc.writeStatusFile(p, { appliedRequestId: 9, lastOk: true, lastErr: null, appliedAt: "2026-01-01T00:00:00Z" });
    const written = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(written.appliedRequestId, 9);
    assert.strictEqual(written.lastOk, true);
    assert.strictEqual(fs.existsSync(p + ".tmp"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeRequest deletes only when the request still holds the same id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const p = path.join(dir, "req.json");
    fs.writeFileSync(p, JSON.stringify({ requestId: 1, action: "apply" }));
    uc.consumeRequest(p, 2); // different id: a newer request landed since — leave it
    assert.strictEqual(fs.existsSync(p), true);
    uc.consumeRequest(p, 1); // same id: safe to remove
    assert.strictEqual(fs.existsSync(p), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeRequest is a no-op when the request file is already gone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    assert.doesNotThrow(() => uc.consumeRequest(path.join(dir, "nope.json"), 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRequest no-ops cleanly when there is no request file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const env = {
      UPDATE_REQUEST: path.join(dir, "update-request.json"),
      UPDATE_APPLY_STATUS: path.join(dir, "update-apply-status.json"),
      FP_ENV: "/dev/null",
      ENGINE_DIR: dir,
      NODE_BIN: "/usr/bin/node",
      NPM_BIN: "/usr/bin/npm",
      SERVICE: "featherspress",
    };
    assert.doesNotThrow(() => uc.applyRequest(env));
    assert.strictEqual(fs.existsSync(env.UPDATE_APPLY_STATUS), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- config.js parseEnvFile forwarding (review fix) ------------------------
// update.conf is the ONLY channel update.sh has for box-specific overrides
// (REPO_REF/NODE_BIN/NPM_BIN/SERVICE/FP_USER). Pointing UPDATE_CONF at
// /dev/null for the child process must force AUTO_APPLY without silently
// discarding the rest of the box's real configuration.

test("parseEnvFile reads REPO_REF/NODE_BIN/NPM_BIN/SERVICE/FP_USER out of update.conf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const p = path.join(dir, "update.conf");
    fs.writeFileSync(
      p,
      ["AUTO_APPLY=0", "REPO_REF=develop", "NODE_BIN=/usr/bin/node", "NPM_BIN=/usr/bin/npm",
        "SERVICE=myservice", "FP_USER=someuser"].join("\n") + "\n"
    );
    const conf = uc.parseEnvFile(p);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    assert.deepStrictEqual(uc.parseEnvFile(path.join(dir, "nope.conf")), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Full applyRequest exercise against a STUB update.sh (never touches real
// git/npm/systemd) that just dumps its received environment, proving the
// forwarding actually happens end to end and not just in parseEnvFile isolation.
test("applyRequest forwards update.conf's overrides into update.sh's environment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    fs.mkdirSync(path.join(dir, "deploy"), { recursive: true });
    const stub = path.join(dir, "deploy", "update.sh");
    fs.writeFileSync(stub, "#!/usr/bin/env bash\nenv > \"$ENGINE_DIR/env-dump.txt\"\nexit 0\n");
    fs.chmodSync(stub, 0o755);

    const confPath = path.join(dir, "update.conf");
    fs.writeFileSync(
      confPath,
      ["AUTO_APPLY=0", "REPO_REF=develop", "NODE_BIN=/usr/bin/node", "NPM_BIN=/usr/bin/npm",
        "SERVICE=myservice", "FP_USER=someuser"].join("\n") + "\n"
    );

    const env = {
      UPDATE_REQUEST: path.join(dir, "update-request.json"),
      UPDATE_APPLY_STATUS: path.join(dir, "update-apply-status.json"),
      UPDATE_CONF: confPath,
      FP_ENV: "/dev/null",
      ENGINE_DIR: dir,
      NODE_BIN: "/opt/node/bin/node", // must be overridden by conf.NODE_BIN below
      NPM_BIN: "/opt/node/bin/npm",
      SERVICE: "featherspress",
    };
    fs.writeFileSync(env.UPDATE_REQUEST, JSON.stringify({ requestId: 1, action: "apply" }));

    uc.applyRequest(env);

    const dump = fs.readFileSync(path.join(dir, "env-dump.txt"), "utf8");
    assert.match(dump, /^REPO_REF=develop$/m);
    assert.match(dump, /^NODE_BIN=\/usr\/bin\/node$/m);
    assert.match(dump, /^NPM_BIN=\/usr\/bin\/npm$/m);
    assert.match(dump, /^SERVICE=myservice$/m);
    assert.match(dump, /^FP_USER=someuser$/m);
    // The forcing trick itself must still be in effect for the child:
    assert.match(dump, /^UPDATE_CONF=\/dev\/null$/m);
    assert.match(dump, /^AUTO_APPLY=1$/m);

    const status = JSON.parse(fs.readFileSync(env.UPDATE_APPLY_STATUS, "utf8"));
    assert.strictEqual(status.lastOk, true);
    assert.strictEqual(status.appliedRequestId, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression guard for the review fix: a rejected request must never LOWER
// the recorded watermark, or a previously-superseded requestId could
// validate again on a later run.
test("applyRequest never lowers the recorded watermark on a rejected request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const env = {
      UPDATE_REQUEST: path.join(dir, "update-request.json"),
      UPDATE_APPLY_STATUS: path.join(dir, "update-apply-status.json"),
      UPDATE_CONF: path.join(dir, "update.conf"), // absent — parseEnvFile returns {}
      FP_ENV: "/dev/null",
      ENGINE_DIR: dir, // no deploy/update.sh — a wrong code path here would throw
      NODE_BIN: "/usr/bin/node",
      NPM_BIN: "/usr/bin/npm",
      SERVICE: "featherspress",
    };
    fs.writeFileSync(env.UPDATE_APPLY_STATUS, JSON.stringify({ appliedRequestId: 10 }));
    // A stale, lower requestId — rejected by validateRequest.
    fs.writeFileSync(env.UPDATE_REQUEST, JSON.stringify({ requestId: 2, action: "apply" }));
    uc.applyRequest(env);
    let status = JSON.parse(fs.readFileSync(env.UPDATE_APPLY_STATUS, "utf8"));
    assert.strictEqual(status.appliedRequestId, 10, "watermark must not be lowered by a stale rejected id");
    assert.strictEqual(status.lastOk, false);

    // A malformed, non-integer requestId — also rejected.
    fs.writeFileSync(env.UPDATE_REQUEST, JSON.stringify({ requestId: "not-a-number", action: "apply" }));
    uc.applyRequest(env);
    status = JSON.parse(fs.readFileSync(env.UPDATE_APPLY_STATUS, "utf8"));
    assert.strictEqual(status.appliedRequestId, 10, "watermark must not be lowered by a non-integer rejected id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRequest rejects and records a stale request without invoking update.sh", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const env = {
      UPDATE_REQUEST: path.join(dir, "update-request.json"),
      UPDATE_APPLY_STATUS: path.join(dir, "update-apply-status.json"),
      FP_ENV: "/dev/null",
      ENGINE_DIR: dir, // no deploy/update.sh here — if applyRequest tried to
      // run it, this test would throw instead of recording a clean rejection
      NODE_BIN: "/usr/bin/node",
      NPM_BIN: "/usr/bin/npm",
      SERVICE: "featherspress",
    };
    fs.writeFileSync(env.UPDATE_APPLY_STATUS, JSON.stringify({ appliedRequestId: 5 }));
    fs.writeFileSync(env.UPDATE_REQUEST, JSON.stringify({ requestId: 5, action: "apply" }));
    uc.applyRequest(env);
    const status = JSON.parse(fs.readFileSync(env.UPDATE_APPLY_STATUS, "utf8"));
    assert.strictEqual(status.appliedRequestId, 5);
    assert.strictEqual(status.lastOk, false);
    assert.match(status.lastErr, /stale|invalid/i);
    assert.strictEqual(fs.existsSync(env.UPDATE_REQUEST), false); // consumed
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
