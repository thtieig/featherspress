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
const os = require("node:os");
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

  // Which sections the scheduled backup captures — the same five the export
  // already uses (tools/site-package.js SECTIONS). Absent field = back-compat
  // default of "all five" (existing requests predate this field).
  const ALL_SECTIONS = ["content", "media", "site", "settings", "credentials"];
  let sections = ALL_SECTIONS;
  if (req.sections !== undefined) {
    if (!Array.isArray(req.sections) || req.sections.length === 0) return fail("bad sections");
    for (const sec of req.sections) {
      if (typeof sec !== "string" || !ALL_SECTIONS.includes(sec)) return fail("unknown section");
    }
    sections = [...new Set(req.sections)];
  }

  return {
    ok: true,
    config: {
      destType: d.type,
      localDir,
      remote,
      remotePath,
      keepLast: req.keepLast,
      schedule: { preset: s.preset, timeOfDay: s.timeOfDay || "00:00", weekday: s.weekday || null },
      sections,
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
    restore: i.restore ?? null,
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
  // Comma is included solely for BACKUP_SECTIONS (a comma-joined section list).
  // It is inert on the value side of an unquoted bash assignment (FOO=a,b,c) —
  // bash does not split or expand on ",", so this does not widen the injection
  // surface the rest of the whitelist exists to close.
  if (typeof value !== "string" || !/^[A-Za-z0-9._:@/+,-]*$/.test(value)) {
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
  if (config.sections) {
    if (!Array.isArray(config.sections) || config.sections.length === 0) {
      throw new Error("refusing to write unsafe value for sections");
    }
    assertEnvSafe("sections", config.sections.join(","));
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
  if (config.sections) {
    lines.push(`BACKUP_SECTIONS=${config.sections.join(",")}`);
  }
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

// Pure parse of `systemctl show <timer> -p TimersCalendar --value` output.
// systemd 252 formats it as
//   { OnCalendar=*-*-* 00:20:00 ; next_elapse=Sun 2026-07-26 00:20:00 UTC }
// — pull out just the OnCalendar expression. Also tolerate a bare
// "*-*-* 00:20:00" (no braces/prefix) in case another systemd version formats
// it differently. Anything that isn't recognizably a calendar expression
// (empty, garbage) yields null rather than a false positive.
function parseTimersCalendar(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/OnCalendar=([^;{}]+)/);
  if (m) {
    const cal = m[1].trim();
    return cal || null;
  }
  // No "OnCalendar=" marker: only accept it if it already looks like a bare
  // calendar expression — systemd calendar syntax always carries an HH:MM:SS
  // time field — otherwise this is malformed/unrecognized.
  return /\d{1,2}:\d{2}:\d{2}/.test(s) ? s : null;
}

// systemd's EFFECTIVE calendar for the timer, straight from the unit — not
// from our own drop-in bookkeeping. On a box upgraded from older code,
// BACKUP_SCHEDULE_PRESET may be absent from backup.env even though the
// shipped .timer unit (or an old drop-in) has systemd running a real
// schedule; this is how the UI can be honest about that instead of silently
// showing its HTML default. Best-effort, same pattern as nextRunUTC: null on
// any trouble rather than throwing.
function readEffectiveSchedule(timer) {
  try {
    const out = execFileSync(
      "systemctl",
      ["show", timer, "-p", "TimersCalendar", "--value"],
      { encoding: "utf8" }
    );
    return parseTimersCalendar(out);
  } catch {
    return null;
  }
}

// Carry the last restore outcome across ordinary status refreshes, so the
// panel keeps showing 'done' / 'rolled-back' instead of blanking every 2 min.
function readRestoreState(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")).restore || null;
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
    sections: conf.BACKUP_SECTIONS ? conf.BACKUP_SECTIONS.split(",") : null,
    schedule: {
      preset: conf.BACKUP_SCHEDULE_PRESET || null,
      timeOfDay: conf.BACKUP_SCHEDULE_TIME || "00:24",
      weekday: conf.BACKUP_SCHEDULE_WEEKDAY || null,
      raw: readScheduleDropIn(env.SCHEDULE_DROPIN),
      effective: readEffectiveSchedule("featherspress-backup.timer"),
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
    restore: env._restore ?? readRestoreState(env.BACKUP_STATUS),
  });
  // refreshStatus now runs every 2 minutes off the safety timer (in addition to
  // every apply). A transient unwritable data dir must not make the systemd
  // unit show as failed on every tick — so, unlike every other read above,
  // this is the one place we swallow rather than let it propagate: log to
  // stderr and continue. The top-level `status` CLI command still surfaces a
  // real failure (see main below), it just doesn't come from an uncaught throw.
  try {
    writeStatusFile(env.BACKUP_STATUS, status);
    return true;
  } catch (e) {
    process.stderr.write(`backup-control: failed to write status file: ${e.message}\n`);
    return false;
  }
}

// Delete a request we have finished with — exactly what the restore path's
// cleanup() already does, and for the same two reasons.
//
// Left behind, an applied request is re-read by the .path unit and by every
// 2-minute safety tick, found stale, and recorded as
// lastRequestError:"stale or invalid requestId" — so the panel reports a
// successful save as rejected, forever. (Both production boxes were doing
// exactly this when the bare-box drill went looking.) A REJECTED request must
// go too, or it is retried until the end of time.
//
// It also breaks the trigger: writeBackupRequest renames into place, so when
// the target already exists systemd's inotify watch is on the old inode and
// PathModified never fires. The first save on a box is prompt and every one
// after it waits for the 2-minute backstop.
//
// Only unlink when the file still holds the request we processed: a save that
// landed while we were working is someone else's to apply, not ours to drop.
function consumeRequest(requestPath, requestId) {
  try {
    if (readRequestNoFollow(requestPath).requestId !== requestId) return;
  } catch {
    // Unreadable or already gone: nothing safe to remove.
    return;
  }
  try {
    fs.unlinkSync(requestPath);
  } catch {}
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
    consumeRequest(env.BACKUP_REQUEST, request.requestId);
    refreshStatus(env);
    return;
  }
  // renderBackupEnv/assertEnvSafe can throw — e.g. a hand-edited backup.env
  // whose preserved AGE_RECIPIENT/NODE_BIN/ENGINE_DIR fails the character
  // class. Left uncaught, that propagates to the top-level handler and exits
  // 1 without writing the status file or advancing appliedRequestId, so the
  // .path unit and the safety timer retry the same doomed request forever
  // and the panel just stops updating with no visible error. Route it
  // through the same rejected-request path validation failures use instead.
  let rendered;
  try {
    rendered = renderBackupEnv(v.config, conf);
  } catch {
    env._appliedRequestId = request.requestId;
    env._lastOk = false;
    env._lastErr = "failed to apply: could not render backup.env";
    refreshStatus(env);
    return;
  }
  try {
    fs.writeFileSync(env.BACKUP_ENV, rendered, { mode: 0o600 });
    fs.chmodSync(env.BACKUP_ENV, 0o600);
  } catch {
    env._appliedRequestId = request.requestId;
    env._lastOk = false;
    env._lastErr = "failed to apply: could not write backup.env";
    refreshStatus(env);
    return;
  }
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
  consumeRequest(env.BACKUP_REQUEST, request.requestId);
  // A change arriving during apply: re-read once so a rapid second save isn't lost.
  refreshStatus(env);
}

// ---- restore ---------------------------------------------------------------
// Restore is the same shape as a backup config change: the app writes an
// untrusted request, root validates it against a whitelist and acts. The extra
// obligation here is that restore can leave a site unbootable — src/manifest.js
// rethrows on a malformed site.json and server.js loads the manifest and skin at
// module scope — so this borrows update.sh's discipline: snapshot, restore,
// restart, health-check, and roll back if the site does not come up.

const RESTORE_SECTIONS = ["content", "media", "site", "settings", "credentials"];

// Validate an untrusted restore request. `stagedName` must be a BARE filename:
// it is joined to the staging dir, so a path or `..` would aim the import at an
// arbitrary file. Errors are fixed strings and never echo the input.
function validateRestoreRequest(req, ctx) {
  if (!req || typeof req !== "object") return fail("malformed request");
  if (!Number.isInteger(req.requestId) || req.requestId <= (ctx.appliedRestoreId || 0)) {
    return fail("stale or invalid requestId");
  }
  const name = req.stagedName;
  if (
    typeof name !== "string" ||
    name === "" ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    path.basename(name) !== name
  ) {
    return fail("stagedName must be a plain filename");
  }
  if (!Array.isArray(req.sections) || req.sections.length === 0) return fail("bad sections");
  for (const s of req.sections) {
    if (typeof s !== "string" || !RESTORE_SECTIONS.includes(s)) return fail("unknown section");
  }
  return {
    ok: true,
    config: {
      requestId: req.requestId,
      stagedName: name,
      sections: [...new Set(req.sections)],
      restoreAuth: !!req.restoreAuth && req.sections.includes("credentials"),
    },
  };
}

// /healthz alone is too weak — it answers 200 on a wiped site. Require the home
// page to render too, exactly as deploy/update.sh does.
function siteHealthy(port, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      execFileSync("curl", ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${port}/healthz`], { stdio: "pipe" });
      execFileSync("curl", ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${port}/`], { stdio: "pipe" });
      return true;
    } catch {
      try {
        execFileSync("sleep", ["2"]);
      } catch {}
    }
  }
  return false;
}

