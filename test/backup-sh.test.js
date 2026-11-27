"use strict";

// deploy/backup.sh end to end, against a throwaway site and local
// destination: every way it can stop must leave a failed run where the
// /admin Backups panel looks (backup-last-run.json, refreshed into
// backup-status.json by backup-control.js), and a good run must not.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BACKUP_SH = path.join(ROOT, "deploy", "backup.sh");

function setup(backupEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-backup-sh-"));
  const pkg = path.join(dir, "site");
  fs.mkdirSync(path.join(pkg, "content", "posts"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "content", "posts", "hello.md"), "---\ntitle: Hi\n---\nhi\n");
  fs.writeFileSync(path.join(pkg, "auth-config.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "featherspress.env"),
    [`SITE_PACKAGE=${pkg}`, `AUTH_CONFIG=${path.join(pkg, "auth-config.json")}`].join("\n") + "\n"
  );
  if (backupEnv) fs.writeFileSync(path.join(dir, "backup.env"), backupEnv.join("\n") + "\n");
  return dir;
}

function run(dir, extraEnv = {}) {
  const r = spawnSync("bash", [BACKUP_SH], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      FP_ENV: path.join(dir, "featherspress.env"),
      BACKUP_ENV: path.join(dir, "backup.env"),
      BACKUP_LOCK: path.join(dir, "backup.lock"),
      LAST_RUN_FILE: path.join(dir, "last-run.json"),
      BACKUP_STATUS: path.join(dir, "backup-status.json"),
      SCHEDULE_DROPIN: path.join(dir, "schedule.conf"),
      UPDATE_CONF: path.join(dir, "no-update.conf"),
      ENGINE_DIR: ROOT,
      NODE_BIN: process.execPath,
      CONTENT_DIR: "",
      MEDIA_DIR: "",
      SITE_MANIFEST: "",
    },
  });
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  return { ...r, lastRun: read("last-run.json"), panel: read("backup-status.json").lastRun };
}

function assertFailedRun(r, errorRe) {
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(r.lastRun.ok, false);
  assert.match(r.lastRun.error, errorRe);
  assert.deepStrictEqual(r.panel, r.lastRun, "the panel's status must carry the failed run");
}

