"use strict";

// backup-control: the ROOT-side agent behind the /admin Backups panel.
//
// The unprivileged web app writes an untrusted `backup-request.json` into the
// data dir (the one place it can write). This script, run AS ROOT by a systemd
// .path unit (plus a 2-minute safety timer), validates that request against a
// strict whitelist, applies it to /etc/featherspress/backup.env and a timer
// drop-in, and refreshes `backup-status.json` — which the app reads (read-only)
// to render the panel. The app never gains a privilege; it can only propose.
//
// Design + threat model: docs/superpowers/specs/2026-07-24-backup-admin-ui-design.md
//
//   node tools/backup-control.js apply    # read+validate+apply a request
//   node tools/backup-control.js status    # just refresh the status file
//
// The pure functions (validateRequest, buildOnCalendar, buildStatus) are unit
// tested; the IO is exercised end-to-end on the test VPS.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PRESETS = ["hourly", "daily", "twice-daily", "weekly"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LOCAL_ROOT = "/var/backups";

function fail(error) {
  return { ok: false, error };
}

function validTimeOfDay(t) {
  if (typeof t !== "string" || !/^\d{2}:\d{2}$/.test(t)) return false;
  const [h, m] = t.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// Build the systemd OnCalendar string from a whitelisted preset. Root does this
// itself so the app never supplies raw calendar syntax.
function buildOnCalendar(schedule) {
  const t = schedule.timeOfDay || "00:00";
  const [h, m] = t.split(":");
  switch (schedule.preset) {
    case "hourly":
      return `*-*-* *:00:00`;
    case "daily":
      return `*-*-* ${h}:${m}:00`;
    case "twice-daily": {
      const h2 = String((Number(h) + 12) % 24).padStart(2, "0");
      const [a, b] = [h, h2].sort();
      return `*-*-* ${a},${b}:${m}:00`;
    }
    case "weekly":
      return `${schedule.weekday} *-*-* ${h}:${m}:00`;
    default:
      throw new Error("bad preset");
  }
}

// Validate an untrusted request. Returns {ok:true, config} or {ok:false, error}
// where error is a fixed, non-echoing string. ctx carries the box facts the app
// cannot know itself (which remotes exist, whether encryption is set up).
function validateRequest(req, ctx) {
  if (!req || typeof req !== "object") return fail("malformed request");
  if (!Number.isInteger(req.requestId) || req.requestId <= ctx.appliedRequestId)
    return fail("stale or invalid requestId");
  if (req.action !== "apply" && req.action !== "run-now") return fail("action must be apply or run-now");

  const d = req.destination || {};
  let localDir = null;
  let remote = null;
  let remotePath = null;
  if (d.type === "local") {
    if (typeof d.localDir !== "string" || !path.isAbsolute(d.localDir)) return fail("localDir must be absolute");
    if (!/^[A-Za-z0-9._/-]+$/.test(d.localDir)) return fail("localDir has invalid characters");
    const norm = path.normalize(d.localDir);
    const rel = path.relative(LOCAL_ROOT, norm);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return fail("localDir must be under /var/backups");
    localDir = norm;
  } else if (d.type === "rclone") {
    if (!ctx.ageRecipientSet) return fail("off-box needs encryption: set AGE_RECIPIENT first");
    if (!ctx.availableRemotes.includes(d.remote)) return fail("unknown remote");
    if (
      typeof d.remotePath !== "string" ||
      !/^[A-Za-z0-9._/-]+$/.test(d.remotePath) ||
      d.remotePath.split("/").includes("..") ||
      d.remotePath.startsWith("/")
    )
      return fail("bad remotePath");
    remote = d.remote;
    remotePath = d.remotePath;
  } else {
    return fail("destination.type must be local or rclone");
  }

  if (!Number.isInteger(req.keepLast) || req.keepLast < 1 || req.keepLast > 365)
    return fail("keepLast must be 1-365");

  const s = req.schedule || {};
  if (!PRESETS.includes(s.preset)) return fail("unknown schedule preset");
  if (!validTimeOfDay(s.timeOfDay || "00:00")) return fail("bad timeOfDay");
  if (s.preset === "weekly" && !WEEKDAYS.includes(s.weekday)) return fail("weekly needs a weekday");

  return {
    ok: true,
    config: {
      destType: d.type,
      localDir,
      remote,
      remotePath,
      keepLast: req.keepLast,
      schedule: { preset: s.preset, timeOfDay: s.timeOfDay || "00:00", weekday: s.weekday || null },
      action: req.action,
    },
  };
}

// Assemble the status object the app reads. No secrets: remote NAMES and an
// `encrypted` boolean only (never the age recipient, never rclone config).
function buildStatus(i) {
  return {
    schemaVersion: 1,
    writtenAt: i.writtenAt,
    appliedRequestId: i.appliedRequestId ?? 0,
    lastRequestOk: i.lastRequestOk ?? null,
    lastRequestError: i.lastRequestError ?? null,
    config: i.config ?? null,
    encrypted: !!i.encrypted,
    availableRemotes: i.availableRemotes ?? [],
    lastRun: i.lastRun ?? null,
    nextRun: i.nextRun ?? null,
    artifactCount: i.artifactCount ?? 0,
    ageRecipient: i.ageRecipient ?? null,
    update: i.update ?? null,
  };
}

// Read the request WITHOUT following a symlink (the file lives in an app-writable
// dir), size-capped. Throws on symlink/oversize/parse error.
function readRequestNoFollow(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (st.size > 64 * 1024) throw new Error("request too large");
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return JSON.parse(buf.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

// backup.env is sourced by bash (deploy/backup.sh). A value carrying a
// newline would inject an arbitrary extra variable into a root-read file,
// so refuse rather than write one — validateRequest should have caught it.
function assertEnvSafe(name, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:@/+-]*$/.test(value)) {
    throw new Error(`refusing to write unsafe value for ${name}`);
  }
}

// Render /etc/featherspress/backup.env from a validated config, preserving the
// operator-set, non-UI fields (encryption key, node path, engine dir).
function renderBackupEnv(config, prev) {
  assertEnvSafe("destType", config.destType);
  if (!Number.isInteger(config.keepLast)) {
    throw new Error(`refusing to write unsafe value for keepLast`);
  }
  if (config.destType === "local") {
    assertEnvSafe("localDir", config.localDir);
  } else {
    assertEnvSafe("remote", config.remote);
    assertEnvSafe("remotePath", config.remotePath);
  }
  if (config.schedule) {
    assertEnvSafe("schedule.preset", config.schedule.preset);
    assertEnvSafe("schedule.timeOfDay", config.schedule.timeOfDay);
    if (config.schedule.weekday) {
      assertEnvSafe("schedule.weekday", config.schedule.weekday);
    }
  }
  if (prev.AGE_RECIPIENT) assertEnvSafe("AGE_RECIPIENT", prev.AGE_RECIPIENT);
  if (prev.NODE_BIN) assertEnvSafe("NODE_BIN", prev.NODE_BIN);
  if (prev.ENGINE_DIR) assertEnvSafe("ENGINE_DIR", prev.ENGINE_DIR);

  const lines = [
    "# Managed by tools/backup-control.js — /admin may overwrite edits here.",
    `DEST_TYPE=${config.destType}`,
  ];
  if (config.destType === "local") lines.push(`LOCAL_DIR=${config.localDir}`);
  else lines.push(`RCLONE_REMOTE=${config.remote}:${config.remotePath}`);
  lines.push(`KEEP_LAST=${config.keepLast}`);
  if (config.schedule) {
    lines.push(`BACKUP_SCHEDULE_PRESET=${config.schedule.preset}`);
    lines.push(`BACKUP_SCHEDULE_TIME=${config.schedule.timeOfDay}`);
    if (config.schedule.preset === "weekly" && config.schedule.weekday) {
      lines.push(`BACKUP_SCHEDULE_WEEKDAY=${config.schedule.weekday}`);
    }
  }
  if (prev.AGE_RECIPIENT) lines.push(`AGE_RECIPIENT=${prev.AGE_RECIPIENT}`);
  if (prev.NODE_BIN) lines.push(`NODE_BIN=${prev.NODE_BIN}`);
  if (prev.ENGINE_DIR) lines.push(`ENGINE_DIR=${prev.ENGINE_DIR}`);
  return lines.join("\n") + "\n";
}

function parseEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function listRemotes() {
  try {
    return execFileSync("rclone", ["listremotes"], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.replace(/:$/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeStatusFile(statusPath, obj) {
  const tmp = statusPath + ".tmp";
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, statusPath);
}

// systemd's NextElapse value; best-effort. Null on any trouble → UI shows
// "unknown" rather than breaking.
function nextRunUTC(timer) {
  try {
    const out = execFileSync(
      "systemctl",
      ["show", timer, "-p", "NextElapseUSecRealtime", "--value"],
      { encoding: "utf8" }
    ).trim();
    if (!out || out === "0") return null;
    // Value is µs since epoch OR a formatted date depending on systemd; try both.
    const asNum = Number(out);
    if (Number.isFinite(asNum) && asNum > 0) return new Date(asNum / 1000).toISOString();
    const d = new Date(out);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function readAppliedId(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")).appliedRequestId || 0;
  } catch {
    return 0;
  }
}

function readScheduleDropIn(p) {
  try {
    const m = fs.readFileSync(p, "utf8").match(/OnCalendar=(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function refreshStatus(env) {
  const conf = parseEnvFile(env.BACKUP_ENV);
  // update.conf is optional (root:root 0600) and read-only here: only
  // AUTO_APPLY and REPO_REF are ever lifted out of it into the 0644 status
  // file the unprivileged app reads. Any other field it may contain
  // (ENGINE_DIR, NODE_BIN, NPM_BIN, SERVICE, FP_USER — box-specific paths and
  // usernames) is parsed but never referenced below, so it never leaks.
  const upd = parseEnvFile(env.UPDATE_CONF);
  let lastRun = null;
  try {
    lastRun = JSON.parse(fs.readFileSync(env.LAST_RUN_FILE, "utf8"));
  } catch {}
  let artifactCount = 0;
  if (conf.DEST_TYPE === "local" && conf.LOCAL_DIR) {
    try {
      artifactCount = fs.readdirSync(conf.LOCAL_DIR).filter((f) => f.startsWith("featherspress-full-")).length;
    } catch {}
  }
  const cfg = {
    destType: conf.DEST_TYPE || "local",
    localDir: conf.LOCAL_DIR || null,
    remote: conf.RCLONE_REMOTE ? conf.RCLONE_REMOTE.split(":")[0] : null,
    remotePath: conf.RCLONE_REMOTE ? conf.RCLONE_REMOTE.split(":").slice(1).join(":") : null,
    keepLast: Number(conf.KEEP_LAST || 14),
    schedule: {
      preset: conf.BACKUP_SCHEDULE_PRESET || null,
      timeOfDay: conf.BACKUP_SCHEDULE_TIME || "00:24",
      weekday: conf.BACKUP_SCHEDULE_WEEKDAY || null,
      raw: readScheduleDropIn(env.SCHEDULE_DROPIN),
    },
  };
  const status = buildStatus({
    appliedRequestId: env._appliedRequestId ?? readAppliedId(env.BACKUP_STATUS),
    lastRequestOk: env._lastOk ?? null,
    lastRequestError: env._lastErr ?? null,
    config: cfg,
    encrypted: !!conf.AGE_RECIPIENT,
    availableRemotes: listRemotes(),
    lastRun,
    nextRun: nextRunUTC("featherspress-backup.timer"),
    artifactCount,
    writtenAt: new Date().toISOString(),
    ageRecipient: conf.AGE_RECIPIENT || null,
    update: { autoApply: upd.AUTO_APPLY === "1", repoRef: upd.REPO_REF || "main" },
  });
  writeStatusFile(env.BACKUP_STATUS, status);
}

function applyRequest(env) {
  let request;
  try {
    request = readRequestNoFollow(env.BACKUP_REQUEST);
  } catch {
    // No/invalid/symlinked request: nothing to apply — but still refresh, or
    // the panel's nextRun/artifactCount only ever update during a backup run
    // (when systemd reports no next elapse at all).
    refreshStatus(env);
    return;
  }
  const conf = parseEnvFile(env.BACKUP_ENV);
  const ctx = {
    availableRemotes: listRemotes(),
    ageRecipientSet: !!conf.AGE_RECIPIENT,
    appliedRequestId: readAppliedId(env.BACKUP_STATUS),
  };
  const v = validateRequest(request, ctx);
  if (!v.ok) {
    env._appliedRequestId = request.requestId;
    env._lastOk = false;
    env._lastErr = v.error;
    refreshStatus(env);
    return;
  }
  fs.writeFileSync(env.BACKUP_ENV, renderBackupEnv(v.config, conf), { mode: 0o600 });
  fs.chmodSync(env.BACKUP_ENV, 0o600);
  // "Back up now" must never change WHEN backups run. Only an explicit
  // apply rewrites the timer.
  if (v.config.action === "apply") {
    fs.mkdirSync(path.dirname(env.SCHEDULE_DROPIN), { recursive: true });
    fs.writeFileSync(
      env.SCHEDULE_DROPIN,
      `[Timer]\nOnCalendar=\nOnCalendar=${buildOnCalendar(v.config.schedule)}\n`
    );
    try {
      execFileSync("systemctl", ["daemon-reload"]);
      execFileSync("systemctl", ["restart", "featherspress-backup.timer"]);
    } catch {}
  }
  if (v.config.action === "run-now") {
    try {
      execFileSync("systemctl", ["start", "--no-block", "featherspress-backup.service"]);
    } catch {}
  }
  env._appliedRequestId = request.requestId;
  env._lastOk = true;
  env._lastErr = null;
  // A change arriving during apply: re-read once so a rapid second save isn't lost.
  refreshStatus(env);
}

function envFromProcess() {
  return {
    BACKUP_ENV: process.env.BACKUP_ENV || "/etc/featherspress/backup.env",
    BACKUP_REQUEST: process.env.BACKUP_REQUEST || "/var/lib/featherspress/backup-request.json",
    BACKUP_STATUS: process.env.BACKUP_STATUS || "/var/lib/featherspress/backup-status.json",
    LAST_RUN_FILE: process.env.LAST_RUN_FILE || "/var/lib/featherspress/backup-last-run.json",
    SCHEDULE_DROPIN:
      process.env.SCHEDULE_DROPIN || "/etc/systemd/system/featherspress-backup.timer.d/schedule.conf",
    UPDATE_CONF: process.env.UPDATE_CONF || "/etc/featherspress/update.conf",
  };
}

if (require.main === module) {
  const cmd = process.argv[2];
  const env = envFromProcess();
  try {
    if (cmd === "status") refreshStatus(env);
    else if (cmd === "apply") applyRequest(env);
    else {
      process.stderr.write("usage: backup-control.js <apply|status>\n");
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`backup-control: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  validateRequest,
  buildOnCalendar,
  buildStatus,
  readRequestNoFollow,
  renderBackupEnv,
  parseEnvFile,
  applyRequest,
};