function restoreStatus(env, state, extra) {
  env._restore = Object.assign({ state, at: new Date().toISOString() }, extra || {});
  refreshStatus(env);
}

// Apply an archive's settings.json through the SAME validator the /admin backup
// panel uses. That whitelist has no field for box-specific facts (paths, users,
// NODE_BIN, SESSION_SECRET), so they structurally cannot travel from the source
// box. Anything that fails to validate is skipped and reported, never fatal —
// a site restored with the wrong backup destination is far better than no site.
function applyRestoredSettings(env, settings) {
  const skipped = [];
  const b = (settings && settings.backup) || {};
  const conf = parseEnvFile(env.BACKUP_ENV);

  // The age recipient is a PUBLIC key, and the one box-level setting that must
  // travel: without it a migrated box silently starts writing PLAINTEXT nightly
  // archives that carry the password hash and TOTP secret, and an off-box
  // destination fails validation outright. It is not a box-specific fact, so
  // nothing in the whitelist's rationale argues against carrying it.
  //
  // Only ever FILLS IN a missing one. Overwriting a recipient this box already
  // has would orphan every encrypted backup it has already taken — the same
  // reason keygen refuses to rotate.
  if (!conf.AGE_RECIPIENT && typeof b.ageRecipient === "string") {
    if (/^age1[0-9a-z]{50,}$/.test(b.ageRecipient)) conf.AGE_RECIPIENT = b.ageRecipient;
    else skipped.push("the archive's backup encryption key was not a valid age recipient");
  }

  const req = {
    requestId: Number.MAX_SAFE_INTEGER - 1, // not persisted; this is a direct apply
    action: "apply",
    destination:
      b.destType === "rclone"
        ? { type: "rclone", remote: b.remote, remotePath: b.remotePath }
        : { type: "local", localDir: b.localDir || "/var/backups/featherspress" },
    keepLast: Number.isInteger(b.keepLast) ? b.keepLast : 14,
    schedule: b.schedule || { preset: "daily", timeOfDay: "00:20", weekday: null },
    sections: Array.isArray(b.sections) ? b.sections : undefined,
  };
  const v = validateRequest(req, {
    availableRemotes: listRemotes(),
    ageRecipientSet: !!conf.AGE_RECIPIENT,
    appliedRequestId: 0,
  });
  if (!v.ok) {
    skipped.push(v.error);
    return skipped;
  }
  try {
    fs.writeFileSync(env.BACKUP_ENV, renderBackupEnv(v.config, conf), { mode: 0o600 });
    fs.chmodSync(env.BACKUP_ENV, 0o600);
    fs.mkdirSync(path.dirname(env.SCHEDULE_DROPIN), { recursive: true });
    fs.writeFileSync(
      env.SCHEDULE_DROPIN,
      `[Timer]\nOnCalendar=\nOnCalendar=${buildOnCalendar(v.config.schedule)}\n`
    );
    execFileSync("systemctl", ["daemon-reload"]);
    execFileSync("systemctl", ["restart", "featherspress-backup.timer"]);
  } catch {
    skipped.push("could not apply restored backup settings");
  }
  return skipped;
}

