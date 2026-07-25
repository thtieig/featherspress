"use strict";

// Reproduction for bug #1: "Back up now" sent a hardcoded daily 00:24 schedule
// with every run-now request because the router didn't know the real,
// configured schedule. Task 1 made backup-status.json carry a structured
// config.schedule; this drives /api/backup-run over HTTP against a seeded
// status file and asserts the resulting request still describes a weekly
// Sun 03:00 schedule, not the hardcoded default.
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

test("run-now sends the real configured schedule, not the hardcoded default", async () => {
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
    "run-now must still describe the configured Sunday 03:00 schedule, not the daily 00:24 default"
  );
});
