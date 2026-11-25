"use strict";

// tools/agent-lib.js: helpers shared by the root agents and the site-package CLI.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("../tools/agent-lib");

test("readRequestNoFollow refuses a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    fs.writeFileSync(path.join(dir, "real"), "{}");
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "req"));
    assert.throws(() => lib.readRequestNoFollow(path.join(dir, "req")), /symlink|ELOOP|NOFOLLOW/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRequestNoFollow refuses an oversize request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const big = JSON.stringify({ requestId: 1, action: "apply", pad: "x".repeat(70 * 1024) });
    fs.writeFileSync(path.join(dir, "req"), big);
    assert.throws(() => lib.readRequestNoFollow(path.join(dir, "req")), /too large/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRequestNoFollow reads a plain request file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    fs.writeFileSync(path.join(dir, "req"), JSON.stringify({ requestId: 1, action: "apply" }));
    const req = lib.readRequestNoFollow(path.join(dir, "req"));
    assert.strictEqual(req.requestId, 1);
    assert.strictEqual(req.action, "apply");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAppliedId defaults to 0 when the status file is absent or unreadable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    assert.strictEqual(lib.readAppliedId(path.join(dir, "nope.json")), 0);
    fs.writeFileSync(path.join(dir, "bad.json"), "not json");
    assert.strictEqual(lib.readAppliedId(path.join(dir, "bad.json")), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAppliedId reads appliedRequestId back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "status.json");
    fs.writeFileSync(p, JSON.stringify({ appliedRequestId: 7 }));
    assert.strictEqual(lib.readAppliedId(p), 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusFile writes atomically and is re-readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "status.json");
    lib.writeStatusFile(p, { appliedRequestId: 9, lastOk: true, lastErr: null, appliedAt: "2026-01-01T00:00:00Z" });
    const written = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(written.appliedRequestId, 9);
    assert.strictEqual(written.lastOk, true);
    assert.strictEqual(fs.existsSync(p + ".tmp"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeRequest deletes only when the request still holds the same id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "req.json");
    fs.writeFileSync(p, JSON.stringify({ requestId: 1, action: "apply" }));
    lib.consumeRequest(p, 2); // different id: a newer request landed since — leave it
    assert.strictEqual(fs.existsSync(p), true);
    lib.consumeRequest(p, 1); // same id: safe to remove
    assert.strictEqual(fs.existsSync(p), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeRequest is a no-op when the request file is already gone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    assert.doesNotThrow(() => lib.consumeRequest(path.join(dir, "nope.json"), 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile reads REPO_REF/NODE_BIN/NPM_BIN/SERVICE/FP_USER out of update.conf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    const p = path.join(dir, "update.conf");
    fs.writeFileSync(
      p,
      ["AUTO_APPLY=0", "REPO_REF=develop", "NODE_BIN=/usr/bin/node", "NPM_BIN=/usr/bin/npm",
        "SERVICE=myservice", "FP_USER=someuser"].join("\n") + "\n"
    );
    const conf = lib.parseEnvFile(p);
    assert.strictEqual(conf.REPO_REF, "develop");
    assert.strictEqual(conf.NODE_BIN, "/usr/bin/node");
    assert.strictEqual(conf.NPM_BIN, "/usr/bin/npm");
    assert.strictEqual(conf.SERVICE, "myservice");
    assert.strictEqual(conf.FP_USER, "someuser");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnvFile returns {} for a missing file, without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  try {
    assert.deepStrictEqual(lib.parseEnvFile(path.join(dir, "nope.conf")), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseEnv accepts an export prefix and strips one layer of quotes", () => {
  const conf = lib.parseEnv(
    ["# comment", "export AGE_RECIPIENT=age1abc", 'NODE_BIN="/usr/bin/node"', "SERVICE='fp'", "not a line"].join("\n")
  );
  assert.deepStrictEqual(conf, { AGE_RECIPIENT: "age1abc", NODE_BIN: "/usr/bin/node", SERVICE: "fp" });
});

// ---- named instances --------------------------------------------------------
// Every path and unit an agent touches comes from the instance name, so one
// site's agent can never reach another site's files or restart its service.

test("instance() derives every path and unit from the name", () => {
  const i = lib.instance({ INSTANCE: "alpha" });
  assert.deepStrictEqual(
    { ...i, engineDir: undefined },
    {
      name: "alpha",
      engineDir: undefined,
      confDir: "/etc/featherspress/alpha",
      dataDir: "/var/lib/featherspress/alpha",
      backupRoot: "/var/backups/featherspress/alpha",
      service: "featherspress@alpha",
      backupUnit: "featherspress-backup@alpha",
    }
  );
});

test("instance() takes the name from the checkout it runs in by default", () => {
  assert.strictEqual(lib.instance({ ENGINE_DIR: "/opt/featherspress/beta" }).name, "beta");
  assert.strictEqual(lib.instance({ ENGINE_DIR: "/opt/featherspress/beta" }).engineDir, "/opt/featherspress/beta");
  // No ENGINE_DIR: the checkout tools/agent-lib.js itself lives in.
  const repo = path.join(__dirname, "..");
  assert.strictEqual(lib.instance({}).engineDir, repo);
  assert.strictEqual(lib.instance({}).name, path.basename(repo));
});

test("instance() lets the environment move the directories (tests, odd boxes)", () => {
  const i = lib.instance({ INSTANCE: "alpha", CONF_DIR: "/c", DATA_DIR: "/d", BACKUP_ROOT: "/b" });
  assert.strictEqual(i.confDir, "/c");
  assert.strictEqual(i.dataDir, "/d");
  assert.strictEqual(i.backupRoot, "/b");
  assert.strictEqual(i.service, "featherspress@alpha");
});

test("instance() refuses a name that is not a plain lowercase word", () => {
  for (const bad of ["Alpha", "-a", "1a", "a/b", "..", "a b", "a".repeat(25), "a.b"]) {
    assert.throws(() => lib.instance({ INSTANCE: bad }), /instance name/, JSON.stringify(bad));
  }
  assert.strictEqual(lib.instance({ INSTANCE: "a".repeat(24) }).name, "a".repeat(24));
  assert.strictEqual(lib.instance({ INSTANCE: "my-blog2" }).name, "my-blog2");
});

// ---- the backups list: which files in a site's backup folder are backups ---

test("parseBackupName reads the time, engine and encryption out of a backup's name", () => {
  assert.deepStrictEqual(lib.parseBackupName("featherspress-full-20261125-002000.tar.gz"), {
    at: "2026-11-25T00:20:00Z", engine: null, encrypted: false,
  });
  assert.deepStrictEqual(lib.parseBackupName("featherspress-full-20261125-002000-3dc6ab2.tar.gz.age"), {
    at: "2026-11-25T00:20:00Z", engine: "3dc6ab2", encrypted: true,
  });
  for (const bad of [
    "featherspress-full-20261125-002000.tar.gz.partial",
    ".featherspress-full-20261125-002000.tar.gz.partial",
    "featherspress-full-2026112-002000.tar.gz",
    "featherspress-full-20261125-002000-XYZ.tar.gz",
    "featherspress-site-20261125-002000.tar.gz",
    "../featherspress-full-20261125-002000.tar.gz",
    "featherspress-full-20261125-002000.tar.gz/x",
    "featherspress-full-20261125-002000.tar.gz\n",
    "",
  ]) {
    assert.strictEqual(lib.parseBackupName(bad), null, JSON.stringify(bad));
  }
});

test("listBackups lists real backup files only, newest first, with their size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-bk-"));
  try {
    fs.writeFileSync(path.join(dir, "featherspress-full-20261123-002000.tar.gz"), "a");
    fs.writeFileSync(path.join(dir, "featherspress-full-20261125-002000-3dc6ab2.tar.gz.age"), "abc");
    fs.writeFileSync(path.join(dir, "featherspress-full-20261124-002000.tar.gz.age"), "ab");
    fs.writeFileSync(path.join(dir, ".featherspress-full-20261126-002000.tar.gz.partial"), "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.mkdirSync(path.join(dir, "featherspress-full-20261127-002000.tar.gz"));
    fs.symlinkSync("/etc/passwd", path.join(dir, "featherspress-full-20261128-002000.tar.gz"));
    assert.deepStrictEqual(lib.listBackups(dir), [
      { name: "featherspress-full-20261125-002000-3dc6ab2.tar.gz.age", at: "2026-11-25T00:20:00Z", engine: "3dc6ab2", encrypted: true, size: 3 },
      { name: "featherspress-full-20261124-002000.tar.gz.age", at: "2026-11-24T00:20:00Z", engine: null, encrypted: true, size: 2 },
      { name: "featherspress-full-20261123-002000.tar.gz", at: "2026-11-23T00:20:00Z", engine: null, encrypted: false, size: 1 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listBackups is empty for a folder that does not exist yet", () => {
  assert.deepStrictEqual(lib.listBackups(path.join(os.tmpdir(), "al-no-such-dir-" + process.pid)), []);
});

test("backupFile resolves a listed name inside the folder and nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-bk-"));
  try {
    const good = "featherspress-full-20261125-002000.tar.gz";
    fs.writeFileSync(path.join(dir, good), "a");
    fs.symlinkSync("/etc/passwd", path.join(dir, "featherspress-full-20261126-002000.tar.gz"));
    assert.strictEqual(lib.backupFile(dir, good), path.join(dir, good));
    assert.strictEqual(lib.backupFile(dir, "featherspress-full-20261124-002000.tar.gz"), null, "missing");
    assert.strictEqual(lib.backupFile(dir, "featherspress-full-20261126-002000.tar.gz"), null, "symlink");
    assert.strictEqual(lib.backupFile(dir, "../" + good), null, "path");
    assert.strictEqual(lib.backupFile(dir, "notes.txt"), null, "not a backup name");
    assert.strictEqual(lib.backupFile(null, good), null, "no folder");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backupDir is the configured folder when it is inside the site's own, else the site's own", () => {
  assert.strictEqual(lib.backupDir("/var/backups/featherspress/alpha/nightly", "/var/backups/featherspress/alpha"),
    "/var/backups/featherspress/alpha/nightly");
  assert.strictEqual(lib.backupDir("/var/backups/featherspress/beta", "/var/backups/featherspress/alpha"),
    "/var/backups/featherspress/alpha");
  assert.strictEqual(lib.backupDir(null, "/var/backups/featherspress/alpha"), "/var/backups/featherspress/alpha");
  assert.strictEqual(lib.backupDir("/x", null), null);
});

// ---- which engine made a package ------------------------------------------

test("engineInfo reports this checkout's commit and package version", () => {
  const repo = path.join(__dirname, "..");
  const { execFileSync } = require("node:child_process");
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.deepStrictEqual(lib.engineInfo(repo), {
    commit: head.slice(0, 7),
    version: require("../package.json").version,
  });
});

test("engineInfo follows packed refs and a detached HEAD, and survives no git at all", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-eng-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
    assert.deepStrictEqual(lib.engineInfo(dir), { commit: null, version: "9.9.9" });
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(dir, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n" + "a".repeat(40) + " refs/heads/other\n" + "b".repeat(40) + " refs/heads/main\n");
    assert.strictEqual(lib.engineInfo(dir).commit, "bbbbbbb");
    fs.mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "refs", "heads", "main"), "c".repeat(40) + "\n");
    assert.strictEqual(lib.engineInfo(dir).commit, "ccccccc", "a loose ref wins over a packed one");
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "d".repeat(40) + "\n");
    assert.strictEqual(lib.engineInfo(dir).commit, "ddddddd", "detached HEAD");
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: ../../etc/passwd\n");
    assert.strictEqual(lib.engineInfo(dir).commit, null, "a ref outside refs/ is not followed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