function restoreRequest(env) {
  let request;
  try {
    request = readRequestNoFollow(env.RESTORE_REQUEST);
  } catch {
    return; // no/invalid/symlinked restore request: nothing to do
  }
  let applied = 0;
  try {
    applied = JSON.parse(fs.readFileSync(env.BACKUP_STATUS, "utf8")).restore?.appliedRequestId || 0;
  } catch {}

  const v = validateRestoreRequest(request, { appliedRestoreId: applied });
  const finish = () => {
    fs.rmSync(env.RESTORE_REQUEST, { force: true });
  };
  if (!v.ok) {
    env._restoreApplied = Number.isInteger(request.requestId) ? request.requestId : applied;
    restoreStatus(env, "failed", { error: v.error, appliedRequestId: env._restoreApplied });
    finish();
    return;
  }

  const cfg = v.config;
  env._restoreApplied = cfg.requestId;
  // Resolve the staged archive inside the staging dir and prove it stayed there.
  const staged = path.join(env.IMPORT_STAGING, cfg.stagedName);
  const rel = path.relative(env.IMPORT_STAGING, staged);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(staged)) {
    restoreStatus(env, "failed", { error: "staged archive not found", appliedRequestId: cfg.requestId });
    finish();
    return;
  }

  const conf = parseEnvFile(env.BACKUP_ENV);
  const node = conf.NODE_BIN || env.NODE_BIN;
  const pkgTool = path.join(env.ENGINE_DIR, "tools", "site-package.js");
  const port = parseEnvFile(env.FP_ENV).PORT || "8787";
  const cleanup = () => {
    fs.rmSync(staged, { force: true });
    finish();
  };

  // 1. Snapshot the CURRENT data before touching anything, outside the data dir.
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "featherspress-prerestore-"));
  fs.chmodSync(snapDir, 0o700);
  const snapshot = path.join(snapDir, "pre-restore.tar.gz");
  restoreStatus(env, "restoring", { appliedRequestId: cfg.requestId, sections: cfg.sections });
  try {
    execFileSync(node, [pkgTool, "export", "--profile", "full", "--env-file", env.FP_ENV, "--out", snapshot], {
      stdio: "pipe",
    });
  } catch {
    restoreStatus(env, "failed", {
      error: "could not snapshot the current site; nothing was changed",
      appliedRequestId: cfg.requestId,
    });
    fs.rmSync(snapDir, { recursive: true, force: true });
    cleanup();
    return;
  }

  // 2. Restore the requested sections.
  // --no-safety-snapshot: we took our own snapshot above and own the rollback.
  // Without it the CLI strands a second full copy of the site, credentials and
  // all, in /tmp after every single restore, and nothing ever prunes it.
  const importArgs = [pkgTool, "import", staged, "--force", "--no-safety-snapshot",
    "--env-file", env.FP_ENV, "--sections", cfg.sections.join(",")];
  if (cfg.restoreAuth) importArgs.push("--restore-auth");
  let skipped = [];
  try {
    execFileSync(node, importArgs, { stdio: "pipe" });
  } catch {
    restoreStatus(env, "failed", {
      error: "the archive could not be restored; nothing was changed",
      appliedRequestId: cfg.requestId,
    });
    fs.rmSync(snapDir, { recursive: true, force: true });
    cleanup();
    return;
  }

  // 3. Settings, through the same whitelist /admin writes go through.
  if (cfg.sections.includes("settings")) {
    try {
      const raw = execFileSync("tar", ["-xzOf", staged, "./settings.json"], { encoding: "utf8", stdio: "pipe" });
      skipped = applyRestoredSettings(env, JSON.parse(raw));
    } catch {
      skipped.push("archive carried no readable settings.json");
    }
  }

  // 4. Restart, then prove the site actually renders — not just /healthz, which
  //    answers 200 on a wiped site.
  restoreStatus(env, "restarting", { appliedRequestId: cfg.requestId, sections: cfg.sections });
  try {
    execFileSync("systemctl", ["restart", env.SERVICE]);
  } catch {}
  if (siteHealthy(port)) {
    restoreStatus(env, "done", {
      appliedRequestId: cfg.requestId,
      sections: cfg.sections,
      skipped: skipped.length ? skipped : null,
      error: null,
    });
    fs.rmSync(snapDir, { recursive: true, force: true });
    cleanup();
    return;
  }

  // 5. It did not come up — put the old site back and restart again.
  try {
    execFileSync(node, [pkgTool, "import", snapshot, "--force", "--restore-auth",
      "--no-safety-snapshot", "--env-file", env.FP_ENV], { stdio: "pipe" });
    execFileSync("systemctl", ["restart", env.SERVICE]);
  } catch {}
  const recovered = siteHealthy(port);
  restoreStatus(env, "rolled-back", {
    appliedRequestId: cfg.requestId,
    sections: cfg.sections,
    error: recovered
      ? "the restored site did not come up; your previous site was put back"
      : "the restored site did not come up AND the rollback did not recover it — check the server",
  });
  fs.rmSync(snapDir, { recursive: true, force: true });
  cleanup();
}

