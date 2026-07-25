"use strict";

// End-to-end restore, in-repo: /admin upload -> /admin restore request -> the
// ROOT agent's restoreRequest(), against temp dirs.
//
// Until now the only integration coverage for this path was a hardware drill on
// a real VPS, which does not run in CI — and the drill has twice caught things
// the unit tests could not see. Everything here is real except the two commands
// that need a machine: `systemctl` and `curl` are stubbed on PATH, so the health
// check's verdict is something the test decides. Node, site-package.js and tar
// are the genuine article, so the archive really is packed, unpacked and
// re-owned.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-restore-int-"));

// Give this test its OWN tmpdir. The pre-restore snapshot goes to os.tmpdir(),
// which is shared with every other test file running in parallel — asserting on
// the global /tmp made this test fail depending on what else was running.
// os.tmpdir() re-reads TMPDIR on every call, and child processes inherit it.
process.env.TMPDIR = fs.mkdtempSync(path.join(TMP, "tmpdir-"));

// ---- the LIVE site the app serves and the agent will overwrite -------------
const LIVE = path.join(TMP, "live");
const STAGING = path.join(LIVE, "import-staging");
fs.mkdirSync(path.join(LIVE, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(LIVE, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(LIVE, "media"), { recursive: true });
fs.writeFileSync(path.join(LIVE, "content", "posts", "original.md"),
  "---\ntitle: Original Post\ndate: 2026-01-01\n---\n\nthe site as it was\n");
fs.writeFileSync(path.join(LIVE, "site.json"),
  JSON.stringify({ title: "Live Site", skin: "notepad", homeMode: "feed" }, null, 2));

const PASSWORD = "restore-int-password";
const RECOVERY = "aaaa-1111";
fs.writeFileSync(path.join(LIVE, "auth-config.json"), JSON.stringify({
  passwordHash: bcrypt.hashSync(PASSWORD, 8),
  totpSecret: "JBSWY3DPEHPK3PXP",
  recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
}));

process.env.CONTENT_DIR = path.join(LIVE, "content");
process.env.MEDIA_DIR = path.join(LIVE, "media");
process.env.AUTH_CONFIG = path.join(LIVE, "auth-config.json");
process.env.SITE_MANIFEST = path.join(LIVE, "site.json");
process.env.IMPORT_STAGING_DIR = STAGING;
process.env.BACKUP_STATUS_FILE = path.join(LIVE, "backup-status.json");
process.env.BACKUP_REQUEST_FILE = path.join(LIVE, "backup-request.json");
process.env.RESTORE_REQUEST_FILE = path.join(LIVE, "restore-request.json");

const config = require("../config");
const app = require("../server");
const bc = require("../tools/backup-control");
const { exportPackage } = require("../tools/site-package");

// The env file both the app and the agent resolve the data dir through.
const FP_ENV = path.join(TMP, "featherspress.env");
fs.writeFileSync(FP_ENV, [
  `CONTENT_DIR=${process.env.CONTENT_DIR}`,
  `MEDIA_DIR=${process.env.MEDIA_DIR}`,
  `AUTH_CONFIG=${process.env.AUTH_CONFIG}`,
  `SITE_MANIFEST=${process.env.SITE_MANIFEST}`,
  `PORT=8787`,
  "",
].join("\n"));

// ---- stub systemctl + curl on PATH ----------------------------------------
// `curl` is the health check. It reads a control file, so a test can make the
// restored site "come up" or not and watch the agent decide.
const BIN = path.join(TMP, "bin");
const FAILS = path.join(TMP, "curl-fails-left"); // how many health checks still fail
const CALLS = path.join(TMP, "curl-calls");
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
// Counting, so one run can fail the restore's health check and then let the
// ROLLBACK's succeed — which is the only way to reach the "your previous site
// was put back" branch rather than the harsher both-failed one.
fs.writeFileSync(path.join(BIN, "curl"), `#!/bin/sh
n=$(cat "${FAILS}" 2>/dev/null || echo 0)
echo x >> "${CALLS}"
if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${FAILS}"; exit 22; fi
exit 0
`, { mode: 0o755 });
const healthFails = (n) => fs.writeFileSync(FAILS, String(n));
// `sleep` too: siteHealthy retries ten times with a 2s pause, and the rollback
// test deliberately fails every one of them.
fs.writeFileSync(path.join(BIN, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PATH = BIN + path.delimiter + process.env.PATH;

const agentEnv = () => ({
  BACKUP_ENV: path.join(TMP, "backup.env"),
  BACKUP_REQUEST: config.BACKUP_REQUEST_FILE,
  BACKUP_STATUS: config.BACKUP_STATUS_FILE,
  LAST_RUN_FILE: path.join(TMP, "last-run.json"),
  SCHEDULE_DROPIN: path.join(TMP, "dropin", "schedule.conf"),
  RESTORE_REQUEST: config.RESTORE_REQUEST_FILE,
  IMPORT_STAGING: STAGING,
  FP_ENV,
  ENGINE_DIR: ROOT,
  SERVICE: "featherspress",
  NODE_BIN: process.execPath,
  UPDATE_CONF: path.join(TMP, "update.conf"),
});

// ---- a DISTINCT source site to restore from -------------------------------
function buildSourceArchive(name, over = {}) {
  const src = fs.mkdtempSync(path.join(TMP, "source-"));
  fs.mkdirSync(path.join(src, "content", "posts"), { recursive: true });
  fs.mkdirSync(path.join(src, "content", "pages"), { recursive: true });
  fs.mkdirSync(path.join(src, "media", "2026", "01"), { recursive: true });
  fs.writeFileSync(path.join(src, "content", "posts", "migrated.md"),
    "---\ntitle: Migrated Post\ndate: 2026-02-02\n---\n\nfrom the other box\n");
  fs.writeFileSync(path.join(src, "media", "2026", "01", "pic.txt"), "media payload");
  const manifestPath = path.join(src, "site.json");
  fs.writeFileSync(manifestPath, JSON.stringify(
    { title: "Source Site", skin: "notepad", homeMode: "feed", ...over }, null, 2));
  const authPath = path.join(src, "auth-config.json");
  fs.writeFileSync(authPath, JSON.stringify({
    passwordHash: bcrypt.hashSync("the-source-password", 8),
    totpSecret: "KRSXG5CTMVRXEZLU",
    recoveryCodeHashes: [],
  }));
  const out = path.join(TMP, name);
  exportPackage({
    contentDir: path.join(src, "content"),
    mediaDir: path.join(src, "media"),
    manifestPath,
    authConfigPath: authPath,
    profile: "full",
    outFile: out,
  });
  return out;
}

let base;
let server;
let cookie = "";

async function api(method, p, body) {
  const headers = cookie ? { cookie } : {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
}

// Drive the two real /admin endpoints, exactly as the browser does.
async function uploadAndRequest(archivePath, sections) {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(archivePath)]), path.basename(archivePath));
  const up = await api("POST", "/admin/api/import-upload", fd);
  // Read the body ONCE: assert's message argument is evaluated eagerly, so
  // `await up.text()` inline would consume it even when the assertion passes.
  const upBody = await up.text();
  assert.strictEqual(up.status, 200, upBody);
  const { stagedName } = JSON.parse(upBody);
  assert.ok(fs.existsSync(path.join(STAGING, stagedName)), "the upload must be staged on disk");

  const rq = await api("POST", "/admin/api/restore", { stagedName, sections });
  const rqBody = await rq.text();
  assert.strictEqual(rq.status, 200, rqBody);
  const { requestId } = JSON.parse(rqBody);
  assert.ok(fs.existsSync(config.RESTORE_REQUEST_FILE), "the app must write a restore request");
  return { stagedName, requestId };
}

const restoreState = () =>
  JSON.parse(fs.readFileSync(config.BACKUP_STATUS_FILE, "utf8")).restore;

const livePosts = () => fs.readdirSync(path.join(LIVE, "content", "posts")).sort();
const liveTitle = () => JSON.parse(fs.readFileSync(path.join(LIVE, "site.json"), "utf8")).title;

test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  assert.strictEqual(res.status, 200, await res.text());

});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const snapshotDirs = () =>
  fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("featherspress-prerestore-"));

