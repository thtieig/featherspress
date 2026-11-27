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
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";
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
// systemctl logs what it was asked, so a test can check WHICH site restarted.
const SYSTEMCTL_LOG = path.join(TMP, "systemctl-calls");
fs.writeFileSync(path.join(BIN, "systemctl"), `#!/bin/sh\necho "$*" >> "${SYSTEMCTL_LOG}"\nexit 0\n`, { mode: 0o755 });
const systemctlCalls = () => {
  const lines = fs.existsSync(SYSTEMCTL_LOG) ? fs.readFileSync(SYSTEMCTL_LOG, "utf8").trim().split("\n") : [];
  fs.rmSync(SYSTEMCTL_LOG, { force: true });
  return lines;
};
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
  // The live site is instance "alpha" on a server that also runs others.
  SERVICE: "featherspress@alpha",
  BACKUP_UNIT: "featherspress-backup@alpha",
  BACKUP_ROOT: "/var/backups/featherspress/alpha",
  NODE_BIN: process.execPath,
  UPDATE_CONF: path.join(TMP, "update.conf"),
});

// ---- a DISTINCT source site to restore from -------------------------------

// Deliberately NOT base32: nothing here ever verifies a token against this, it
// is only round-tripped and compared, and a real-looking seed in the source
// makes secret scanners cry wolf.
const SOURCE_TOTP_SENTINEL = "not-a-real-totp-secret";

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
    totpSecret: SOURCE_TOTP_SENTINEL,
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

  systemctlCalls();
  bc.restoreRequest(agentEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "done", `restore said ${st.state}: ${st.error}`);
  assert.strictEqual(st.appliedRequestId, requestId);
  assert.deepStrictEqual(systemctlCalls().filter((c) => !c.startsWith("show ")), ["restart featherspress@alpha"],
    "a restore restarts this site only");

  assert.deepStrictEqual(livePosts(), ["migrated.md"], "the source's content must have replaced the live site's");
  assert.strictEqual(liveTitle(), "Source Site");
  assert.ok(fs.existsSync(path.join(LIVE, "media", "2026", "01", "pic.txt")), "media must land too");
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(LIVE, "auth-config.json"), "utf8")).totpSecret,
    SOURCE_TOTP_SENTINEL,
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
  const recipient = "age1z7nvtfksch6luzwd0lf2awt54t8qweq0jjntdtd5utam02kthfpqg8nhaj";
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
  systemctlCalls();
  bc.restoreRequest(env);

  assert.strictEqual(restoreState().state, "done");
  const calls = systemctlCalls();
  assert.ok(calls.includes("restart featherspress-backup@alpha.timer"), calls.join("\n"));
  assert.deepStrictEqual(calls.filter((c) => /restart/.test(c) && !/@alpha\b/.test(c)), [],
    "only this site's units may be restarted");
  const written = fs.readFileSync(env.BACKUP_ENV, "utf8");
  assert.match(written, /^LOCAL_DIR=\/var\/backups\/featherspress\/alpha$/m,
    "the old box's single-site folder becomes this site's own");
  assert.match(written, /^KEEP_LAST=21$/m);
  assert.match(written, /^BACKUP_SCHEDULE_PRESET=weekly$/m);
  assert.match(written, /^BACKUP_SCHEDULE_WEEKDAY=Tue$/m);
  assert.match(written, new RegExp(`^AGE_RECIPIENT=${recipient}$`, "m"),
    "a migrated box that loses the recipient starts writing plaintext credentials");
  assert.match(fs.readFileSync(env.SCHEDULE_DROPIN, "utf8"), /OnCalendar=Tue \*-\*-\* 05:45:00/);
});

