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

// ---- heartbeat (review fix) -------------------------------------------
// The three featherspress-update-control.* units are an optional, separately
// -installed agent (docs/DEPLOY.md). Without some signal that this agent has
// actually run, the admin UI cannot tell "installed, idle" apart from "never
// installed", and used to show an Apply now button that silently did nothing
// on every box lacking the agent. applyRequest's no-request path — hit by
// both the .path unit firing empty and the periodic safety timer — must now
// heartbeat UPDATE_APPLY_STATUS_FILE instead of no-op'ing entirely.

test("applyRequest heartbeats UPDATE_APPLY_STATUS when there is no request file", () => {
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
    assert.strictEqual(fs.existsSync(env.UPDATE_APPLY_STATUS), false);
    assert.doesNotThrow(() => uc.applyRequest(env));
    assert.strictEqual(fs.existsSync(env.UPDATE_APPLY_STATUS), true);
    const status = JSON.parse(fs.readFileSync(env.UPDATE_APPLY_STATUS, "utf8"));
    assert.ok(status.agentSeenAt, "agentSeenAt must be stamped");
    assert.strictEqual(status.appliedRequestId, 0);
    assert.strictEqual(status.lastOk, null);
    assert.strictEqual(status.lastErr, null);
    assert.strictEqual(status.appliedAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat preserves an existing appliedRequestId/lastOk/lastErr/appliedAt, only moving agentSeenAt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const p = path.join(dir, "update-apply-status.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        schemaVersion: 1,
        appliedRequestId: 42,
        lastOk: true,
        lastErr: null,
        appliedAt: "2026-01-01T00:00:00Z",
      })
    );
    uc.heartbeat(p);
    const status = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(status.appliedRequestId, 42);
    assert.strictEqual(status.lastOk, true);
    assert.strictEqual(status.appliedAt, "2026-01-01T00:00:00Z");
    assert.ok(status.agentSeenAt, "agentSeenAt must be stamped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat on a fresh (absent) status file still produces a readable status with agentSeenAt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const p = path.join(dir, "update-apply-status.json");
    assert.strictEqual(fs.existsSync(p), false);
    uc.heartbeat(p);
    const status = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(status.appliedRequestId, 0);
    assert.strictEqual(status.lastOk, null);
    assert.ok(status.agentSeenAt);
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