test("a healthy restore replaces the site and reports done", async () => {
  const snapsBefore = snapshotDirs();
  healthFails(0); // the restarted site renders
  const archive = buildSourceArchive("good.tar.gz");
  const { stagedName, requestId } = await uploadAndRequest(archive,
    ["content", "media", "site", "credentials"]);

  bc.restoreRequest(agentEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "done", `restore said ${st.state}: ${st.error}`);
  assert.strictEqual(st.appliedRequestId, requestId);

  assert.deepStrictEqual(livePosts(), ["migrated.md"], "the source's content must have replaced the live site's");
  assert.strictEqual(liveTitle(), "Source Site");
  assert.ok(fs.existsSync(path.join(LIVE, "media", "2026", "01", "pic.txt")), "media must land too");
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(LIVE, "auth-config.json"), "utf8")).totpSecret,
    "KRSXG5CTMVRXEZLU",
    "credentials in the section list must actually migrate"
  );

  assert.strictEqual(fs.existsSync(path.join(STAGING, stagedName)), false, "the staged archive must be cleaned up");
  assert.strictEqual(fs.existsSync(config.RESTORE_REQUEST_FILE), false, "the request must be consumed");
  assert.deepStrictEqual(
    snapshotDirs().filter((d) => !snapsBefore.includes(d)), [],
    "the pre-restore snapshot must not be left behind"
  );
});

