"use strict";

// The root backup-control agent's PURE logic: request validation and OnCalendar
// building. The imperative IO (apply to backup.env, systemctl, O_NOFOLLOW read)
// is exercised end-to-end on the test VPS; here we pin the security-critical
// validation precisely.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bc = require("../tools/backup-control");

const CTX = { availableRemotes: ["mys3", "bbz"], ageRecipientSet: true, appliedRequestId: 3 };
const base = {
  requestId: 4,
  action: "apply",
  destination: { type: "local", localDir: "/var/backups/featherspress" },
  keepLast: 14,
  schedule: { preset: "daily", timeOfDay: "00:24", weekday: null },
};

test("accepts a well-formed local request", () => {
  const r = bc.validateRequest(base, CTX);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.config.destType, "local");
  assert.strictEqual(r.config.keepLast, 14);
});

test("rejects a stale requestId", () => {
  assert.strictEqual(bc.validateRequest({ ...base, requestId: 3 }, CTX).ok, false);
});

test("rejects localDir outside /var/backups", () => {
  const r = bc.validateRequest({ ...base, destination: { type: "local", localDir: "/etc/cron.d" } }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /localDir/);
});

test("rejects localDir traversal", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, destination: { type: "local", localDir: "/var/backups/../etc" } }, CTX).ok,
    false
  );
});

test("rejects an unknown rclone remote", () => {
  const r = bc.validateRequest({ ...base, destination: { type: "rclone", remote: "evil", remotePath: "b" } }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /remote/);
});

test("accepts a known rclone remote", () => {
  const r = bc.validateRequest({ ...base, destination: { type: "rclone", remote: "mys3", remotePath: "fp" } }, CTX);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.config.remote, "mys3");
  assert.strictEqual(r.config.remotePath, "fp");
});

test("rejects rclone when no age recipient set", () => {
  const r = bc.validateRequest(
    { ...base, destination: { type: "rclone", remote: "mys3", remotePath: "fp" } },
    { ...CTX, ageRecipientSet: false }
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /encrypt/i);
});

test("rejects remotePath traversal", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, destination: { type: "rclone", remote: "mys3", remotePath: "../x" } }, CTX).ok,
    false
  );
});

test("rejects an absolute remotePath", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, destination: { type: "rclone", remote: "mys3", remotePath: "/x" } }, CTX).ok,
    false
  );
});

test("rejects keepLast out of range or non-integer", () => {
  assert.strictEqual(bc.validateRequest({ ...base, keepLast: 0 }, CTX).ok, false);
  assert.strictEqual(bc.validateRequest({ ...base, keepLast: 999 }, CTX).ok, false);
  assert.strictEqual(bc.validateRequest({ ...base, keepLast: 2.5 }, CTX).ok, false);
});

test("rejects unknown schedule preset", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, schedule: { preset: "yearly", timeOfDay: "00:00" } }, CTX).ok,
    false
  );
});

test("rejects bad timeOfDay", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, schedule: { preset: "daily", timeOfDay: "24:99" } }, CTX).ok,
    false
  );
});

test("weekly requires a weekday", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, schedule: { preset: "weekly", timeOfDay: "03:00", weekday: null } }, CTX).ok,
    false
  );
  assert.ok(
    bc.validateRequest({ ...base, schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" } }, CTX).ok
  );
});

test("buildOnCalendar maps presets", () => {
  assert.strictEqual(bc.buildOnCalendar({ preset: "daily", timeOfDay: "00:24" }), "*-*-* 00:24:00");
  assert.strictEqual(bc.buildOnCalendar({ preset: "hourly" }), "*-*-* *:00:00");
  assert.strictEqual(bc.buildOnCalendar({ preset: "twice-daily", timeOfDay: "06:30" }), "*-*-* 06,18:30:00");
  assert.strictEqual(bc.buildOnCalendar({ preset: "weekly", timeOfDay: "03:00", weekday: "Sun" }), "Sun *-*-* 03:00:00");
});

test("action must be apply or run-now", () => {
  assert.strictEqual(bc.validateRequest({ ...base, action: "rm" }, CTX).ok, false);
});

// ---- Task 10: configurable backup sections ---------------------------------

test("accepts a valid sections list", () => {
  const r = bc.validateRequest({ ...base, sections: ["content", "media"] }, CTX);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.config.sections, ["content", "media"]);
});

test("rejects an unknown section", () => {
  const r = bc.validateRequest({ ...base, sections: ["content", "etc"] }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /section/);
});

