"use strict";

// deploy/update.sh against a throwaway git origin: which settings win when
// both the environment and update.conf set them. Nothing here gets as far as
// npm, a restart or a merge: the runs either stop at "update available" or at
// the dirty-tree refusal.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const UPDATE_SH = path.join(__dirname, "..", "deploy", "update.sh");

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
}

// origin: main has one commit, develop one more. The engine dir is a clone
// sitting on main, so it is 0 behind main and 1 behind develop.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-update-sh-"));
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "9.9.9" }));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "one");
  git(dir, "clone", "-q", "--bare", seed, "origin.git");
  git(seed, "checkout", "-q", "-b", "develop");
  fs.writeFileSync(path.join(seed, "two.txt"), "2");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "two");
  git(seed, "push", "-q", path.join(dir, "origin.git"), "develop");
  git(dir, "clone", "-q", path.join(dir, "origin.git"), "engine");
  return dir;
}

function run(dir, conf, env = {}) {
  const confPath = path.join(dir, "update.conf");
  fs.writeFileSync(confPath, conf.join("\n") + "\n");
  const base = { ...process.env };
  for (const k of ["AUTO_APPLY", "REPO_REF", "NODE_BIN", "NPM_BIN", "SERVICE", "FP_USER", "ENGINE_DIR"]) delete base[k];
  return spawnSync("bash", [UPDATE_SH], {
    encoding: "utf8",
    env: {
      ...base,
      FP_ENV: path.join(dir, "no-such.env"),
      UPDATE_CONF: confPath,
      UPDATE_LOCK: path.join(dir, "update.lock"),
      UPDATE_STATUS_FILE: path.join(dir, "update-status.json"),
      ENGINE_DIR: path.join(dir, "engine"),
      ...env,
    },
  });
}

test("update.sh uses update.conf's settings when the environment does not set them", () => {
  const dir = setup();
  try {
    const r = run(dir, ["AUTO_APPLY=0", "REPO_REF=develop", `NODE_BIN=${process.execPath}`]);
    assert.strictEqual(r.status, 0, r.stderr);
    // behind=1 only against develop; the version only reads with a real node.
    assert.match(r.stdout, /behind=1 .* auto_apply=0/);
    assert.match(r.stdout, /AUTO_APPLY off/);
    const status = JSON.parse(fs.readFileSync(path.join(dir, "update-status.json"), "utf8"));
    assert.strictEqual(status.currentVersion, "9.9.9");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update.sh lets an environment value win over update.conf", () => {
  const dir = setup();
  try {
    // A local edit makes the apply refuse before it touches anything, which is
    // enough to prove AUTO_APPLY=1 from the environment took effect.
    fs.writeFileSync(path.join(dir, "engine", "local-edit.txt"), "x");
    const r = run(dir, ["AUTO_APPLY=0", "REPO_REF=develop", "NODE_BIN=/no/such/node"], {
      AUTO_APPLY: "1",
      NODE_BIN: process.execPath,
    });
    assert.match(r.stdout, /behind=1 .* auto_apply=1/);
    assert.match(r.stderr, /refusing to apply: .* uncommitted local changes/);
    assert.strictEqual(r.status, 1);
    const status = JSON.parse(fs.readFileSync(path.join(dir, "update-status.json"), "utf8"));
    assert.strictEqual(status.currentVersion, "9.9.9");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