test("a restore that leaves the site unable to render is rolled back", async () => {
  // Put a known state back, so what the rollback restores is unambiguous.
  healthFails(0);
  const known = buildSourceArchive("known.tar.gz", { title: "Known Good" });
  await uploadAndRequest(known, ["content", "media", "site"]);
  bc.restoreRequest(agentEnv());
  assert.strictEqual(restoreState().state, "done");
  const before = livePosts();
  assert.strictEqual(liveTitle(), "Known Good");

  // Now the site refuses to come up after the restart. siteHealthy gives it ten
  // tries, so fail exactly those ten and let the rollback's check pass.
  healthFails(10);
  const bad = buildSourceArchive("bad.tar.gz", { title: "Breaks Rendering" });
  const { stagedName, requestId } = await uploadAndRequest(bad, ["content", "media", "site"]);

  bc.restoreRequest(agentEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "rolled-back", `expected a rollback, got ${st.state}`);
  assert.strictEqual(st.appliedRequestId, requestId);
  assert.match(st.error, /did not come up/);
  assert.match(st.error, /previous site was put back/,
    "with the rollback itself unverifiable, the operator must not be told it worked");

  assert.strictEqual(liveTitle(), "Known Good", "the pre-restore site must be back");
  assert.deepStrictEqual(livePosts(), before);
  assert.strictEqual(fs.existsSync(path.join(STAGING, stagedName)), false);
  assert.strictEqual(fs.existsSync(config.RESTORE_REQUEST_FILE), false);
});

test("a restore request naming a staged file that is not there fails without touching the site", async () => {
  healthFails(0);
  const before = livePosts();
  const title = liveTitle();
  fs.writeFileSync(config.RESTORE_REQUEST_FILE, JSON.stringify({
    requestId: restoreState().appliedRequestId + 1,
    stagedName: "nothing-here.tar.gz", sections: ["content"],
  }), { mode: 0o600 });

  bc.restoreRequest(agentEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "failed");
  assert.match(st.error, /not found/);
  assert.deepStrictEqual(livePosts(), before);
  assert.strictEqual(liveTitle(), title);
  assert.strictEqual(fs.existsSync(config.RESTORE_REQUEST_FILE), false);
});

test("a stale restore request is refused, so a re-run cannot restore twice", async () => {
  healthFails(0);
  const applied = restoreState().appliedRequestId;
  fs.writeFileSync(config.RESTORE_REQUEST_FILE, JSON.stringify({
    requestId: 1, stagedName: "whatever.tar.gz", sections: ["content"],
  }), { mode: 0o600 });

  bc.restoreRequest(agentEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "failed");
  assert.match(st.error, /stale or invalid requestId/);
  assert.ok(st.appliedRequestId <= applied || st.appliedRequestId === 1);
});

test("the settings section carries the source's schedule and age recipient", async () => {
  healthFails(0);
  const recipient = "age1qkq20rc7vsnstc49kwhdttql6sglpfwcpnp2mwz6080eurn42ypqqh20ys";
  const env = agentEnv();
  fs.rmSync(env.BACKUP_ENV, { force: true });

  // An archive whose settings.json describes the OLD box's backup config.
  const src = fs.mkdtempSync(path.join(TMP, "settings-src-"));
  fs.mkdirSync(path.join(src, "content", "posts"), { recursive: true });
  fs.writeFileSync(path.join(src, "content", "posts", "s.md"),
    "---\ntitle: S\ndate: 2026-03-03\n---\n\nx\n");
  const manifestPath = path.join(src, "site.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ title: "Settings Source", skin: "notepad" }));
  const out = path.join(TMP, "settings.tar.gz");
  exportPackage({
    contentDir: path.join(src, "content"),
    manifestPath,
    profile: "full",
    outFile: out,
    settings: {
      schemaVersion: 1,
      backup: {
        destType: "local", localDir: "/var/backups/featherspress", keepLast: 21,
        schedule: { preset: "weekly", timeOfDay: "05:45", weekday: "Tue" },
        sections: ["content", "media", "site", "settings", "credentials"],
        ageRecipient: recipient,
      },
    },
  });

  await uploadAndRequest(out, ["content", "site", "settings"]);
  bc.restoreRequest(env);

  assert.strictEqual(restoreState().state, "done");
  const written = fs.readFileSync(env.BACKUP_ENV, "utf8");
  assert.match(written, /^KEEP_LAST=21$/m);
  assert.match(written, /^BACKUP_SCHEDULE_PRESET=weekly$/m);
  assert.match(written, /^BACKUP_SCHEDULE_WEEKDAY=Tue$/m);
  assert.match(written, new RegExp(`^AGE_RECIPIENT=${recipient}$`, "m"),
    "a migrated box that loses the recipient starts writing plaintext credentials");
  assert.match(fs.readFileSync(env.SCHEDULE_DROPIN, "utf8"), /OnCalendar=Tue \*-\*-\* 05:45:00/);
});