test("defaults to all sections when none are given", () => {
  const r = bc.validateRequest(base, CTX);
  assert.deepStrictEqual(r.config.sections,
    ["content", "media", "site", "settings", "credentials"]);
});

// ---- Task 2: status assembler --------------------------------------------

test("buildStatus produces the documented shape with no secrets", () => {
  const s = bc.buildStatus({
    appliedRequestId: 7,
    lastRequestOk: true,
    lastRequestError: null,
    config: {
      destType: "local",
      localDir: "/var/backups/featherspress",
      remote: null,
      remotePath: null,
      keepLast: 14,
      schedule: { preset: "daily", timeOfDay: "00:24", weekday: null },
    },
    encrypted: true,
    availableRemotes: ["mys3"],
    lastRun: { at: "t", ok: true, error: null, artifactBytes: 5 },
    nextRun: "2026-07-25T00:24:00Z",
    artifactCount: 3,
    writtenAt: "now",
  });
  assert.strictEqual(s.schemaVersion, 1);
  assert.strictEqual(s.appliedRequestId, 7);
  assert.deepStrictEqual(s.availableRemotes, ["mys3"]);
  assert.strictEqual(JSON.stringify(s).includes("AGE-SECRET"), false);
  assert.strictEqual(s.config.keepLast, 14);
});

// ---- Task 7: settings travel via backup-status.json -----------------------

test("buildStatus carries the update config and the age recipient", () => {
  const s = bc.buildStatus({
    writtenAt: "2026-07-25T00:00:00Z",
    config: { destType: "local", keepLast: 14 },
    ageRecipient: "age1abc",
    update: { autoApply: false, repoRef: "main" },
  });
  assert.strictEqual(s.ageRecipient, "age1abc");
  assert.deepStrictEqual(s.update, { autoApply: false, repoRef: "main" });
});

test("buildStatus defaults ageRecipient/update to null when not supplied", () => {
  const s = bc.buildStatus({ writtenAt: "now", config: { destType: "local", keepLast: 14 } });
  assert.strictEqual(s.ageRecipient, null);
  assert.strictEqual(s.update, null);
});

// ---- Task 9c: honest schedule reporting on upgraded boxes ------------------
// A box upgraded from older code has no BACKUP_SCHEDULE_* in backup.env, so
// `preset` is null even though systemd is actually running a real schedule
// (the shipped .timer, or an old drop-in). `effective` — read straight off
// the systemd unit — must survive buildStatus so the panel can be honest
// about it instead of silently showing its HTML default.

test("buildStatus carries config.schedule.effective through", () => {
  const s = bc.buildStatus({
    writtenAt: "now",
    config: {
      destType: "local",
      keepLast: 14,
      schedule: { preset: null, timeOfDay: "00:24", weekday: null, effective: "*-*-* 00:20:00" },
    },
  });
  assert.strictEqual(s.config.schedule.effective, "*-*-* 00:20:00");
});

test("parseTimersCalendar extracts OnCalendar from the real systemd 252 form", () => {
  assert.strictEqual(
    bc.parseTimersCalendar("{ OnCalendar=*-*-* 00:20:00 ; next_elapse=Sun 2026-07-26 00:20:00 UTC }"),
    "*-*-* 00:20:00"
  );
});

test("parseTimersCalendar tolerates a bare calendar expression with no braces", () => {
  assert.strictEqual(bc.parseTimersCalendar("*-*-* 00:20:00"), "*-*-* 00:20:00");
});

test("parseTimersCalendar returns null for malformed or empty values", () => {
  assert.strictEqual(bc.parseTimersCalendar(""), null);
  assert.strictEqual(bc.parseTimersCalendar(null), null);
  assert.strictEqual(bc.parseTimersCalendar(undefined), null);
  assert.strictEqual(bc.parseTimersCalendar("n/a"), null);
  assert.strictEqual(bc.parseTimersCalendar("garbage output"), null);
});

// ---- Task 3: IO helpers ---------------------------------------------------

