"use strict";

// End-to-end CLI: `node tools/site-package.js export|import` driven as a
// subprocess so the real config.js + src/manifest.js wiring (SITE_PACKAGE →
// content/media/skin/manifest resolution) is exercised, plus the pre-restore
// safety backup. Each subprocess gets its own env, so no cross-test bleed.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "tools", "site-package.js");

function run(argv, env) {
  return execFileSync("node", [CLI, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

// A SITE_PACKAGE-wired data dir: content + media + site.json + custom skin + favicon.
function makePkg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-cli-"));
  fs.mkdirSync(path.join(dir, "content", "posts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media", "2024", "01"), { recursive: true });
  fs.mkdirSync(path.join(dir, "skins", "gvm", "templates"), { recursive: true });
  fs.mkdirSync(path.join(dir, "favicon"), { recursive: true });
  fs.writeFileSync(path.join(dir, "content", "posts", "hello.md"), "hi");
  fs.writeFileSync(path.join(dir, "media", "2024", "01", "pic.png"), "PNG");
  fs.writeFileSync(path.join(dir, "skins", "gvm", "templates", "home.njk"), "X");
  fs.writeFileSync(path.join(dir, "favicon", "favicon.ico"), "ICO");
  fs.writeFileSync(
    path.join(dir, "site.json"),
    JSON.stringify({ title: "GVM", skin: "gvm", homeMode: "feed", nav: [] })
  );
  fs.writeFileSync(
    path.join(dir, "auth-config.json"),
    JSON.stringify({ passwordHash: "x", totpSecret: "S", recoveryCodeHashes: [] })
  );
  return dir;
}

function envFor(pkg) {
  return {
    SITE_PACKAGE: pkg,
    AUTH_CONFIG: path.join(pkg, "auth-config.json"),
    FAVICON_DIR: path.join(pkg, "favicon"),
    // keep the tool from inheriting a sibling test's dir overrides
    CONTENT_DIR: "",
    MEDIA_DIR: "",
    SITE_MANIFEST: "",
  };
}

function listTar(tarball) {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

test("CLI export --profile full resolves skin+favicon+auth from SITE_PACKAGE config", () => {
  const pkg = makePkg();
  const out = path.join(pkg, "full.tar.gz");
  try {
    run(["export", "--profile", "full", "--out", out], envFor(pkg));
    const entries = listTar(out);
    assert.ok(entries.includes("auth-config.json"), "auth packed");
    assert.ok(entries.includes("skins/gvm/templates/home.njk"), "custom skin packed via config");
    assert.ok(entries.includes("favicon/favicon.ico"), "favicon packed via config");
    assert.ok(entries.includes("content/posts/hello.md"), "content packed");
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

test("CLI import into a fresh package restores the tree; a second import writes a pre-restore backup", () => {
  const srcPkg = makePkg();
  const out = path.join(srcPkg, "pkg.tar.gz");
  run(["export", "--profile", "full", "--out", out], envFor(srcPkg));

  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "fp-cli-dst-"));
  try {
    run(["import", out, "--force", "--restore-auth"], envFor(dst));
    assert.ok(fs.existsSync(path.join(dst, "content", "posts", "hello.md")), "content restored");
    assert.ok(fs.existsSync(path.join(dst, "skins", "gvm", "templates", "home.njk")), "skin restored");
    assert.ok(fs.existsSync(path.join(dst, "auth-config.json")), "auth restored with --restore-auth");

    // Second import: dst now has content, so a pre-restore backup must be made.
    const res = spawnSync("node", [CLI, "import", out, "--force"], {
      encoding: "utf8",
      env: { ...process.env, ...envFor(dst) },
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const m = res.stderr.match(/pre-restore backup of current data → (\S+)/);
    assert.ok(m, "pre-restore backup announced on second import");
    assert.ok(fs.existsSync(m[1]), "pre-restore backup file exists");
    assert.ok(listTar(m[1]).includes("auth-config.json"), "pre-restore backup is a full (with-auth) snapshot");
    fs.rmSync(m[1], { force: true });
  } finally {
    fs.rmSync(srcPkg, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});

// A stock install never sets FAVICON_DIR, so it resolves to the engine's bundled
// placeholder dir. A package that carries favicon/ must still import — and must
// not land its icons inside the engine's (read-only, git-tracked) code dir.
test("CLI import restores a package favicon when FAVICON_DIR is left at the engine default", () => {
  const srcPkg = makePkg();
  const out = path.join(srcPkg, "pkg.tar.gz");
  run(["export", "--profile", "full", "--out", out], envFor(srcPkg));

  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "fp-cli-nofav-"));
  try {
    // Stock wiring: explicit data dirs, no FAVICON_DIR override.
    const stockEnv = {
      SITE_PACKAGE: "",
      CONTENT_DIR: path.join(dst, "content"),
      MEDIA_DIR: path.join(dst, "media"),
      AUTH_CONFIG: path.join(dst, "auth-config.json"),
      FAVICON_DIR: "",
      SITE_MANIFEST: "",
    };
    const res = spawnSync("node", [CLI, "import", out, "--force", "--restore-auth"], {
      encoding: "utf8",
      env: { ...process.env, ...stockEnv },
    });
    assert.strictEqual(res.status, 0, `import must not crash on a package favicon: ${res.stderr}`);
    assert.ok(fs.existsSync(path.join(dst, "content", "posts", "hello.md")), "content restored");
    assert.ok(fs.existsSync(path.join(dst, "favicon", "favicon.ico")), "favicon restored beside content/");
    // The crash aborted before auth on the live box; prove the tail of the import runs.
    assert.ok(fs.existsSync(path.join(dst, "auth-config.json")), "auth restored after the favicon step");
    // The engine's bundled placeholder dir must be untouched.
    const bundled = path.join(__dirname, "..", "public", "favicon", "favicon.ico");
    assert.notStrictEqual(fs.readFileSync(bundled, "utf8"), "ICO", "engine's bundled favicon not overwritten");
  } finally {
    fs.rmSync(srcPkg, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});