test("backup.sh records a failed run when backup.env is missing", () => {
  const dir = setup(null);
  try {
    assertFailedRun(run(dir), /backup\.env/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh records a failed run when KEEP_LAST is 0", () => {
  const dir = setup(["DEST_TYPE=local", "LOCAL_DIR=/nowhere", "KEEP_LAST=0"]);
  try {
    assertFailedRun(run(dir), /KEEP_LAST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh records a failed run when an off-box destination has no encryption key", () => {
  const dir = setup(["DEST_TYPE=rclone", "RCLONE_REMOTE=nowhere:fp", "KEEP_LAST=3"]);
  try {
    assertFailedRun(run(dir), /encrypt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh records a failed run for an unknown destination type", () => {
  const dir = setup(["DEST_TYPE=ftp", "KEEP_LAST=3"]);
  try {
    assertFailedRun(run(dir), /DEST_TYPE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh records a generic failed run when something unforeseen stops it", () => {
  const dir = setup(["DEST_TYPE=local", "LOCAL_DIR=/proc/fp-cannot-exist", "KEEP_LAST=3"]); // mkdir fails
  try {
    assertFailedRun(run(dir), /backup run failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh records a good run as ok", () => {
  const dir = setup(null);
  try {
    const dest = path.join(dir, "dest");
    fs.writeFileSync(path.join(dir, "backup.env"), `DEST_TYPE=local\nLOCAL_DIR=${dest}\nKEEP_LAST=3\n`);
    const r = run(dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.lastRun.ok, true);
    assert.strictEqual(r.lastRun.error, null);
    assert.strictEqual(fs.readdirSync(dest).filter((f) => f.startsWith("featherspress-full-")).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh does not write its result through a symlink planted in the data dir", () => {
  const dir = setup(null);
  try {
    const dest = path.join(dir, "dest");
    fs.writeFileSync(path.join(dir, "backup.env"), `DEST_TYPE=local\nLOCAL_DIR=${dest}\nKEEP_LAST=3\n`);
    const victim = path.join(dir, "victim");
    fs.writeFileSync(victim, "precious\n", { mode: 0o600 });
    fs.symlinkSync(victim, path.join(dir, "last-run.json"));
    const r = run(dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "precious\n", "the link's target must be untouched");
    assert.ok(fs.lstatSync(path.join(dir, "last-run.json")).isFile());
    assert.strictEqual(r.lastRun.ok, true);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(dir)).filter((f) => f.startsWith(".fp-put.")), [],
      "no temp dir is left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The backups list shows which engine took each backup without opening it,
// so the engine's commit goes in the name.
test("backup.sh names a backup after the engine commit that took it", () => {
  const dir = setup(null);
  try {
    const dest = path.join(dir, "dest");
    fs.writeFileSync(path.join(dir, "backup.env"), `DEST_TYPE=local\nLOCAL_DIR=${dest}\nKEEP_LAST=3\n`);
    const r = run(dir);
    assert.strictEqual(r.status, 0, r.stderr);
    const commit = require("../tools/agent-lib").engineInfo(ROOT).commit;
    const [name] = fs.readdirSync(dest);
    assert.match(name, new RegExp(`^featherspress-full-\\d{8}-\\d{6}-${commit}\\.tar\\.gz$`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The site user lists, downloads and decrypts its own backups from /admin, so
// a backup takes the folder's group (fp-<name> on a real box: the folder is
// 0750 root:fp-<name>) and is 0640: readable by the site, writable by root only.
test("backup.sh leaves backups readable by the folder's group, and fixes older ones", () => {
  const dir = setup(null);
  try {
    const dest = path.join(dir, "dest");
    fs.mkdirSync(dest, { mode: 0o750 });
    fs.chmodSync(dest, 0o750);
    const old = path.join(dest, "featherspress-full-20200101-000000.tar.gz");
    fs.writeFileSync(old, "old", { mode: 0o600 });
    fs.chmodSync(old, 0o600);
    fs.writeFileSync(path.join(dir, "backup.env"), `DEST_TYPE=local\nLOCAL_DIR=${dest}\nKEEP_LAST=3\n`);
    const r = run(dir);
    assert.strictEqual(r.status, 0, r.stderr);
    const files = fs.readdirSync(dest).filter((f) => f.startsWith("featherspress-full-"));
    assert.strictEqual(files.length, 2);
    for (const f of files) {
      const st = fs.statSync(path.join(dest, f));
      assert.strictEqual(st.mode & 0o777, 0o640, f);
      assert.strictEqual(st.gid, fs.statSync(dest).gid, f);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh creates a missing backup folder closed to everyone but root and its group", () => {
  const dir = setup(null);
  try {
    const dest = path.join(dir, "dest", "nightly");
    fs.writeFileSync(path.join(dir, "backup.env"), `DEST_TYPE=local\nLOCAL_DIR=${dest}\nKEEP_LAST=3\n`);
    const r = run(dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o750);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Run by featherspress-backup@<name>.service with nothing but the instance
// name to go on: the config comes from /etc/featherspress/<name>/ and the
// outcome lands in /var/lib/featherspress/<name>/, where /admin reads it.
test("backup.sh finds its instance's config and reports into its data dir by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-backup-sh-inst-"));
  try {
    const pkg = path.join(dir, "site");
    fs.mkdirSync(path.join(pkg, "content", "posts"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "content", "posts", "hello.md"), "---\ntitle: Hi\n---\nhi\n");
    const conf = path.join(dir, "etc");
    const data = path.join(dir, "data");
    const dest = path.join(dir, "dest");
    fs.mkdirSync(conf);
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(conf, "featherspress.env"), `SITE_PACKAGE=${pkg}\n`);
    fs.writeFileSync(path.join(conf, "backup.env"), `DEST_TYPE=local\nLOCAL_DIR=${dest}\nKEEP_LAST=3\n`);
    const env = { ...process.env };
    for (const k of ["FP_ENV", "BACKUP_ENV", "LAST_RUN_FILE", "BACKUP_STATUS", "SCHEDULE_DROPIN", "UPDATE_CONF",
      "ENGINE_DIR", "INSTANCE", "CONTENT_DIR", "MEDIA_DIR", "SITE_MANIFEST", "AUTH_CONFIG"]) delete env[k];
    const r = spawnSync("bash", [BACKUP_SH], {
      encoding: "utf8",
      env: { ...env, CONF_DIR: conf, DATA_DIR: data, BACKUP_LOCK: path.join(dir, "backup.lock"), NODE_BIN: process.execPath },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, "backup-last-run.json"), "utf8")).ok, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, "backup-status.json"), "utf8")).lastRun.ok, true);
    assert.strictEqual(fs.readdirSync(dest).filter((f) => f.startsWith("featherspress-full-")).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- off-box (rclone): a copy goes off the box, the local one stays --------
// A stub rclone maps "remote:path" onto a folder, so uploads and remote
// pruning are real file operations the test can look at. RCLONE_FAIL makes
// every call fail, like wrong credentials or an unreachable host.
function offbox() {
  const dir = setup(null);
  const bin = path.join(dir, "bin");
  const remote = path.join(dir, "remote");
  fs.mkdirSync(bin);
  fs.mkdirSync(remote);
  fs.writeFileSync(path.join(bin, "rclone"), `#!/bin/bash
echo "$*" >> "${path.join(dir, "rclone.log")}"
[ -n "$RCLONE_FAIL" ] && { echo "Failed to copy: access denied" >&2; exit 1; }
[ -n "$RCLONE_NO_DELETE" ] && [ "$1" = deletefile ] && { echo "Failed to delete: access denied" >&2; exit 1; }
args=(); while [ $# -gt 0 ]; do case "$1" in --include) shift 2;; --*) shift;; *) args+=("$1"); shift;; esac; done
map() { echo "${remote}/\${1#*:}"; }
case "\${args[0]}" in
  copyto) mkdir -p "$(dirname "$(map "\${args[2]}")")" && cp "\${args[1]}" "$(map "\${args[2]}")" ;;
  lsf) ls -1 "$(map "\${args[1]}")" ;;
  deletefile) rm "$(map "\${args[1]}")" ;;
esac
`, { mode: 0o755 });
  const key = require("node:child_process").execFileSync("age-keygen", [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const recipient = key.match(/public key:\s*(age1[0-9a-z]+)/)[1];
  const backups = path.join(dir, "backups");
  fs.writeFileSync(path.join(dir, "backup.env"),
    `DEST_TYPE=rclone\nRCLONE_REMOTE=offsite:bucket/featherspress\nKEEP_LAST=2\nAGE_RECIPIENT=${recipient}\n`);
  const env = { PATH: bin + path.delimiter + process.env.PATH, INSTANCE: "alpha", BACKUP_ROOT: backups };
  return { dir, remote, backups, env };
}

test("off-box: each site uploads under its own name, and keeps its local copy", () => {
  const { dir, remote, backups, env } = offbox();
  try {
    const r = run(dir, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.lastRun.ok, true);
    const here = fs.readdirSync(path.join(remote, "bucket", "featherspress", "alpha"));
    assert.strictEqual(here.length, 1);
    assert.match(here[0], /^featherspress-full-\d{8}-\d{6}(-[0-9a-f]{7})?\.tar\.gz\.age$/, "always encrypted off-box");
    assert.deepStrictEqual(fs.readdirSync(backups), here, "the same backup is kept on this server for the list");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("off-box: old backups that cannot be pruned are reported, and the run still counts", () => {
  const { dir, remote, env } = offbox();
  try {
    const mine = path.join(remote, "bucket", "featherspress", "alpha");
    fs.mkdirSync(mine, { recursive: true });
    for (const d of ["20200101", "20200102", "20200103"]) {
      fs.writeFileSync(path.join(mine, `featherspress-full-${d}-000000.tar.gz.age`), "old");
    }
    const r = run(dir, { ...env, RCLONE_NO_DELETE: "1" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.lastRun.ok, true, "the backup itself was made and uploaded");
    assert.match(r.stderr, /could not prune 2 old off-box backups/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("off-box: retention prunes this site's remote folder and nobody else's", () => {
  const { dir, remote, backups, env } = offbox();
  try {
    const mine = path.join(remote, "bucket", "featherspress", "alpha");
    const theirs = path.join(remote, "bucket", "featherspress", "beta");
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(theirs, { recursive: true });
    for (const d of ["20200101", "20200102", "20200103"]) {
      fs.writeFileSync(path.join(mine, `featherspress-full-${d}-000000.tar.gz.age`), "old");
      fs.writeFileSync(path.join(theirs, `featherspress-full-${d}-000000.tar.gz.age`), "beta's");
    }
    const r = run(dir, env);
    assert.strictEqual(r.status, 0, r.stderr);
    const left = fs.readdirSync(mine).sort();
    assert.strictEqual(left.length, 2, "KEEP_LAST=2 at the remote");
    assert.strictEqual(left[0], "featherspress-full-20200103-000000.tar.gz.age");
    assert.strictEqual(fs.readdirSync(theirs).length, 3, "another site's backups are never pruned");
    assert.strictEqual(fs.readdirSync(backups).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("off-box: a failed upload is a failed run, and the local copy is kept", () => {
  const { dir, backups, env } = offbox();
  try {
    const r = run(dir, { ...env, RCLONE_FAIL: "1" });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.lastRun.ok, false);
    assert.match(r.lastRun.error, /off-box copy failed/);
    assert.match(r.lastRun.error, /kept on this server/);
    assert.deepStrictEqual(r.panel, r.lastRun);
    assert.strictEqual(fs.readdirSync(backups).length, 1, "the backup itself still happened");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("off-box: no remote configured is refused before any work", () => {
  const { dir, env } = offbox();
  try {
    fs.writeFileSync(path.join(dir, "backup.env"),
      fs.readFileSync(path.join(dir, "backup.env"), "utf8").replace(/^RCLONE_REMOTE=.*\n/m, ""));
    const r = run(dir, env);
    assert.strictEqual(r.status, 1);
    assert.match(r.lastRun.error, /RCLONE_REMOTE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