test("readRequestNoFollow refuses a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  try {
    fs.writeFileSync(path.join(dir, "real"), "{}");
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "req"));
    assert.throws(() => bc.readRequestNoFollow(path.join(dir, "req")), /symlink|ELOOP|NOFOLLOW/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRequestNoFollow reads a plain request file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  try {
    fs.writeFileSync(path.join(dir, "req"), JSON.stringify({ requestId: 1 }));
    assert.strictEqual(bc.readRequestNoFollow(path.join(dir, "req")).requestId, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renderBackupEnv writes the validated config and preserves NODE_BIN/AGE_RECIPIENT", () => {
  const env = bc.renderBackupEnv(
    { destType: "rclone", remote: "mys3", remotePath: "fp", keepLast: 9, localDir: null },
    { NODE_BIN: "/usr/bin/node", AGE_RECIPIENT: "age1xxx", ENGINE_DIR: "/opt/featherspress" }
  );
  assert.match(env, /DEST_TYPE=rclone/);
  assert.match(env, /RCLONE_REMOTE=mys3:fp/);
  assert.match(env, /KEEP_LAST=9/);
  assert.match(env, /NODE_BIN=\/usr\/bin\/node/);
  assert.match(env, /AGE_RECIPIENT=age1xxx/);
});

test("renderBackupEnv local destination omits RCLONE_REMOTE", () => {
  const env = bc.renderBackupEnv(
    { destType: "local", localDir: "/var/backups/featherspress", keepLast: 5 },
    {}
  );
  assert.match(env, /DEST_TYPE=local/);
  assert.match(env, /LOCAL_DIR=\/var\/backups\/featherspress/);
  assert.doesNotMatch(env, /RCLONE_REMOTE/);
});

test("renderBackupEnv persists the schedule structurally", () => {
  const config = {
    destType: "local", localDir: "/var/backups/featherspress", keepLast: 14,
    schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" },
  };
  const out = bc.renderBackupEnv(config, {});
  assert.match(out, /^BACKUP_SCHEDULE_PRESET=weekly$/m);
  assert.match(out, /^BACKUP_SCHEDULE_TIME=03:00$/m);
  assert.match(out, /^BACKUP_SCHEDULE_WEEKDAY=Sun$/m);
  assert.match(out, /^KEEP_LAST=14$/m);
});

test("the rendered env round-trips through parseEnvFile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-env-"));
  const file = path.join(dir, "backup.env");
  fs.writeFileSync(file, bc.renderBackupEnv({
    destType: "local", localDir: "/var/backups/featherspress", keepLast: 14,
    schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" },
  }, {}));
  const parsed = bc.parseEnvFile(file);
  assert.strictEqual(parsed.BACKUP_SCHEDULE_PRESET, "weekly");
  assert.strictEqual(parsed.BACKUP_SCHEDULE_TIME, "03:00");
  assert.strictEqual(parsed.BACKUP_SCHEDULE_WEEKDAY, "Sun");
});

test("renderBackupEnv omits the weekday when the preset is not weekly", () => {
  const out = bc.renderBackupEnv(
    { destType: "local", localDir: "/var/backups/x", keepLast: 5,
      schedule: { preset: "daily", timeOfDay: "00:24", weekday: null } }, {});
  assert.match(out, /^BACKUP_SCHEDULE_PRESET=daily$/m);
  assert.doesNotMatch(out, /BACKUP_SCHEDULE_WEEKDAY/);
});

test("rejects hourly with newline-injected timeOfDay", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, schedule: { preset: "hourly", timeOfDay: "00:00\nRCLONE_REMOTE=evil:pwned" } }, CTX).ok,
    false
  );
});

test("rejects localDir with newline injection", () => {
  assert.strictEqual(
    bc.validateRequest({ ...base, destination: { type: "local", localDir: "/var/backups/ok\nAGE_RECIPIENT=attacker" } }, CTX).ok,
    false
  );
});

test("renderBackupEnv throws when localDir contains a newline", () => {
  assert.throws(
    () => bc.renderBackupEnv(
      { destType: "local", localDir: "/var/backups/ok\nEVIL=injected", keepLast: 5, schedule: { preset: "daily", timeOfDay: "00:24", weekday: null } },
      {}
    ),
    /refusing to write unsafe/i
  );
});

test("rclone config with normal remote:path still renders correctly", () => {
  const out = bc.renderBackupEnv(
    { destType: "rclone", remote: "mys3", remotePath: "backups/prod", keepLast: 14, schedule: { preset: "daily", timeOfDay: "09:00", weekday: null } },
    { AGE_RECIPIENT: "age1xyz", NODE_BIN: "/usr/bin/node" }
  );
  assert.match(out, /RCLONE_REMOTE=mys3:backups\/prod/);
  assert.match(out, /AGE_RECIPIENT=age1xyz/);
  assert.match(out, /NODE_BIN=\/usr\/bin\/node/);
  assert.match(out, /BACKUP_SCHEDULE_PRESET=daily/);
  assert.match(out, /BACKUP_SCHEDULE_TIME=09:00/);
});