// An archive that carries a settings.json describing a different backup setup.
function settingsArchive(name, title) {
  const src = fs.mkdtempSync(path.join(TMP, "settings-src-"));
  fs.mkdirSync(path.join(src, "content", "posts"), { recursive: true });
  fs.writeFileSync(path.join(src, "content", "posts", "s.md"),
    "---\ntitle: S\ndate: 2026-03-03\n---\n\nx\n");
  const manifestPath = path.join(src, "site.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ title, skin: "notepad" }));
  const out = path.join(TMP, name);
  exportPackage({
    contentDir: path.join(src, "content"),
    manifestPath,
    profile: "full",
    outFile: out,
    settings: {
      schemaVersion: 1,
      backup: {
        destType: "local", localDir: "/var/backups/featherspress", keepLast: 30,
        schedule: { preset: "weekly", timeOfDay: "03:15", weekday: "Fri" },
      },
    },
  });
  return out;
}

test("an import that fails half-way puts the previous site back", async () => {
  healthFails(0);
  const known = buildSourceArchive("before-half.tar.gz", { title: "Before Half" });
  await uploadAndRequest(known, ["content", "media", "site"]);
  bc.restoreRequest(agentEnv());
  assert.strictEqual(restoreState().state, "done");
  const posts = livePosts();
  assert.ok(fs.existsSync(path.join(LIVE, "media", "2026", "01", "pic.txt")));

  // A node that, for the import of the STAGED archive only, wrecks the site the
  // way a full disk mid-copy would, then fails. The snapshot export and the
  // rollback import go to the real node.
  const wrapper = path.join(TMP, "half-import-node");
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$*" in
  *" import "*incoming.tar.gz*)
    rm -rf "${path.join(LIVE, "media")}"
    rm -f "${path.join(LIVE, "content", "posts")}"/*
    echo broken > "${path.join(LIVE, "content", "posts", "half.md")}"
    exit 1;;
esac
exec "${process.execPath}" "$@"
`, { mode: 0o755 });
  const env = { ...agentEnv(), NODE_BIN: wrapper };
  fs.rmSync(env.BACKUP_ENV, { force: true }); // so NODE_BIN comes from env
  const other = buildSourceArchive("half.tar.gz", { title: "Never Lands" });
  const { stagedName } = await uploadAndRequest(other, ["content", "media", "site"]);
  systemctlCalls();

  bc.restoreRequest(env);

  const st = restoreState();
  assert.strictEqual(st.state, "rolled-back", `expected a rollback, got ${st.state}: ${st.error}`);
  assert.match(st.error, /could not be restored/);
  assert.match(st.error, /previous site was put back/);
  assert.deepStrictEqual(livePosts(), posts, "the content from before the restore must be back");
  assert.strictEqual(liveTitle(), "Before Half");
  assert.ok(fs.existsSync(path.join(LIVE, "media", "2026", "01", "pic.txt")), "deleted media must be back");
  assert.ok(systemctlCalls().includes("restart featherspress@alpha"), "the put-back site must be restarted");
  assert.strictEqual(fs.existsSync(path.join(STAGING, stagedName)), false);
});

test("a rollback on a site that had no site.json leaves it without one", async () => {
  // A fresh install has no site.json until something writes one. A restore
  // that wrote one and then failed must not leave it behind: it can name a
  // skin that is not there, and the site would not start.
  healthFails(0);
  const manifest = path.join(LIVE, "site.json");
  const saved = fs.readFileSync(manifest);
  fs.rmSync(manifest);
  try {
    const wrapper = path.join(TMP, "manifest-then-fail-node");
    fs.writeFileSync(wrapper, `#!/bin/sh
case "$*" in
  *" import "*incoming.tar.gz*)
    echo '{"title":"Broken","skin":"no-such-skin"}' > "${manifest}"
    exit 1;;
esac
exec "${process.execPath}" "$@"
`, { mode: 0o755 });
    const env = { ...agentEnv(), NODE_BIN: wrapper };
    fs.rmSync(env.BACKUP_ENV, { force: true });
    await uploadAndRequest(buildSourceArchive("manifest-fail.tar.gz"), ["content", "site"]);

    bc.restoreRequest(env);

    const st = restoreState();
    assert.strictEqual(st.state, "rolled-back", st.error);
    assert.match(st.error, /previous site was put back/);
    assert.strictEqual(fs.existsSync(manifest), false, "the site.json the failed restore wrote must be gone");
  } finally {
    fs.writeFileSync(manifest, saved);
  }
});

test("a rolled-back restore also puts the backup settings back", async () => {
  healthFails(0);
  const env = agentEnv();
  const beforeEnv = "LOCAL_DIR=/var/backups/featherspress/alpha\nKEEP_LAST=5\n";
  const beforeDropin = "[Timer]\nOnCalendar=\nOnCalendar=*-*-* 00:20:00\n";
  fs.writeFileSync(env.BACKUP_ENV, beforeEnv, { mode: 0o600 });
  fs.mkdirSync(path.dirname(env.SCHEDULE_DROPIN), { recursive: true });
  fs.writeFileSync(env.SCHEDULE_DROPIN, beforeDropin);

  healthFails(10); // the restored site never comes up; the rollback's check passes
  await uploadAndRequest(settingsArchive("settings-bad.tar.gz", "Settings Bad"), ["content", "site", "settings"]);
  systemctlCalls();
  bc.restoreRequest(env);

  assert.strictEqual(restoreState().state, "rolled-back");
  assert.strictEqual(fs.readFileSync(env.BACKUP_ENV, "utf8"), beforeEnv,
    "the archive's backup settings must not outlive the rollback");
  assert.strictEqual(fs.readFileSync(env.SCHEDULE_DROPIN, "utf8"), beforeDropin);
  const restarts = systemctlCalls().filter((c) => c === "restart featherspress-backup@alpha.timer");
  assert.strictEqual(restarts.length, 2, "the timer must be reloaded with the old schedule too");
});

test("an upload clears staged files abandoned for over an hour, and keeps recent ones", async () => {
  fs.mkdirSync(STAGING, { recursive: true });
  const old = path.join(STAGING, "abandoned.tar.gz");
  const recent = path.join(STAGING, "recent.tar.gz");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(recent, "y");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(buildSourceArchive("fresh.tar.gz"))]), "fresh.tar.gz");
  const up = await api("POST", "/admin/api/import-upload", fd);
  const upBody = await up.text();
  assert.strictEqual(up.status, 200, upBody);
  assert.strictEqual(fs.existsSync(old), false, "the abandoned upload must be gone");
  assert.strictEqual(fs.existsSync(recent), true, "a recent one is kept");
  fs.rmSync(recent, { force: true });
  fs.rmSync(path.join(STAGING, JSON.parse(upBody).stagedName), { force: true });
});

test("a staged name that is a symlink is not followed, and nothing is touched", async () => {
  healthFails(0);
  const before = livePosts();
  // An archive outside the staging dir (another site's backup, say), linked in.
  const elsewhere = buildSourceArchive("elsewhere.tar.gz", { title: "Somebody Else" });
  fs.mkdirSync(STAGING, { recursive: true });
  const link = path.join(STAGING, "linked.tar.gz");
  fs.symlinkSync(elsewhere, link);
  fs.writeFileSync(config.RESTORE_REQUEST_FILE, JSON.stringify({
    requestId: restoreState().appliedRequestId + 1,
    stagedName: "linked.tar.gz", sections: ["content", "site"],
  }), { mode: 0o600 });

  bc.restoreRequest(agentEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "failed");
  assert.match(st.error, /staged archive not found/);
  assert.deepStrictEqual(livePosts(), before);
  assert.notStrictEqual(liveTitle(), "Somebody Else");
  assert.ok(fs.existsSync(elsewhere), "the link's target must not be deleted");
  fs.rmSync(link, { force: true });
});

test("a staged name that is a directory is refused", async () => {
  healthFails(0);
  const before = livePosts();
  fs.mkdirSync(path.join(STAGING, "a-dir.tar.gz", "content", "posts"), { recursive: true });
  fs.writeFileSync(config.RESTORE_REQUEST_FILE, JSON.stringify({
    requestId: restoreState().appliedRequestId + 1,
    stagedName: "a-dir.tar.gz", sections: ["content"],
  }), { mode: 0o600 });

  bc.restoreRequest(agentEnv());

  assert.strictEqual(restoreState().state, "failed");
  assert.deepStrictEqual(livePosts(), before);
  fs.rmSync(path.join(STAGING, "a-dir.tar.gz"), { recursive: true, force: true });
});

// ---- the backups list: restore and download a backup kept on this server ----
// The site's own backup folder is group-readable by the site user (0750
// root:fp-<name>, files 0640), so the app lists and serves it directly; the
// agent takes a plaintext backup straight from that folder by its bare name.
const BACKUPS = path.join(TMP, "backups");
fs.mkdirSync(BACKUPS, { recursive: true });
const backupEnv = () => ({ ...agentEnv(), BACKUP_ROOT: BACKUPS });

// The status the agent writes is where the app learns the folder.
function refreshWithBackups() {
  const env = backupEnv();
  fs.writeFileSync(env.BACKUP_ENV, `DEST_TYPE=local\nLOCAL_DIR=${BACKUPS}\nKEEP_LAST=14\n`);
  bc.applyRequest(env); // no request pending: it just refreshes the status
}

test("the backups list shows this site's backups, newest first", async () => {
  const older = buildSourceArchive("featherspress-full-20261123-002000.tar.gz");
  fs.copyFileSync(older, path.join(BACKUPS, "featherspress-full-20261123-002000.tar.gz"));
  fs.writeFileSync(path.join(BACKUPS, "featherspress-full-20261124-002000-3dc6ab2.tar.gz.age"), "sealed");
  fs.writeFileSync(path.join(BACKUPS, ".featherspress-full-20261125-002000.tar.gz.partial"), "half");
  refreshWithBackups();

  const res = await api("GET", "/admin/api/backups");
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.deepStrictEqual(body.backups.map((b) => [b.name, b.encrypted, b.engine]), [
    ["featherspress-full-20261124-002000-3dc6ab2.tar.gz.age", true, "3dc6ab2"],
    ["featherspress-full-20261123-002000.tar.gz", false, null],
  ]);
  assert.strictEqual(body.backups[0].size, 6);
  assert.strictEqual(body.backups[0].at, "2026-11-24T00:20:00Z");
});

test("Download streams a listed backup exactly as stored", async () => {
  const name = "featherspress-full-20261123-002000.tar.gz";
  const res = await api("GET", "/admin/api/backups/" + name);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", new RegExp(name.replace(/\./g, "\\.")));
  const got = Buffer.from(await res.arrayBuffer());
  assert.ok(got.equals(fs.readFileSync(path.join(BACKUPS, name))), "the bytes must be the stored file's");
});

test("Download refuses anything that is not a listed backup", async () => {
  fs.symlinkSync(process.env.AUTH_CONFIG, path.join(BACKUPS, "featherspress-full-20261120-002000.tar.gz"));
  for (const bad of [
    "featherspress-full-20261120-002000.tar.gz", // a symlink to the live login
    ".featherspress-full-20261125-002000.tar.gz.partial",
    "..%2Fauth-config.json",
    "featherspress-full-20261101-002000.tar.gz", // not there
  ]) {
    const res = await api("GET", "/admin/api/backups/" + bad);
    assert.strictEqual(res.status, 404, bad);
  }
  fs.rmSync(path.join(BACKUPS, "featherspress-full-20261120-002000.tar.gz"));
});

// A backup taken before the folder was opened to the site is still 0600
// root:root. Download must say so, not hand the browser an error as a file.
test("Download of a backup the site cannot read yet is a plain refusal", async () => {
  const name = "featherspress-full-20261121-002000.tar.gz";
  const p = path.join(BACKUPS, name);
  fs.writeFileSync(p, "sealed");
  fs.chmodSync(p, 0o000);
  try {
    const res = await api("GET", "/admin/api/backups/" + name);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.headers.get("content-disposition"), null, "no download prompt for an error");
    assert.match((await res.json()).error, /next backup run/);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test("the backups list and Download require auth", async () => {
  const saved = cookie;
  cookie = "";
  try {
    assert.strictEqual((await api("GET", "/admin/api/backups")).status, 401);
    assert.strictEqual((await api("GET", "/admin/api/backups/featherspress-full-20261123-002000.tar.gz")).status, 401);
  } finally {
    cookie = saved;
  }
});

test("Restore from the list: a plaintext backup is restored in place and kept", async () => {
  healthFails(0);
  const name = "featherspress-full-20261123-002000.tar.gz";
  const rq = await api("POST", "/admin/api/restore", { backupName: name, sections: ["content", "media", "site"] });
  const rqBody = await rq.json();
  assert.strictEqual(rq.status, 200, JSON.stringify(rqBody));
  const req = JSON.parse(fs.readFileSync(config.RESTORE_REQUEST_FILE, "utf8"));
  assert.strictEqual(req.backupName, name, "the request names the backup by its bare name");
  assert.strictEqual(req.stagedName, undefined);
  fs.writeFileSync(path.join(LIVE, "content", "posts", "later.md"), "---\ntitle: Later\ndate: 2026-04-04\n---\n\nx\n");

  bc.restoreRequest(backupEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "done", `restore said ${st.state}: ${st.error}`);
  assert.strictEqual(st.appliedRequestId, rqBody.requestId);
  assert.strictEqual(st.backupName, name);
  assert.deepStrictEqual(livePosts(), ["migrated.md"]);
  assert.ok(fs.existsSync(path.join(BACKUPS, name)), "restoring a backup must never delete it");
});

test("Restore from the list: an encrypted backup is decrypted with the pasted key", async () => {
  healthFails(0);
  const { execFileSync } = require("node:child_process");
  const keyText = execFileSync("age-keygen", [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const recipient = keyText.match(/public key:\s*(age1[0-9a-z]+)/)[1];
  const plain = buildSourceArchive("enc-src.tar.gz", { title: "From An Encrypted Backup" });
  const name = "featherspress-full-20261125-002000-3dc6ab2.tar.gz.age";
  execFileSync("age", ["-r", recipient, "-o", path.join(BACKUPS, name), plain]);
  const sealed = fs.readFileSync(path.join(BACKUPS, name));

  const noKey = await api("POST", "/admin/api/restore", { backupName: name, sections: ["site"] });
  assert.strictEqual(noKey.status, 400);
  assert.match((await noKey.json()).error, /key/);
  const wrongKey = await api("POST", "/admin/api/restore", {
    backupName: name, sections: ["site"], identity: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
  });
  assert.strictEqual(wrongKey.status, 400);
  assert.strictEqual(fs.existsSync(config.RESTORE_REQUEST_FILE), false, "a refused restore writes no request");

  const rq = await api("POST", "/admin/api/restore", { backupName: name, sections: ["content", "site"], identity: keyText });
  const rqBody = await rq.json();
  assert.strictEqual(rq.status, 200, JSON.stringify(rqBody));
  const req = JSON.parse(fs.readFileSync(config.RESTORE_REQUEST_FILE, "utf8"));
  assert.ok(req.stagedName && !req.backupName, "the app decrypts into staging; the agent restores that");
  assert.ok(!JSON.stringify(req).includes("AGE-SECRET-KEY"), "the key must never reach the request file");

  bc.restoreRequest(backupEnv());

  assert.strictEqual(restoreState().state, "done", restoreState().error);
  assert.strictEqual(liveTitle(), "From An Encrypted Backup");
  assert.ok(fs.readFileSync(path.join(BACKUPS, name)).equals(sealed), "the backup itself is untouched");
  assert.deepStrictEqual(fs.readdirSync(STAGING), [], "the decrypted copy is cleaned up");
});

test("Restore from the list refuses a name that is not one of this site's backups", async () => {
  for (const bad of ["../x.tar.gz", "featherspress-full-20261101-002000.tar.gz", "notes.txt"]) {
    const rq = await api("POST", "/admin/api/restore", { backupName: bad, sections: ["content"] });
    assert.strictEqual(rq.status, 400, bad);
  }
  // And the agent re-checks on its own: a forged request for a missing backup.
  const before = livePosts();
  fs.writeFileSync(config.RESTORE_REQUEST_FILE, JSON.stringify({
    requestId: restoreState().appliedRequestId + 1,
    backupName: "featherspress-full-20261101-002000.tar.gz", sections: ["content"],
  }), { mode: 0o600 });
  bc.restoreRequest(backupEnv());
  assert.strictEqual(restoreState().state, "failed");
  assert.match(restoreState().error, /not found/);
  assert.deepStrictEqual(livePosts(), before);
});

test("the agent will not restore through a symlink planted in the backup folder", async () => {
  const before = livePosts();
  const target = buildSourceArchive("planted.tar.gz", { title: "Planted" });
  const name = "featherspress-full-20261119-002000.tar.gz";
  fs.symlinkSync(target, path.join(BACKUPS, name));
  try {
    fs.writeFileSync(config.RESTORE_REQUEST_FILE, JSON.stringify({
      requestId: restoreState().appliedRequestId + 1, backupName: name, sections: ["content", "site"],
    }), { mode: 0o600 });
    bc.restoreRequest(backupEnv());
    assert.strictEqual(restoreState().state, "failed");
    assert.deepStrictEqual(livePosts(), before);
    assert.notStrictEqual(liveTitle(), "Planted");
  } finally {
    fs.rmSync(path.join(BACKUPS, name));
  }
});

// ---- which engine made the backup: shown, never a reason to refuse ---------
test("a restore reports the engine that made the backup next to the running one", async () => {
  healthFails(0);
  const { engineInfo } = require("../tools/agent-lib");
  const src = buildSourceArchive("other-engine.tar.gz", { title: "Other Engine" });
  // Re-pack it as if an older engine had made it.
  const unpacked = fs.mkdtempSync(path.join(TMP, "other-engine-"));
  const { execFileSync } = require("node:child_process");
  execFileSync("tar", ["-xzf", src, "-C", unpacked]);
  fs.writeFileSync(path.join(unpacked, "engine.json"), JSON.stringify({ commit: "0000000", version: "0.0.9" }));
  const name = "featherspress-full-20261118-002000-0000000.tar.gz";
  execFileSync("tar", ["-czf", path.join(BACKUPS, name), "-C", unpacked, "."]);

  const rq = await api("POST", "/admin/api/restore", { backupName: name, sections: ["content", "site"] });
  assert.strictEqual(rq.status, 200);
  bc.restoreRequest(backupEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "done", "a different engine is information, not a refusal");
  assert.deepStrictEqual(st.engine, {
    backup: { commit: "0000000", version: "0.0.9" },
    running: engineInfo(ROOT),
  });
  assert.strictEqual(liveTitle(), "Other Engine");
});

test("a backup without engine.json (made before it existed) restores, engine unknown", async () => {
  healthFails(0);
  const src = buildSourceArchive("no-engine.tar.gz", { title: "No Engine Info" });
  const unpacked = fs.mkdtempSync(path.join(TMP, "no-engine-"));
  const { execFileSync } = require("node:child_process");
  execFileSync("tar", ["-xzf", src, "-C", unpacked]);
  fs.rmSync(path.join(unpacked, "engine.json"), { force: true });
  const name = "featherspress-full-20261117-002000.tar.gz";
  execFileSync("tar", ["-czf", path.join(BACKUPS, name), "-C", unpacked, "."]);

  const rq = await api("POST", "/admin/api/restore", { backupName: name, sections: ["content", "site"] });
  assert.strictEqual(rq.status, 200);
  bc.restoreRequest(backupEnv());

  const st = restoreState();
  assert.strictEqual(st.state, "done", st.error);
  assert.strictEqual(st.engine.backup, null);
  assert.strictEqual(liveTitle(), "No Engine Info");
});

test("the backups list tells the panel which engine this site runs", async () => {
  const body = await (await api("GET", "/admin/api/backups")).json();
  assert.deepStrictEqual(body.engine, require("../tools/agent-lib").engineInfo(ROOT));
});
