"use strict";

// update-control: the ROOT-side agent behind the /admin "Apply now" button.
//
// The unprivileged web app writes an untrusted `update-request.json` into the
// data dir (the one place it can write). This script, run AS ROOT by a
// systemd .path unit (plus a 5-minute safety timer), validates that request,
// and — if it is fresh — runs deploy/update.sh with a forced apply, then
// records the outcome in UPDATE_APPLY_STATUS_FILE. The app never gains a
// privilege; it can only propose an apply.
//
// This is deliberately much smaller than tools/backup-control.js: there is no
// destination/schedule whitelist to validate, just a single requestId/action
// pair, and the actual pull/reinstall/restart/health-check/rollback sequence
// lives entirely in deploy/update.sh (already root-only, already exercised by
// the daily timer's AUTO_APPLY=1 path) — this script only decides whether to
// invoke it and reports what happened.
//
// Two status files, on purpose: UPDATE_STATUS_FILE (owned by update.sh,
// overwritten wholesale on every run including the routine daily check) is
// never touched here. This script owns UPDATE_APPLY_STATUS_FILE exclusively;
// admin/router.js merges the two at read time. See config.js's comment on
// UPDATE_APPLY_STATUS_FILE for the bug this avoids.
//
//   node tools/update-control.js apply    # read+validate+apply a request
//
// The pure functions (validateRequest, readRequestNoFollow) are unit tested;
// the IO (running update.sh, systemd-adjacent bits) is exercised on the test
// VPS, same disclaimer as backup-control.js.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fail, readRequestNoFollow, parseEnvFile, writeStatusFile, readAppliedId, consumeRequest } = require("./agent-lib");

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

// Record that this agent is alive and has checked in, WITHOUT touching the
// outcome of the last real apply (if any) — appliedRequestId/lastOk/lastErr/
// appliedAt are carried forward unchanged; only agentSeenAt moves.
//
// This exists because the three featherspress-update-control.* units are an
// optional, separately-installed agent (see docs/DEPLOY.md's Updates
// section) layered on top of the daily update-checker units that are
// installed everywhere already. Without some signal that THIS agent has ever
// run, admin/router.js's /api/update-status has no way to tell "the agent is
// installed and idle" apart from "the agent was never installed at all" —
// and the GUI's Apply now button used to key its visibility purely off
// UPDATE_STATUS_FILE's `available` (written by the daily checker, which IS
// always installed), so it appeared and silently no-op'd on every box
// lacking this optional agent. Called both when the .path unit fires with
// nothing queued and by the periodic safety-timer trigger — both are the
// same "no request, just heartbeat" case.
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
    // No/invalid/symlinked request: nothing to apply. This is the common
    // case for both the .path unit firing with nothing queued and the
    // 5-minute safety timer — must no-op cleanly, not error — but the app
    // still needs to know this agent exists at all, so heartbeat before
    // returning. See heartbeat()'s comment for why.
    heartbeat(env.UPDATE_APPLY_STATUS);
    return;
  }

  const appliedRequestId = readAppliedId(env.UPDATE_APPLY_STATUS);
  const v = validateRequest(request, { appliedRequestId });
  if (!v.ok) {
    // Record at most the higher of (what was already applied, this request's
    // own id) — never lower the watermark. A rejected request with a
    // lower/non-integer id (e.g. a replayed or hand-crafted one) must not be
    // allowed to reset appliedRequestId backwards, which would let an
    // earlier, already-superseded id validate again later.
    const nextApplied = Math.max(appliedRequestId, Number.isInteger(request.requestId) ? request.requestId : 0);
    writeResult(env, nextApplied, false, v.error);
    consumeRequest(env.UPDATE_REQUEST, request.requestId);
    return;
  }

  // update.conf is the ONLY channel update.sh has for box-specific overrides
  // (REPO_REF/NODE_BIN/NPM_BIN/SERVICE/FP_USER — see update.conf.example).
  // Read it read-only here and forward what it sets, so the AUTO_APPLY-forcing
  // trick below doesn't also discard a box's real config (e.g. a non-main
  // REPO_REF, or NODE_BIN pointed at /usr/bin rather than /opt/node).
  const conf = parseEnvFile(env.UPDATE_CONF);

  // The reliable one-off forced-apply override: UPDATE_CONF=/dev/null makes
  // update.sh's `[ -f "$UPDATE_CONF" ]` check fail, so the persisted
  // /etc/featherspress/update.conf (which may itself set AUTO_APPLY=0) is
  // never SOURCED and so cannot clobber AUTO_APPLY after we set it. Plain
  // `AUTO_APPLY=1 update.sh` does NOT reliably apply for this reason. This
  // only forces AUTO_APPLY — every other setting conf carried is still
  // forwarded explicitly below, from the read above.
  const childEnv = Object.assign({}, process.env, {
    UPDATE_CONF: "/dev/null",
    AUTO_APPLY: "1",
    FP_ENV: env.FP_ENV,
    // Deliberately NOT conf.ENGINE_DIR, unlike REPO_REF/NODE_BIN/NPM_BIN/
    // SERVICE/FP_USER below, which ARE lifted from update.conf: this agent
    // needs its own correct ENGINE_DIR just to locate update.conf and
    // deploy/update.sh in the first place, so a value living inside a file
    // that is only found BY that same setting can't be the source of truth
    // for it. env.ENGINE_DIR (this process's own env/default) is used as-is.
    ENGINE_DIR: env.ENGINE_DIR,
    NODE_BIN: conf.NODE_BIN || env.NODE_BIN,
    NPM_BIN: conf.NPM_BIN || env.NPM_BIN,
    SERVICE: conf.SERVICE || env.SERVICE,
  });
  if (conf.REPO_REF) childEnv.REPO_REF = conf.REPO_REF;
  if (conf.FP_USER) childEnv.FP_USER = conf.FP_USER;

  let exitCode = 0;
  let stderr = "";
  try {
    // No timeout here: `npm ci` on a small VPS can legitimately run minutes.
    // A genuine hang is bounded at the systemd layer instead
    // (TimeoutStartSec=1800 in featherspress-update-control.service).
    // stdout is ignored (update.sh's stdout can be verbose, e.g. npm ci's
    // install log) and stderr gets a generous maxBuffer: the default 1MB
    // cap would SIGTERM the child mid-run on large output, which — unlike a
    // normal nonzero exit — does NOT fire update.sh's own ERR trap, so a
    // kill here could leave a half-applied update without update.sh's own
    // rollback ever running.
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

  // Only ever read by an authenticated admin (no unauthenticated status
  // endpoint in this design), so real stderr detail is fine here — there is
  // no lower-trust reader to protect against.
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
    // process.execPath (the currently-running node binary), not a hardcoded
    // /opt/node/bin/node: on a box whose node lives elsewhere — which
    // docs/DEPLOY.md already tells operators to fix via a `sed` on this
    // unit's own ExecStart — this default is then automatically the SAME
    // node that is actually running this file, no second manual fix in
    // update.conf required.
    NODE_BIN: process.env.NODE_BIN || process.execPath,
    NPM_BIN: process.env.NPM_BIN || "/opt/node/bin/npm",
    SERVICE: process.env.SERVICE || "featherspress",
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
