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

// ---- named instances --------------------------------------------------------
// update.sh lives in each instance's own checkout, /opt/featherspress/<name>.
// Run from there with nothing set, as the timer and a hand-run `sudo
// /opt/featherspress/<name>/deploy/update.sh` both do, it must read that
// instance's update.conf, write that instance's status file, and restart
// that instance's service alone.

test("update.sh run from an instance's checkout updates and restarts only that instance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-update-sh-inst-"));
  try {
    const seed = path.join(dir, "seed");
    fs.mkdirSync(path.join(seed, "deploy"), { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "1.0.0" }));
    for (const f of ["update.sh", "instance.sh"]) {
      fs.copyFileSync(path.join(__dirname, "..", "deploy", f), path.join(seed, "deploy", f));
    }
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "1.0.1" }));
    git(seed, "commit", "-q", "-am", "two");
    git(dir, "clone", "-q", "--bare", seed, "origin.git");
    // The instance's checkout, one commit behind.
    git(dir, "clone", "-q", path.join(dir, "origin.git"), "alpha");
    git(path.join(dir, "alpha"), "reset", "-q", "--hard", "HEAD~1");

    // systemctl and curl stubbed; npm a no-op.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(dir, "systemctl.log");
    fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const conf = path.join(dir, "etc");
    const data = path.join(dir, "data");
    fs.mkdirSync(conf);
    fs.writeFileSync(path.join(conf, "update.conf"),
      `AUTO_APPLY=0\nREPO_REF=main\nNODE_BIN=${process.execPath}\nNPM_BIN=${path.join(bin, "npm")}\n`);
    fs.writeFileSync(path.join(conf, "featherspress.env"), "PORT=1\n");

    const env = { ...process.env };
    for (const k of ["AUTO_APPLY", "REPO_REF", "NODE_BIN", "NPM_BIN", "SERVICE", "FP_USER", "ENGINE_DIR",
      "INSTANCE", "FP_ENV", "UPDATE_CONF", "UPDATE_STATUS_FILE"]) delete env[k];
    const r = spawnSync("bash", [path.join(dir, "alpha", "deploy", "update.sh")], {
      encoding: "utf8",
      env: {
        ...env,
        PATH: bin + path.delimiter + process.env.PATH,
        CONF_DIR: conf,
        DATA_DIR: data,
        UPDATE_LOCK: path.join(dir, "update.lock"),
        AUTO_APPLY: "1",
      },
    });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /applied and healthy/);
    assert.deepStrictEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["restart featherspress@alpha"]);
    const status = JSON.parse(fs.readFileSync(path.join(data, "update-status.json"), "utf8"));
    assert.strictEqual(status.behind, 0);
    assert.strictEqual(status.currentVersion, "1.0.1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update.sh refuses a checkout whose name is not a valid instance name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-update-sh-bad-"));
  try {
    const r = spawnSync("bash", [UPDATE_SH], {
      encoding: "utf8",
      env: { ...process.env, ENGINE_DIR: path.join(dir, "Not_Valid"), INSTANCE: "" },
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /instance name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- applying: a failed update must leave the old engine running -------------
// An instance checkout one commit behind, with installed dependencies (a
// marker file in node_modules). `npm` is whatever script the test hands in.
function applySetup(npmScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-update-sh-apply-"));
  const seed = path.join(dir, "seed");
  fs.mkdirSync(path.join(seed, "deploy"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "1.0.0" }));
  for (const f of ["update.sh", "instance.sh"]) {
    fs.copyFileSync(path.join(__dirname, "..", "deploy", f), path.join(seed, "deploy", f));
  }
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "1.0.1" }));
  git(seed, "commit", "-q", "-am", "two");
  git(dir, "clone", "-q", "--bare", seed, "origin.git");
  const engine = path.join(dir, "alpha");
  git(dir, "clone", "-q", path.join(dir, "origin.git"), "alpha");
  git(engine, "reset", "-q", "--hard", "HEAD~1");
  fs.mkdirSync(path.join(engine, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(engine, "node_modules", "dep", "marker"), "old deps");

  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), npmScript, { mode: 0o755 });

  const conf = path.join(dir, "etc");
  fs.mkdirSync(conf);
  fs.writeFileSync(path.join(conf, "update.conf"),
    `AUTO_APPLY=1\nREPO_REF=main\nNODE_BIN=${process.execPath}\nNPM_BIN=${path.join(bin, "npm")}\n`);
  fs.writeFileSync(path.join(conf, "featherspress.env"), "PORT=1\n");

  const env = { ...process.env };
  for (const k of ["AUTO_APPLY", "REPO_REF", "NODE_BIN", "NPM_BIN", "SERVICE", "FP_USER", "ENGINE_DIR",
    "INSTANCE", "FP_ENV", "UPDATE_CONF", "UPDATE_STATUS_FILE"]) delete env[k];
  const runIt = () => spawnSync("bash", [path.join(engine, "deploy", "update.sh")], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...env,
      PATH: bin + path.delimiter + process.env.PATH,
      CONF_DIR: conf,
      DATA_DIR: path.join(dir, "data"),
      UPDATE_LOCK: path.join(dir, "update.lock"),
    },
  });
  const head = () => execFileSync("git", ["-C", engine, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  return { dir, engine, run: runIt, head };
}

test("update.sh: a failed install puts the old dependencies back without needing the network", () => {
  // npm ci empties node_modules first, then fails (registry unreachable) —
  // every time, so a second install during the rollback cannot help either.
  const s = applySetup(`#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && p="$2"; shift; done
rm -rf "$p/node_modules"
echo "npm ERR! network unreachable" >&2
exit 1
`);
  try {
    const r = s.run();
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /rolled back and healthy/);
    assert.strictEqual(s.head(), "one", "the code must be back at the rollback point");
    assert.strictEqual(fs.readFileSync(path.join(s.engine, "node_modules", "dep", "marker"), "utf8"), "old deps",
      "the old dependencies must be back");
    assert.deepStrictEqual(fs.readdirSync(s.dir).filter((f) => /node_modules/.test(f)), [],
      "no saved copy may be left beside the checkout");
    assert.strictEqual(execFileSync("git", ["-C", s.engine, "status", "--porcelain"], { encoding: "utf8" }), "",
      "the checkout must be clean, or the next update refuses");
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("update.sh: a good update leaves the new dependencies and no saved copy", () => {
  const s = applySetup(`#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && p="$2"; shift; done
rm -rf "$p/node_modules"; mkdir -p "$p/node_modules/dep"; echo "new deps" > "$p/node_modules/dep/marker"
`);
  try {
    const r = s.run();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(s.head(), "two");
    assert.strictEqual(fs.readFileSync(path.join(s.engine, "node_modules", "dep", "marker"), "utf8"), "new deps\n");
    assert.deepStrictEqual(fs.readdirSync(s.dir).filter((f) => /node_modules/.test(f)), []);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("update.sh: an update stopped half-way (systemd timeout, shutdown) is rolled back", () => {
  // The install is interrupted the way systemd stops a unit: SIGTERM.
  const s = applySetup(`#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && p="$2"; shift; done
rm -rf "$p/node_modules"
kill -TERM $PPID
exit 0
`);
  try {
    const r = s.run();
    assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /rolled back and healthy/);
    assert.strictEqual(s.head(), "one");
    assert.strictEqual(fs.readFileSync(path.join(s.engine, "node_modules", "dep", "marker"), "utf8"), "old deps");
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("update.sh does not write its status through a symlink planted in the data dir", () => {
  const dir = setup();
  try {
    const victim = path.join(dir, "victim");
    fs.writeFileSync(victim, "precious\n", { mode: 0o600 });
    fs.symlinkSync(victim, path.join(dir, "update-status.json"));
    const r = run(dir, ["AUTO_APPLY=0", "REPO_REF=develop", `NODE_BIN=${process.execPath}`]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "precious\n", "the link's target must be untouched");
    assert.strictEqual(fs.statSync(victim).mode & 0o777, 0o600, "and not chmodded");
    assert.ok(fs.lstatSync(path.join(dir, "update-status.json")).isFile());
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "update-status.json"), "utf8")).behind, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
