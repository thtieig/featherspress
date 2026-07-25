"use strict";

// End-to-end reproduction for bugs #1/#2: "Back up now" (and "Save") reset
// the backup schedule. This drives the FULL loop — the same one a real
// "Back up now" click drives — not just the router in isolation:
//
//   1. seed backup-status.json (what the app/router read) describing a
//      configured weekly Sunday 03:00 schedule;
//   2. log in and POST /api/backup-run, exactly as the "Back up now" button
//      does — the router forwards whatever status says;
//   3. take the request the (unprivileged) app just wrote and feed it to the
//      real root-side bc.applyRequest(), the same way
//      test/backup-control.test.js drives it — but pointed at agent-owned
//      files (timer drop-in + backup.env) seeded with a DIFFERENT schedule
//      (daily 09:15);
//   4. assert the drop-in STILL reads the original daily 09:15, i.e.
//      unaffected by what the run-now request carried.
//
// Step 3's seeded mismatch is deliberate, not an oversight: if the agent's
// files were seeded to already match the request's schedule (both weekly Sun
// 03:00), rewriting them for run-now would be a byte-identical no-op whether
// or not the applyRequest guard exists — verified by hand: removing the
// `if (v.config.action === "apply")` guard and reseeding with matching
// values still left this test green. Only a genuine mismatch makes "the
// drop-in is unchanged" a meaningful, guard-dependent assertion: if the
// guard regresses, applyRequest overwrites the drop-in with the *request's*
// schedule (weekly Sun 03:00) and this test fails.
//
// The router alone forwarding the right schedule is not, by itself, the bug
// fix — cur.schedule && cur.schedule.preset ? cur.schedule : ... already
// forwarded the right thing once Task 1 gave status a structured schedule,
// with or without this task's router edit. The actual bug is in
// applyRequest, which used to rewrite the systemd drop-in for EVERY valid
// request including run-now; that's what steps 3-4 above pin. We also pin
// the router's request shape (no stray `raw` key leaking from status into
// the request) since that's a real, if lesser, cleanup this task made.
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
      "the request the app wrote must still describe the configured Sunday 03:00 schedule, not the daily 00:24 default"
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
