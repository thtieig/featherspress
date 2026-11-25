"use strict";

// tools/install-node.sh against a fake nodejs.org dist on disk (file:// URL),
// so the download / checksum / install logic runs without the network.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "tools", "install-node.sh");
const MAJOR = fs.readFileSync(path.join(__dirname, "..", ".nvmrc"), "utf8").trim();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-install-node-"));
const DIST = path.join(TMP, "dist");
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Publish a fake release: a tarball whose bin/node and bin/npm print versions,
// plus a SHASUMS256.txt listing it (optionally with a wrong checksum).
function publish(version, { badSum = false } = {}) {
  const rel = path.join(DIST, `latest-v${MAJOR}.x`);
  fs.rmSync(rel, { recursive: true, force: true });
  fs.mkdirSync(rel, { recursive: true });
  const name = `node-${version}-linux-x64`;
  const build = path.join(TMP, "build", name);
  fs.mkdirSync(path.join(build, "bin"), { recursive: true });
  fs.writeFileSync(path.join(build, "bin", "node"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(build, "bin", "npm"), "#!/bin/sh\necho 10.0.0\n", { mode: 0o755 });
  const file = `${name}.tar.xz`;
  execFileSync("tar", ["-cJf", path.join(rel, file), "-C", path.dirname(build), name]);
  let sum = crypto.createHash("sha256").update(fs.readFileSync(path.join(rel, file))).digest("hex");
  if (badSum) sum = "0".repeat(64);
  fs.writeFileSync(
    path.join(rel, "SHASUMS256.txt"),
    `${"a".repeat(64)}  node-${version}-darwin-arm64.tar.gz\n${sum}  ${file}\n`
  );
}

// Run from an unrelated cwd: the script must not rely on being in the repo.
function run(target) {
  return spawnSync("bash", [SCRIPT, target], {
    cwd: os.tmpdir(),
    env: { ...process.env, NODE_DIST: `file://${DIST}` },
    encoding: "utf8",
  });
}

const target = path.join(TMP, "opt", "node");

test("installs the listed release into an absolute target", () => {
  publish(`v${MAJOR}.1.0`);
  const r = run(target);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(execFileSync(path.join(target, "bin", "node"), { encoding: "utf8" }).trim(), `v${MAJOR}.1.0`);
});

test("is a no-op when that version is already installed", () => {
  fs.writeFileSync(path.join(target, "marker"), "");
  const r = run(target);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /already/);
  assert.ok(fs.existsSync(path.join(target, "marker")));
});

test("replaces an older install with a newer release", () => {
  publish(`v${MAJOR}.2.0`);
  const r = run(target);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(execFileSync(path.join(target, "bin", "node"), { encoding: "utf8" }).trim(), `v${MAJOR}.2.0`);
  assert.ok(!fs.existsSync(path.join(target, "marker")));
});

test("refuses a download that fails the checksum and leaves the install alone", () => {
  publish(`v${MAJOR}.3.0`, { badSum: true });
  const r = run(target);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(execFileSync(path.join(target, "bin", "node"), { encoding: "utf8" }).trim(), `v${MAJOR}.2.0`);
  // No half-finished temp dirs left beside the target.
  assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ["node"]);
});

// docs/DEPLOY.md used to make /opt/node a symlink to /opt/node-vX-linux-x64.
// The new release replaces the link itself, not the versioned dir behind it.
test("replaces a symlinked target with a real dir, leaving the old dir alone", () => {
  const old = path.join(TMP, "link", "node-v1-linux-x64");
  fs.mkdirSync(path.join(old, "bin"), { recursive: true });
  fs.writeFileSync(path.join(old, "bin", "node"), "#!/bin/sh\necho v1.0.0\n", { mode: 0o755 });
  const link = path.join(TMP, "link", "node");
  fs.symlinkSync(old, link);
  publish(`v${MAJOR}.4.0`);
  const r = run(link);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.ok(!fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(execFileSync(path.join(link, "bin", "node"), { encoding: "utf8" }).trim(), `v${MAJOR}.4.0`);
  assert.strictEqual(execFileSync(path.join(old, "bin", "node"), { encoding: "utf8" }).trim(), "v1.0.0");
});
