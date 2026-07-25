"use strict";

// The Site Package pack/unpack primitive. One artifact (a .tar.gz with the
// canonical data-dir layout: site.json + content/ + media/ + skins/<name>/ +
// favicon/ [+ auth-config.json]); one code path used by export, backup, and
// import. These tests drive the low-level, path-injected core directly (no env
// gymnastics, no subprocess) so behaviour is pinned precisely.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const sp = require("../tools/site-package");

// Build a throwaway data dir laid out like /var/lib/featherspress.
function makeDataDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-pkg-"));
  fs.mkdirSync(path.join(dir, "content", "posts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "content", "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media", "2024", "01"), { recursive: true });
  fs.writeFileSync(path.join(dir, "content", "posts", "hello.md"), "---\ntitle: Hello\n---\nHi");
  fs.writeFileSync(path.join(dir, "media", "2024", "01", "pic.png"), "PNGDATA");
  fs.writeFileSync(
    path.join(dir, "site.json"),
    JSON.stringify({ title: "T", skin: "notepad", homeMode: "feed", nav: [] })
  );
  fs.writeFileSync(
    path.join(dir, "auth-config.json"),
    JSON.stringify({ passwordHash: "x", totpSecret: "SECRET", recoveryCodeHashes: [] })
  );
  return dir;
}

function paths(dir) {
  return {
    contentDir: path.join(dir, "content"),
    mediaDir: path.join(dir, "media"),
    manifestPath: path.join(dir, "site.json"),
    authConfigPath: path.join(dir, "auth-config.json"),
    faviconDir: null,
    skin: null,
  };
}

function listTar(tarball) {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

// Build a canonical Site Package *directory* (as the converter emits, or as an
// export unpacks to). `withAuth` adds credentials; `skin` adds skins/<name>/.
function makePackageDir(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-src-"));
  fs.mkdirSync(path.join(dir, "content", "posts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media", "2024", "01"), { recursive: true });
  fs.writeFileSync(path.join(dir, "content", "posts", "hello.md"), "---\ntitle: Hello\n---\nHi");
  fs.writeFileSync(path.join(dir, "media", "2024", "01", "pic.png"), "PNGDATA");
  fs.writeFileSync(
    path.join(dir, "site.json"),
    JSON.stringify({ title: "T", skin: opts.skin || "notepad", homeMode: "feed", nav: [] })
  );
  if (opts.skin) {
    fs.mkdirSync(path.join(dir, "skins", opts.skin, "templates"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skins", opts.skin, "templates", "home.njk"), "X");
  }
  if (opts.withAuth) {
    fs.writeFileSync(
      path.join(dir, "auth-config.json"),
      JSON.stringify({ passwordHash: "pkg", totpSecret: "PKG", recoveryCodeHashes: [] })
    );
  }
  return dir;
}

// Empty target data dir + the target-path bundle importPackage writes into.
function makeTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-dst-"));
  return {
    dir,
    contentDir: path.join(dir, "content"),
    mediaDir: path.join(dir, "media"),
    manifestPath: path.join(dir, "site.json"),
    authConfigPath: path.join(dir, "auth-config.json"),
    skinsDir: path.join(dir, "skins"),
    faviconDir: path.join(dir, "favicon"),
    bundledSkinsDir: path.join(__dirname, "..", "skins"),
  };
}

test("sectionsForProfile maps the two profile names", () => {
  assert.deepStrictEqual(sp.sectionsForProfile("site"), ["content", "media", "site"]);
  assert.deepStrictEqual(sp.sectionsForProfile("full"),
    ["content", "media", "site", "settings", "credentials"]);
});

test("export honours a sections subset", () => {
  const dir = makeDataDir();
  const out = path.join(dir, "subset.tar.gz");
  try {
    sp.exportPackage({ ...paths(dir), profile: "full", sections: ["content"], outFile: out });
    const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
    assert.match(listing, /content\//);
    assert.doesNotMatch(listing, /media\//);
    assert.doesNotMatch(listing, /auth-config\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export with no sections option still packs everything (back-compat)", () => {
  const dir = makeDataDir();
  const out = path.join(dir, "all.tar.gz");
  try {
    sp.exportPackage({ ...paths(dir), profile: "full", outFile: out });
    const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
    assert.match(listing, /content\//);
    assert.match(listing, /media\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export writes settings.json when the section is requested", () => {
  const dir = makeDataDir();
  const out = path.join(dir, "with-settings.tar.gz");
  const unpack = fs.mkdtempSync(path.join(os.tmpdir(), "fp-unpack-"));
  try {
    sp.exportPackage({
      ...paths(dir),
      profile: "full",
      sections: ["content", "settings"],
      outFile: out,
      settings: { schemaVersion: 1, backup: { keepLast: 9 }, update: { autoApply: false } },
    });
    execFileSync("tar", ["-xzf", out, "-C", unpack]);
    const parsed = JSON.parse(fs.readFileSync(path.join(unpack, "settings.json"), "utf8"));
    assert.strictEqual(parsed.backup.keepLast, 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(unpack, { recursive: true, force: true });
  }
});

test("export omits settings.json when the section is requested but no settings are given", () => {
  const dir = makeDataDir();
  const out = path.join(dir, "no-settings.tar.gz");
  try {
    sp.exportPackage({ ...paths(dir), profile: "full", sections: ["content", "settings"], outFile: out });
    const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
    assert.doesNotMatch(listing, /settings\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export --profile site omits auth-config.json but keeps site.json, content, media", () => {
  const dir = makeDataDir();
  const out = path.join(dir, "out.tar.gz");
  try {
    sp.exportPackage({ ...paths(dir), profile: "site", outFile: out });
    const entries = listTar(out);
    assert.ok(entries.includes("site.json"), "site.json present");
    assert.ok(entries.includes("content/posts/hello.md"), "content present");
    assert.ok(entries.includes("media/2024/01/pic.png"), "media present");
    assert.ok(!entries.includes("auth-config.json"), "auth-config.json must be excluded from site profile");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("import installs a package directory into the configured data dir", () => {
  const src = makePackageDir();
  const t = makeTarget();
  try {
    sp.importPackage({ src, ...t, force: true });
    assert.ok(fs.existsSync(path.join(t.contentDir, "posts", "hello.md")), "content restored");
    assert.ok(fs.existsSync(path.join(t.mediaDir, "2024", "01", "pic.png")), "media restored");
    assert.ok(fs.existsSync(t.manifestPath), "site.json restored");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("export then import round-trips through a .tar.gz to an identical tree", () => {
  const data = makeDataDir();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fp-out-")), "pkg.tar.gz");
  const t = makeTarget();
  try {
    sp.exportPackage({ ...paths(data), profile: "site", outFile: out });
    sp.importPackage({ src: out, ...t, force: true });
    assert.strictEqual(
      fs.readFileSync(path.join(t.contentDir, "posts", "hello.md"), "utf8"),
      fs.readFileSync(path.join(data, "content", "posts", "hello.md"), "utf8")
    );
    assert.ok(fs.existsSync(path.join(t.mediaDir, "2024", "01", "pic.png")));
    assert.ok(!fs.existsSync(t.authConfigPath), "site-profile tar carries no auth to restore");
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("import refuses to overwrite existing content without force", () => {
  const src = makePackageDir();
  const t = makeTarget();
  fs.mkdirSync(path.join(t.contentDir, "posts"), { recursive: true });
  fs.writeFileSync(path.join(t.contentDir, "posts", "existing.md"), "keep me");
  try {
    assert.throws(() => sp.importPackage({ src, ...t, force: false }), /refusing to overwrite existing content/i);
    assert.ok(fs.existsSync(path.join(t.contentDir, "posts", "existing.md")), "existing content untouched");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("import uses replace semantics: stale files not in the package are gone", () => {
  const src = makePackageDir();
  const t = makeTarget();
  fs.mkdirSync(path.join(t.contentDir, "posts"), { recursive: true });
  fs.writeFileSync(path.join(t.contentDir, "posts", "stale.md"), "old");
  try {
    sp.importPackage({ src, ...t, force: true });
    assert.ok(!fs.existsSync(path.join(t.contentDir, "posts", "stale.md")), "stale post removed");
    assert.ok(fs.existsSync(path.join(t.contentDir, "posts", "hello.md")), "package post present");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("import rejects a tarball containing a path-traversal entry", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fp-evil-"));
  const evil = path.join(base, "evil.tar.gz");
  fs.writeFileSync(path.join(base, "payload"), "pwned");
  // Rewrite the stored name to escape the extraction dir.
  execFileSync("tar", [
    "-czf", evil, "-C", base, "--transform", "s|payload|../escape.txt|", "payload",
  ]);
  const t = makeTarget();
  try {
    assert.throws(() => sp.importPackage({ src: evil, ...t, force: true }), /unsafe path/i);
    assert.ok(!fs.existsSync(path.join(base, "escape.txt")), "nothing extracted outside the target");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("import restores auth only when present AND restoreAuth is set", () => {
  const t1 = makeTarget();
  const src1 = makePackageDir({ withAuth: true });
  try {
    sp.importPackage({ src: src1, ...t1, force: true, restoreAuth: false });
    assert.ok(!fs.existsSync(t1.authConfigPath), "auth NOT restored without --restore-auth");
  } finally {
    fs.rmSync(src1, { recursive: true, force: true });
    fs.rmSync(t1.dir, { recursive: true, force: true });
  }

  const t2 = makeTarget();
  const src2 = makePackageDir({ withAuth: true });
  try {
    sp.importPackage({ src: src2, ...t2, force: true, restoreAuth: true });
    assert.ok(fs.existsSync(t2.authConfigPath), "auth restored with --restore-auth");
  } finally {
    fs.rmSync(src2, { recursive: true, force: true });
    fs.rmSync(t2.dir, { recursive: true, force: true });
  }
});

test("import fails loudly if the manifest names a skin absent from package and engine", () => {
  const src = makePackageDir();
  // Point the manifest at a skin that exists nowhere.
  fs.writeFileSync(
    path.join(src, "site.json"),
    JSON.stringify({ title: "T", skin: "ghost-skin", homeMode: "feed", nav: [] })
  );
  const t = makeTarget();
  try {
    assert.throws(() => sp.importPackage({ src, ...t, force: true }), /ghost-skin/);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("export --profile full includes auth-config.json, the custom skin, and favicon", () => {
  const dir = makeDataDir();
  fs.mkdirSync(path.join(dir, "skins", "gvm", "templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skins", "gvm", "templates", "home.njk"), "X");
  fs.mkdirSync(path.join(dir, "favicon"), { recursive: true });
  fs.writeFileSync(path.join(dir, "favicon", "favicon.ico"), "ICO");
  const out = path.join(dir, "full.tar.gz");
  try {
    sp.exportPackage({
      ...paths(dir),
      skin: { name: "gvm", dir: path.join(dir, "skins", "gvm") },
      faviconDir: path.join(dir, "favicon"),
      profile: "full",
      outFile: out,
    });
    const entries = listTar(out);
    assert.ok(entries.includes("auth-config.json"), "auth included in full profile");
    assert.ok(entries.includes("skins/gvm/templates/home.njk"), "custom skin included");
    assert.ok(entries.includes("favicon/favicon.ico"), "favicon included");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A "full" artifact is the password hash + the TOTP secret in cleartext. tar
// creates it with the ambient umask (0644), and these land in shared dirs like
// /tmp (the pre-restore snapshot) and /var/backups. Owner-only, always.
test("export --profile full writes the artifact 0600", () => {
  const dir = makeDataDir();
  const full = path.join(dir, "full.tar.gz");
  const site = path.join(dir, "site.tar.gz");
  try {
    sp.exportPackage({ ...paths(dir), profile: "full", outFile: full });
    assert.strictEqual(fs.statSync(full).mode & 0o777, 0o600, "full artifact is 0600");
    // The site profile carries no credentials, so it stays shareable.
    sp.exportPackage({ ...paths(dir), profile: "site", outFile: site });
    assert.notStrictEqual(fs.statSync(site).mode & 0o777, 0o600, "site artifact not forced to 0600");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A symlink member can have a tame NAME ("content/x") and an arbitrary TARGET
// ("/etc"). assertSafeTar only inspects names, so the link survives into the data
// dir, where anything walking the tree may follow it — including the root-restore
// chown, which would hand an arbitrary file to the app user.
test("import refuses a package containing a symlink that escapes the package", () => {
  const dir = makeDataDir();
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "fp-evil-"));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "fp-evil-dst-"));
  try {
    fs.mkdirSync(path.join(pkg, "content", "posts"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "content", "posts", "a.md"), "hi");
    fs.writeFileSync(
      path.join(pkg, "site.json"),
      JSON.stringify({ title: "T", skin: "notepad", homeMode: "feed", nav: [] })
    );
    fs.symlinkSync("/etc", path.join(pkg, "content", "escape"));

    assert.throws(
      () => sp.importPackage({ src: pkg, ...paths(dst), force: true }),
      /unsafe symlink in archive/,
      "an escaping symlink must be refused"
    );

    // A link that stays INSIDE the package is legitimate and must still work.
    fs.rmSync(path.join(pkg, "content", "escape"));
    fs.symlinkSync("posts", path.join(pkg, "content", "alias"));
    sp.importPackage({
      src: pkg,
      ...paths(dst),
      skinsDir: path.join(dst, "skins"),
      bundledSkinsDir: path.join(__dirname, "..", "skins"),
      force: true,
    });
    assert.ok(fs.existsSync(path.join(dst, "content", "posts", "a.md")), "internal link package imports");
  } finally {
    for (const d of [dir, pkg, dst]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// docs/DEPLOY.md step 1 creates an empty /var/lib/featherspress/content, so the
// very first import on a new box must not be treated as an overwrite.
test("import into an existing but EMPTY content dir does not need --force", () => {
  const srcDir = makeDataDir();
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "fp-empty-"));
  try {
    fs.mkdirSync(path.join(dst, "content"), { recursive: true }); // as DEPLOY.md leaves it
    sp.importPackage({
      src: srcDir,
      ...paths(dst),
      skinsDir: path.join(dst, "skins"),
      bundledSkinsDir: path.join(__dirname, "..", "skins"),
      // deliberately NO force
    });
    assert.ok(fs.existsSync(path.join(dst, "content", "posts", "hello.md")), "first import succeeded");

    // With real content present it must still refuse, and name the path.
    assert.throws(
      () =>
        sp.importPackage({
          src: srcDir,
          ...paths(dst),
          skinsDir: path.join(dst, "skins"),
          bundledSkinsDir: path.join(__dirname, "..", "skins"),
        }),
      /refusing to overwrite existing content/
    );
  } finally {
    for (const d of [srcDir, dst]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// The skin name is read from the PACKAGE's site.json — untrusted — and used as a
// path segment under skinsDir, where replaceDir()'s first act is a recursive
// delete. "../media" therefore aims that rm -rf at the operator's data dir, and
// deeper prefixes escape it entirely. Verified destructive before the guard.
test("import rejects a manifest skin name that escapes the skins dir", () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "fp-skinesc-"));
  const t = makeTarget();
  try {
    fs.mkdirSync(path.join(pkg, "content", "posts"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "content", "posts", "a.md"), "hi");
    // The package supplies media/templates/ so the "is the skin present?" probe
    // resolves through the traversal and passes.
    fs.mkdirSync(path.join(pkg, "media", "templates"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "media", "templates", "home.njk"), "X");
    fs.writeFileSync(
      path.join(pkg, "site.json"),
      JSON.stringify({ title: "Evil", skin: "../media", homeMode: "feed", nav: [] })
    );

    fs.mkdirSync(t.mediaDir, { recursive: true });
    fs.writeFileSync(path.join(t.mediaDir, "precious.jpg"), "MUST SURVIVE");

    assert.throws(
      () => sp.importPackage({ src: pkg, ...t, force: true }),
      /unsafe skin/,
      "a traversing skin name must be refused"
    );
    assert.ok(fs.existsSync(path.join(t.mediaDir, "precious.jpg")), "media dir not destroyed");

    for (const bad of ["../../etc", "a/b", "..", ".", "/abs"]) {
      fs.writeFileSync(
        path.join(pkg, "site.json"),
        JSON.stringify({ title: "E", skin: bad, homeMode: "feed", nav: [] })
      );
      assert.throws(() => sp.importPackage({ src: pkg, ...t, force: true }), /unsafe skin/, `rejects ${bad}`);
    }
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

// A full artifact must never exist at the ambient umask, and tar must not follow
// a symlink planted at a predictable output path.
test("export --profile full will not write through a symlink at the output path", () => {
  const data = makeDataDir();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-symout-"));
  const victim = path.join(outDir, "victim.txt");
  const out = path.join(outDir, "artifact.tar.gz");
  try {
    fs.writeFileSync(victim, "ORIGINAL");
    fs.symlinkSync(victim, out);
    sp.exportPackage({ ...paths(data), profile: "full", outFile: out });
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "ORIGINAL", "symlink target untouched");
    assert.ok(!fs.lstatSync(out).isSymbolicLink(), "symlink replaced by a real file");
    assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600, "artifact is 0600");
    // Re-exporting to the same path must still work.
    sp.exportPackage({ ...paths(data), profile: "full", outFile: out });
    assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600, "re-export still 0600");
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
