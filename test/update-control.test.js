"use strict";

// The root update-control agent: request validation, the heartbeat, and
// applyRequest against a stub update.sh. The real update.sh is covered by
// test/update-sh.test.js.

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

// ---- heartbeat --------------------------------------------------------
// The update-control units are an optional, separately installed agent
// (docs/DEPLOY.md). The admin UI shows Apply now only once the agent has
// checked in, so applyRequest's no-request path (the .path unit firing empty,
// or the safety timer) must heartbeat UPDATE_APPLY_STATUS_FILE.

test("applyRequest heartbeats UPDATE_APPLY_STATUS when there is no request file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const env = {
      UPDATE_REQUEST: path.join(dir, "update-request.json"),
      UPDATE_APPLY_STATUS: path.join(dir, "update-apply-status.json"),
      FP_ENV: "/dev/null",
      ENGINE_DIR: dir,
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

// applyRequest against a STUB update.sh that just dumps the environment it
// was given. update.sh itself lets the environment win over update.conf (see
// test/update-sh.test.js), so the agent must force AUTO_APPLY and nothing
// else: anything more would override the box's own update.conf.
test("applyRequest runs update.sh with AUTO_APPLY=1, the real update.conf and no other overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    fs.mkdirSync(path.join(dir, "deploy"), { recursive: true });
    const stub = path.join(dir, "deploy", "update.sh");
    fs.writeFileSync(stub, "#!/usr/bin/env bash\nenv > \"$ENGINE_DIR/env-dump.txt\"\nexit 0\n");
    fs.chmodSync(stub, 0o755);
    const confPath = path.join(dir, "update.conf");
    fs.writeFileSync(confPath, "AUTO_APPLY=0\nREPO_REF=develop\nNODE_BIN=/usr/bin/node\n");

    const env = {
      UPDATE_REQUEST: path.join(dir, "update-request.json"),
      UPDATE_APPLY_STATUS: path.join(dir, "update-apply-status.json"),
      UPDATE_CONF: confPath,
      FP_ENV: "/dev/null",
      ENGINE_DIR: dir,
    };
    fs.writeFileSync(env.UPDATE_REQUEST, JSON.stringify({ requestId: 1, action: "apply" }));

    uc.applyRequest(env);

    const dump = fs.readFileSync(path.join(dir, "env-dump.txt"), "utf8");
    assert.match(dump, /^AUTO_APPLY=1$/m);
    assert.ok(dump.includes(`\nUPDATE_CONF=${confPath}\n`), "update.sh must read the real update.conf");
    for (const k of ["REPO_REF", "NODE_BIN", "NPM_BIN", "SERVICE", "FP_USER"]) {
      if (process.env[k] === undefined) assert.doesNotMatch(dump, new RegExp(`^${k}=`, "m"), k);
    }

    const status = JSON.parse(fs.readFileSync(env.UPDATE_APPLY_STATUS, "utf8"));
    assert.strictEqual(status.lastOk, true);
    assert.strictEqual(status.appliedRequestId, 1);
    assert.strictEqual(fs.existsSync(env.UPDATE_REQUEST), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A rejected request must never LOWER the recorded watermark, or a
// previously superseded requestId could validate again on a later run.
test("applyRequest never lowers the recorded watermark on a rejected request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  try {
    const env = {
      UPDATE_REQUEST: path.join(dir, "update-request.json"),
      UPDATE_APPLY_STATUS: path.join(dir, "update-apply-status.json"),
      FP_ENV: "/dev/null",
      ENGINE_DIR: dir, // no deploy/update.sh — a wrong code path here would throw
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
