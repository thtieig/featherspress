"use strict";

// update-control: the ROOT-side agent behind the /admin "Apply now" button.
//
// The unprivileged app writes an untrusted update-request.json into the data
// dir. This script, run as root by a systemd .path unit (plus a 5-minute
// safety timer), validates it and runs deploy/update.sh with AUTO_APPLY=1,
// then records the outcome in UPDATE_APPLY_STATUS_FILE. The pull, reinstall,
// restart, health check and rollback all live in update.sh.
//
// It never touches UPDATE_STATUS_FILE: update.sh rewrites that wholesale on
// every run, so the apply outcome lives in its own file and admin/router.js
// merges the two when it reads them.
//
//   node tools/update-control.js apply

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fail, readRequestNoFollow, writeStatusFile, readAppliedId, consumeRequest } = require("./agent-lib");

// Validate an untrusted request. Returns {ok:true} or {ok:false, error} where
// error is a fixed, non-echoing string. ctx.appliedRequestId is the last id
// this agent has already processed (0 if none yet).
function validateRequest(req, ctx) {
  if (!req || typeof req !== "object") return fail("malformed request");
  if (!Number.isInteger(req.requestId) || req.requestId <= ctx.appliedRequestId) {
    return fail("stale or invalid requestId");
  }
  if (req.action !== "apply") return fail("action must be apply");
  return { ok: true };
}

function writeResult(env, requestId, ok, err) {
  writeStatusFile(env.UPDATE_APPLY_STATUS, {
    schemaVersion: 1,
    appliedRequestId: requestId,
    lastOk: ok,
    lastErr: err,
    appliedAt: new Date().toISOString(),
    agentSeenAt: new Date().toISOString(),
  });
}

// Record that the agent is alive (agentSeenAt) without touching the last
// apply's outcome. The update-control units are optional, so this is how
// /admin knows the agent is installed and can show the Apply now button.
function heartbeat(statusPath) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    // Absent or unreadable: first time this agent has ever run here.
  }
  writeStatusFile(statusPath, {
    schemaVersion: 1,
    appliedRequestId: existing.appliedRequestId || 0,
    lastOk: existing.lastOk ?? null,
    lastErr: existing.lastErr ?? null,
    appliedAt: existing.appliedAt ?? null,
    agentSeenAt: new Date().toISOString(),
  });
}

function applyRequest(env) {
  let request;
  try {
    request = readRequestNoFollow(env.UPDATE_REQUEST);
  } catch {
    // No request (or an unreadable one): the .path unit fired empty or the
    // safety timer ticked. Nothing to apply; just check in.
    heartbeat(env.UPDATE_APPLY_STATUS);
    return;
  }

  const appliedRequestId = readAppliedId(env.UPDATE_APPLY_STATUS);
  const v = validateRequest(request, { appliedRequestId });
  if (!v.ok) {
    // Never lower the watermark: a rejected replayed or hand-crafted id must
    // not let an older, superseded id validate again later.
    const nextApplied = Math.max(appliedRequestId, Number.isInteger(request.requestId) ? request.requestId : 0);
    writeResult(env, nextApplied, false, v.error);
    consumeRequest(env.UPDATE_REQUEST, request.requestId);
    return;
  }

  // update.sh lets the environment win over update.conf, so forcing
  // AUTO_APPLY here applies this once even when update.conf says 0, and every
  // other setting (REPO_REF, NODE_BIN, NPM_BIN, SERVICE, FP_USER) still comes
  // from update.conf. Nothing else is set here, so nothing else overrides it.
  const childEnv = {
    ...process.env,
    AUTO_APPLY: "1",
    UPDATE_CONF: env.UPDATE_CONF,
    FP_ENV: env.FP_ENV,
    ENGINE_DIR: env.ENGINE_DIR,
  };

  let exitCode = 0;
  let stderr = "";
  try {
    // No timeout: npm ci can take minutes; systemd bounds a real hang
    // (TimeoutStartSec). stdout is dropped and stderr gets a large buffer,
    // because hitting the default 1MB cap kills the child, and a kill skips
    // update.sh's rollback trap.
    execFileSync(path.join(env.ENGINE_DIR, "deploy", "update.sh"), [], {
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    exitCode = typeof e.status === "number" ? e.status : 1;
    const raw = (e.stderr && e.stderr.toString("utf8")) || e.message || "";
    stderr = raw.slice(-2048); // bounded — last ~2KB is plenty to see why
  }

  // Only an authenticated admin reads this, so the real stderr is fine here.
  writeResult(env, request.requestId, exitCode === 0, exitCode === 0 ? null : stderr);
  consumeRequest(env.UPDATE_REQUEST, request.requestId);
}

function envFromProcess() {
  return {
    UPDATE_REQUEST: process.env.UPDATE_REQUEST || "/var/lib/featherspress/update-request.json",
    UPDATE_APPLY_STATUS: process.env.UPDATE_APPLY_STATUS || "/var/lib/featherspress/update-apply-status.json",
    UPDATE_CONF: process.env.UPDATE_CONF || "/etc/featherspress/update.conf",
    FP_ENV: process.env.FP_ENV || "/etc/featherspress/featherspress.env",
    ENGINE_DIR: process.env.ENGINE_DIR || "/opt/featherspress",
  };
}

if (require.main === module) {
  const cmd = process.argv[2];
  const env = envFromProcess();
  try {
    if (cmd === "apply") applyRequest(env);
    else {
      process.stderr.write("usage: update-control.js <apply>\n");
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`update-control: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  validateRequest,
  applyRequest,
  heartbeat,
};
