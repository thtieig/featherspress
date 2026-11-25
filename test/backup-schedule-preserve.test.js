"use strict";

// "Back up now" (and "Save") must not change the backup schedule. This drives
// the full loop a real "Back up now" click drives, not just the router:
//
//   1. seed backup-status.json (what the app/router read) describing a
//      configured weekly Sunday 03:00 schedule;
//   2. log in and POST /api/backup-run, exactly as the "Back up now" button
//      does — the router forwards whatever status says;
//   3. feed the request the app just wrote to the real root-side
//      bc.applyRequest(), pointed at agent-owned files (timer drop-in +
//      backup.env) seeded with a DIFFERENT schedule (daily 09:15);
//   4. assert the drop-in STILL reads daily 09:15.
//
// The mismatch in step 3 is deliberate: if the agent's files already matched
// the request, rewriting them for run-now would be a byte-identical no-op and
// the test would pass even without applyRequest's `action === "apply"` guard.
// We also pin the request's shape: no `raw` key leaking from status into it.
//
// Isolated content/media/auth/backup files, own recovery code, so this cannot
// interfere with test/admin.test.js's login state or backup files.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

// Isolated content/media/auth: set BEFORE requiring config/server.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bksched-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";

const PASSWORD = "scheduletestpw456";
const RECOVERY = "wxyz-9876";
fs.writeFileSync(
  process.env.AUTH_CONFIG,
  JSON.stringify({
    passwordHash: bcrypt.hashSync(PASSWORD, 8),
    totpSecret: "JBSWY3DPEHPK3PXP",
    recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
  })
);

const app = require("../server");
const config = require("../config");
const bc = require("../tools/backup-control");

let base;
let server;
let cookie = "";

async function api(method, p, body, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, cookie ? { cookie } : {});
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
}

test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("run-now round-trips through the real root agent without touching the schedule drop-in", async () => {
  const res = await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  assert.strictEqual(res.status, 200, await res.text());
  assert.ok(cookie.includes("connect.sid"));

  // Seed backup-status.json as the root agent would have written it: a
  // weekly Sunday 03:00 schedule already configured and applied.
  fs.writeFileSync(
    config.BACKUP_STATUS_FILE,
    JSON.stringify({
      schemaVersion: 1,
      writtenAt: new Date().toISOString(),
      appliedRequestId: 5,
      lastRequestOk: true,
      lastRequestError: null,
      config: {
        destType: "local",
        localDir: "/var/backups/featherspress",
        remote: null,
        remotePath: null,
        keepLast: 14,
        schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun", raw: "Sun *-*-* 03:00:00" },
      },
      encrypted: false,
      availableRemotes: [],
      lastRun: null,
      nextRun: null,
      artifactCount: 0,
    })
  );

  // Seed the root agent's OWN files — the timer drop-in and backup.env —
  // with a DIFFERENT schedule (daily 09:15) than status/the request
  // describe (weekly Sun 03:00). See the file-header comment for why this
  // mismatch is deliberate: it's what makes "the drop-in is unchanged" an
  // assertion that actually depends on the applyRequest guard, rather than
  // one that would pass by coincidence because rewriting-with-the-same-value
  // is a no-op. These are the files applyRequest reads/writes; they are NOT
  // the app's status/request files, so they get their own temp dir,
  // mirroring how root actually keeps them separate from the app-writable
  // data dir.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bksched-agent-"));
  const agentEnv = {
    BACKUP_ENV: path.join(agentDir, "backup.env"),
    BACKUP_REQUEST: config.BACKUP_REQUEST_FILE,
    BACKUP_STATUS: config.BACKUP_STATUS_FILE,
    LAST_RUN_FILE: path.join(agentDir, "last-run.json"),
    SCHEDULE_DROPIN: path.join(agentDir, "dropin", "schedule.conf"),
  };
  fs.mkdirSync(path.dirname(agentEnv.SCHEDULE_DROPIN), { recursive: true });
  fs.writeFileSync(agentEnv.SCHEDULE_DROPIN, "[Timer]\nOnCalendar=\nOnCalendar=*-*-* 09:15:00\n");
  fs.writeFileSync(
    agentEnv.BACKUP_ENV,
    "DEST_TYPE=local\nLOCAL_DIR=/var/backups/featherspress\nKEEP_LAST=14\n" +
      "BACKUP_SCHEDULE_PRESET=daily\nBACKUP_SCHEDULE_TIME=09:15\n"
  );

  try {
    // "Back up now": the unprivileged app writes a run-now request describing
    // the CURRENT config (read from backup-status.json) — it must never
    // invent its own schedule.
    const run = await api("POST", "/admin/api/backup-run", {});
    assert.strictEqual(run.status, 200, await run.text());

    const written = JSON.parse(fs.readFileSync(config.BACKUP_REQUEST_FILE, "utf8"));
    assert.strictEqual(written.action, "run-now");
    assert.strictEqual(written.schedule.preset, "weekly");
    assert.strictEqual(written.schedule.timeOfDay, "03:00");
    assert.strictEqual(written.schedule.weekday, "Sun");
    assert.strictEqual(
      bc.buildOnCalendar(written.schedule),
      "Sun *-*-* 03:00:00",
      "the request the app wrote must still describe the configured Sunday 03:00 schedule, not the daily 00:20 default"
    );
    // The router's shape cleanup: status.config.schedule carries a `raw`
    // field (the systemd OnCalendar string); the request it writes must not
    // forward that stray field.
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(written.schedule, "raw"),
      false,
      "the run-now request's schedule must not carry the status-only `raw` field"
    );

    // Now drive the request the app just wrote through the REAL root agent —
    // this is the invariant that actually matters. applyRequest's systemctl
    // calls (daemon-reload/restart for "apply"; start --no-block for
    // "run-now") are wrapped in try/catch; on this dev box there are no
    // featherspress-backup.* units installed, so `systemctl start --no-block
    // featherspress-backup.service` throws (unit not found) and is silently
    // swallowed — confirmed by hand while writing this test (no exception
    // escapes bc.applyRequest here). That's fine: the assertion that matters
    // is the drop-in content, not whether systemctl itself succeeded.
    bc.applyRequest(agentEnv);

    assert.match(
      fs.readFileSync(agentEnv.SCHEDULE_DROPIN, "utf8"),
      /\*-\*-\* 09:15:00/,
      "run-now must leave the drop-in's pre-existing schedule alone, even though the request " +
        "it received (weekly Sun 03:00, forwarded faithfully from status) differs from it"
    );
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("run-now on a box with no saved schedule asks for daily at 00:20, the shipped timer's time", async () => {
  if (!cookie) await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  fs.writeFileSync(
    config.BACKUP_STATUS_FILE,
    JSON.stringify({ appliedRequestId: 1, config: { destType: "local", keepLast: 14, schedule: { preset: null } } })
  );
  const run = await api("POST", "/admin/api/backup-run", {});
  assert.strictEqual(run.status, 200, await run.text());
  const written = JSON.parse(fs.readFileSync(config.BACKUP_REQUEST_FILE, "utf8"));
  assert.deepStrictEqual(written.schedule, { preset: "daily", timeOfDay: "00:20", weekday: null });
});
