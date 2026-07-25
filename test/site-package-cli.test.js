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

// The nightly backup (deploy/backup.sh) runs exactly `export --profile full`,
// so the "full" profile must actually capture settings.json — not just list
// "settings" in sectionsForProfile. The status file (config.BACKUP_STATUS_FILE,
// which defaults beside content/) is written by the root backup-control agent;
// the CLI must read it and build settings via the SAME buildSettings the
// /admin export endpoint uses.
test("CLI export --profile full with a backup-status.json produces settings.json with the expected values", () => {
  const pkg = makePkg();
  fs.writeFileSync(
    path.join(pkg, "backup-status.json"),
    JSON.stringify({
      config: {
        destType: "local",
        localDir: "/var/backups/featherspress",
        keepLast: 7,
        schedule: { preset: "weekly", timeOfDay: "02:15", weekday: "Sat" },
        sections: ["content", "media", "site", "settings", "credentials"],
      },
      ageRecipient: "age1testrecipient",
      update: { autoApply: true, repoRef: "main" },
    })
  );
  const out = path.join(pkg, "full.tar.gz");
  try {
    run(["export", "--profile", "full", "--out", out], envFor(pkg));
    const entries = listTar(out);
    assert.ok(entries.includes("settings.json"), "settings.json present");
    assert.ok(entries.includes("content/posts/hello.md"), "content still present");

    const unpack = fs.mkdtempSync(path.join(os.tmpdir(), "fp-cli-settings-"));
    try {
      execFileSync("tar", ["-xzf", out, "-C", unpack]);
      const settings = JSON.parse(fs.readFileSync(path.join(unpack, "settings.json"), "utf8"));
      assert.strictEqual(settings.schemaVersion, 1);
      assert.strictEqual(settings.backup.keepLast, 7);
      assert.strictEqual(settings.backup.localDir, "/var/backups/featherspress");
      assert.strictEqual(settings.backup.schedule.weekday, "Sat");
      assert.strictEqual(settings.backup.ageRecipient, "age1testrecipient");
      assert.strictEqual(settings.update.autoApply, true);
    } finally {
      fs.rmSync(unpack, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

// A missing status file must never fail the whole nightly backup — it must
// just omit the settings section.
test("CLI export --profile full with no backup-status.json still succeeds and omits settings.json", () => {
  const pkg = makePkg();
  const out = path.join(pkg, "full.tar.gz");
  try {
    const res = spawnSync("node", [CLI, "export", "--profile", "full", "--out", out], {
      encoding: "utf8",
      env: { ...process.env, ...envFor(pkg) },
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /settings not captured/);
    assert.ok(fs.existsSync(out), "archive still produced");
    const entries = listTar(out);
    assert.ok(!entries.includes("settings.json"), "settings.json omitted, not written with nulls");
    assert.ok(entries.includes("content/posts/hello.md"), "content still present");
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

test("CLI export --profile site never contains settings.json, even with a backup-status.json present", () => {
  const pkg = makePkg();
  fs.writeFileSync(
    path.join(pkg, "backup-status.json"),
    JSON.stringify({ config: { destType: "local", keepLast: 14 } })
  );
  const out = path.join(pkg, "site.tar.gz");
  try {
    run(["export", "--profile", "site", "--out", out], envFor(pkg));
    const entries = listTar(out);
    assert.ok(!entries.includes("settings.json"), "site profile never carries settings.json");
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

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

// Running `npm run import` from the engine dir with no deployment env resolves
// every path to the bundled example-site/. Because the app user owns the code
// dir, that import SUCCEEDS: it clobbers git-tracked files and leaves the real
// site empty while printing "imported package". It must refuse instead.
test("CLI import refuses to write into the engine's own directory", () => {
  const srcPkg = makePkg();
  const out = path.join(srcPkg, "pkg.tar.gz");
  run(["export", "--profile", "full", "--out", out], envFor(srcPkg));
  try {
    const res = spawnSync("node", [CLI, "import", out, "--force", "--restore-auth"], {
      encoding: "utf8",
      // No deployment config at all -- the 2am mistake.
      env: {
        ...process.env,
        SITE_PACKAGE: "",
        CONTENT_DIR: "",
        MEDIA_DIR: "",
        AUTH_CONFIG: "",
        FAVICON_DIR: "",
        SITE_MANIFEST: "",
        SITE_SKINS_DIR: "",
      },
    });
    assert.notStrictEqual(res.status, 0, "must exit non-zero, not report success");
    assert.match(res.stderr, /refusing to import into the engine's own directory/);
    assert.match(res.stderr, /--env-file/, "error names the fix");
    // The engine's own example-site must be untouched.
    const example = path.join(__dirname, "..", "example-site", "content", "posts", "hello-world.md");
    assert.ok(fs.existsSync(example), "bundled example-site post still present");
  } finally {
    fs.rmSync(srcPkg, { recursive: true, force: true });
  }
});

// --env-file makes the CLI resolve the same paths the systemd service uses, so a
// restore run by hand lands where the running site actually reads from.
test("CLI import --env-file resolves the deployment's paths", () => {
  const srcPkg = makePkg();
  const out = path.join(srcPkg, "pkg.tar.gz");
  run(["export", "--profile", "full", "--out", out], envFor(srcPkg));

  const data = fs.mkdtempSync(path.join(os.tmpdir(), "fp-envfile-"));
  const envFile = path.join(data, "featherspress.env");
  // Deliberately quoted + a value with a space, as the shipped example now is.
  fs.writeFileSync(
    envFile,
    [
      `CONTENT_DIR=${path.join(data, "content")}`,
      `MEDIA_DIR=${path.join(data, "media")}`,
      `AUTH_CONFIG=${path.join(data, "auth-config.json")}`,
      `FAVICON_DIR=${path.join(data, "favicon")}`,
      `SITE_TITLE="My Blog"`,
      `# a comment`,
      ``,
    ].join("\n")
  );
  try {
    const res = spawnSync("node", [CLI, "import", out, "--force", "--restore-auth", "--env-file", envFile], {
      encoding: "utf8",
      env: {
        ...process.env,
        SITE_PACKAGE: "",
        CONTENT_DIR: "",
        MEDIA_DIR: "",
        AUTH_CONFIG: "",
        FAVICON_DIR: "",
        SITE_MANIFEST: "",
        SITE_SKINS_DIR: "",
      },
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(data, "content", "posts", "hello.md")), "content went to the env file's dir");
    assert.ok(fs.existsSync(path.join(data, "auth-config.json")), "auth went to the env file's dir");
    // It must also announce where it wrote, so a wrong target is visible.
    assert.match(res.stderr, /restoring into:/);
    assert.match(res.stderr, new RegExp(path.join(data, "content").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(srcPkg, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
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
    const authPath = path.join(dst, "auth-config.json");
    assert.ok(fs.existsSync(authPath), "auth restored after the favicon step");
    // It carries the TOTP secret in cleartext: a restore must not widen its mode.
    assert.strictEqual(fs.statSync(authPath).mode & 0o777, 0o600, "restored auth-config.json is 0600");
    // The engine's bundled placeholder dir must be untouched.
    const bundled = path.join(__dirname, "..", "public", "favicon", "favicon.ico");
    assert.notStrictEqual(fs.readFileSync(bundled, "utf8"), "ICO", "engine's bundled favicon not overwritten");
  } finally {
    fs.rmSync(srcPkg, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});