test("renderBackupEnv throws when prev.NODE_BIN contains a newline", () => {
  assert.throws(
    () => bc.renderBackupEnv(
      { destType: "local", localDir: "/var/backups/ok", keepLast: 5, schedule: { preset: "daily", timeOfDay: "00:24", weekday: null } },
      { NODE_BIN: "/usr/bin/node\nAGE_RECIPIENT=attacker" }
    ),
    /refusing to write unsafe/i
  );
});

test("renderBackupEnv throws when prev.AGE_RECIPIENT contains a newline", () => {
  assert.throws(
    () => bc.renderBackupEnv(
      { destType: "local", localDir: "/var/backups/ok", keepLast: 5, schedule: { preset: "daily", timeOfDay: "00:24", weekday: null } },
      { AGE_RECIPIENT: "age1xxx\nKEEP_LAST=1" }
    ),
    /refusing to write unsafe/i
  );
});

test("hourly preset with normal timeOfDay still works", () => {
  const r = bc.validateRequest({ ...base, schedule: { preset: "hourly", timeOfDay: "00:00" } }, CTX);
  assert.ok(r.ok, r.error);
});

test("hourly preset with omitted timeOfDay still works", () => {
  const r = bc.validateRequest({ ...base, schedule: { preset: "hourly" } }, CTX);
  assert.ok(r.ok, r.error);
});

// ---- Task 2: run-now must not touch the schedule --------------------------

test("a run-now request does not rewrite the schedule drop-in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bc-"));
  const env = {
    BACKUP_ENV: path.join(dir, "backup.env"),
    BACKUP_REQUEST: path.join(dir, "backup-request.json"),
    BACKUP_STATUS: path.join(dir, "backup-status.json"),
    LAST_RUN_FILE: path.join(dir, "last-run.json"),
    SCHEDULE_DROPIN: path.join(dir, "dropin", "schedule.conf"),
  };
  fs.mkdirSync(path.dirname(env.SCHEDULE_DROPIN), { recursive: true });
  fs.writeFileSync(env.SCHEDULE_DROPIN, "[Timer]\nOnCalendar=\nOnCalendar=Sun *-*-* 03:00:00\n");
  fs.writeFileSync(env.BACKUP_ENV,
    "DEST_TYPE=local\nLOCAL_DIR=/var/backups/featherspress\nKEEP_LAST=14\n" +
    "BACKUP_SCHEDULE_PRESET=weekly\nBACKUP_SCHEDULE_TIME=03:00\nBACKUP_SCHEDULE_WEEKDAY=Sun\n");
  fs.writeFileSync(env.BACKUP_REQUEST, JSON.stringify({
    requestId: 99, action: "run-now",
    destination: { type: "local", localDir: "/var/backups/featherspress" },
    keepLast: 14, schedule: { preset: "daily", timeOfDay: "00:24" },
  }));
  bc.applyRequest(env);
  assert.match(fs.readFileSync(env.SCHEDULE_DROPIN, "utf8"), /Sun \*-\*-\* 03:00:00/,
    "run-now must leave the configured schedule alone");
});

// Regression: a hand-edited backup.env whose preserved AGE_RECIPIENT fails
// assertEnvSafe's character class (e.g. a trailing comment leaving a space in
// the value) made renderBackupEnv throw. Uncaught, that propagated out of
// applyRequest, exiting 1 without writing the status file or advancing
// appliedRequestId — so the .path unit and the safety timer would retry the
// same doomed request forever with the panel just frozen and no error shown.
// It must instead be routed through the same rejected-request path
// validation failures use: appliedRequestId advances, status is written,
// lastRequestOk is false, and a fixed (non-echoing) error string is set.
test("a poisoned preserved AGE_RECIPIENT is reported, not left wedged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bc-poison-"));
  const env = {
    BACKUP_ENV: path.join(dir, "backup.env"),
    BACKUP_REQUEST: path.join(dir, "backup-request.json"),
    BACKUP_STATUS: path.join(dir, "backup-status.json"),
    LAST_RUN_FILE: path.join(dir, "last-run.json"),
    SCHEDULE_DROPIN: path.join(dir, "schedule.conf"),
  };
  // Trailing comment on AGE_RECIPIENT parses to a value containing spaces,
  // which fails assertEnvSafe's character class.
  fs.writeFileSync(
    env.BACKUP_ENV,
    "DEST_TYPE=local\nLOCAL_DIR=/var/backups/featherspress\nKEEP_LAST=14\n" +
      "AGE_RECIPIENT=age1xxx # my key\n"
  );
  fs.writeFileSync(env.BACKUP_REQUEST, JSON.stringify({
    requestId: 5, action: "apply",
    destination: { type: "local", localDir: "/var/backups/featherspress" },
    keepLast: 14, schedule: { preset: "daily", timeOfDay: "00:24" },
  }));
  assert.doesNotThrow(() => bc.applyRequest(env));
  const status = JSON.parse(fs.readFileSync(env.BACKUP_STATUS, "utf8"));
  assert.strictEqual(status.appliedRequestId, 5, "appliedRequestId must still advance");
  assert.strictEqual(status.lastRequestOk, false);
  assert.ok(status.lastRequestError, "must report an error, not just wedge silently");
  assert.ok(
    !status.lastRequestError.includes("age1xxx"),
    "must never echo the offending value"
  );
});

