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

function run(dir) {
  const r = spawnSync("bash", [BACKUP_SH], {
    encoding: "utf8",
    env: {
      ...process.env,
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

test("backup.sh records a generic failed run when a required setting is missing", () => {
  const dir = setup(["DEST_TYPE=local", "KEEP_LAST=3"]); // no LOCAL_DIR
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