function envFromProcess() {
  return {
    BACKUP_ENV: process.env.BACKUP_ENV || "/etc/featherspress/backup.env",
    RESTORE_REQUEST: process.env.RESTORE_REQUEST || "/var/lib/featherspress/restore-request.json",
    IMPORT_STAGING: process.env.IMPORT_STAGING || "/var/lib/featherspress/import-staging",
    FP_ENV: process.env.FP_ENV || "/etc/featherspress/featherspress.env",
    ENGINE_DIR: process.env.ENGINE_DIR || "/opt/featherspress",
    SERVICE: process.env.SERVICE || "featherspress",
    NODE_BIN: process.env.NODE_BIN || "/opt/node/bin/node",
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
    if (cmd === "status") {
      // Unlike apply's periodic use of refreshStatus, an explicit `status`
      // invocation is the operator/monitoring asking "did this actually
      // work?" — so a swallowed write failure must still exit non-zero here.
      if (!refreshStatus(env)) process.exit(1);
    } else if (cmd === "apply") applyRequest(env);
    else if (cmd === "restore") restoreRequest(env);
    else {
      process.stderr.write("usage: backup-control.js <apply|status|restore>\n");
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
  parseTimersCalendar,
  validateRestoreRequest,
  restoreRequest,
  applyRestoredSettings,
  siteHealthy,
};