test("apply refreshes status even when there is no pending request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bc-norq-"));
  const env = {
    BACKUP_ENV: path.join(dir, "backup.env"),
    BACKUP_REQUEST: path.join(dir, "nope.json"),      // deliberately absent
    BACKUP_STATUS: path.join(dir, "backup-status.json"),
    LAST_RUN_FILE: path.join(dir, "last-run.json"),
    SCHEDULE_DROPIN: path.join(dir, "schedule.conf"),
  };
  fs.writeFileSync(env.BACKUP_ENV, "DEST_TYPE=local\nLOCAL_DIR=/var/backups/x\nKEEP_LAST=7\n");
  bc.applyRequest(env);
  const status = JSON.parse(fs.readFileSync(env.BACKUP_STATUS, "utf8"));
  assert.strictEqual(status.config.keepLast, 7);
  // env has no UPDATE_CONF and no update.conf file exists on disk for this test
  // dir — refreshStatus must still produce a well-formed update block, not null.
  assert.deepStrictEqual(status.update, { autoApply: false, repoRef: "main" });
  assert.strictEqual(status.ageRecipient, null);
});

// ---- restore request validation -------------------------------------------
// stagedName is joined to the staging dir, so anything but a bare filename would
// aim the import at an arbitrary file. Errors must be fixed strings.

const RCTX = { appliedRestoreId: 4 };
const rbase = { requestId: 5, stagedName: "abc123.tar.gz", sections: ["content"] };

test("accepts a well-formed restore request", () => {
  const r = bc.validateRestoreRequest(rbase, RCTX);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.config.sections, ["content"]);
  assert.strictEqual(r.config.stagedName, "abc123.tar.gz");
});

test("rejects a stale restore requestId", () => {
  assert.strictEqual(bc.validateRestoreRequest({ ...rbase, requestId: 4 }, RCTX).ok, false);
});

test("rejects a stagedName that is not a bare filename", () => {
  for (const bad of ["../../etc/passwd", "a/b.tar.gz", "..", ".", "/abs.tar.gz", "", "x\\y"]) {
    const r = bc.validateRestoreRequest({ ...rbase, stagedName: bad }, RCTX);
    assert.strictEqual(r.ok, false, `must reject ${JSON.stringify(bad)}`);
    assert.doesNotMatch(r.error, /passwd|etc/, "error must not echo the input");
  }
});

test("rejects unknown or empty restore sections", () => {
  assert.strictEqual(bc.validateRestoreRequest({ ...rbase, sections: ["etc"] }, RCTX).ok, false);
  assert.strictEqual(bc.validateRestoreRequest({ ...rbase, sections: [] }, RCTX).ok, false);
  assert.strictEqual(bc.validateRestoreRequest({ ...rbase, sections: "content" }, RCTX).ok, false);
});

test("restoreAuth requires the credentials section", () => {
  const a = bc.validateRestoreRequest({ ...rbase, restoreAuth: true }, RCTX);
  assert.strictEqual(a.config.restoreAuth, false, "restoreAuth without the section must not stick");
  const b = bc.validateRestoreRequest(
    { ...rbase, sections: ["content", "credentials"], restoreAuth: true }, RCTX);
  assert.strictEqual(b.config.restoreAuth, true);
});

test("buildStatus carries the restore state", () => {
  const s = bc.buildStatus({
    writtenAt: "2026-07-25T00:00:00Z",
    restore: { state: "rolled-back", error: "did not come up" },
  });
  assert.strictEqual(s.restore.state, "rolled-back");
});
