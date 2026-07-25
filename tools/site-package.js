"use strict";

// site-package: the ONE pack/unpack primitive for Featherspress.
//
// A Site Package is one self-contained blog, laid out exactly like the data dir
// (/var/lib/featherspress):
//
//   site.json            manifest (identity + skin + nav + home mode)
//   content/posts|pages/  Markdown with front matter
//   media/…               uploads, served at /media/
//   skins/<name>/         the active CUSTOM skin (bundled skins ship with the engine)
//   favicon/              per-site icons (optional)
//   auth-config.json      credentials/2FA — ONLY in the "full" profile
//
// export  packs the live data into a .tar.gz (profile "site" = no credentials,
//         portable/shareable; profile "full" = + auth-config.json, disaster
//         recovery). import installs a package (directory OR .tar.gz) back into
//         the data dir. Backups are just `export --profile full` saved off-box.
//
// The core functions take explicit paths (dependency-injected) so they are
// testable without env; the CLI wrapper builds those paths from config.js and
// src/manifest.js. Packing uses the system `tar` (no npm dependency).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// The five sections are the shared unit of export, selective import, and the
// scheduled backup's scope. site.json travels WITH the skin and favicon: the
// manifest names the skin, so splitting them permits a restored manifest
// pointing at a skin that is not there — which kills the service at boot.
const SECTIONS = ["content", "media", "site", "settings", "credentials"];

function sectionsForProfile(profile) {
  return profile === "full" ? [...SECTIONS] : ["content", "media", "site"];
}

// Stage the canonical layout into a fresh temp dir, then tar it. Staging (a
// copy) means a mid-publish write to the live dir can't yield a truncated entry.
function exportPackage(opts) {
  const { contentDir, mediaDir, manifestPath, authConfigPath, faviconDir, skin, profile, outFile } = opts;
  // Omitting `sections` entirely must pack exactly what it packs today (two
  // production boxes' nightly `export --profile full` depends on this).
  const want = new Set(opts.sections || SECTIONS);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fp-export-"));
  try {
    if (want.has("site") && manifestPath && fs.existsSync(manifestPath)) {
      fs.copyFileSync(manifestPath, path.join(stage, "site.json"));
    }
    if (want.has("content") && contentDir && fs.existsSync(contentDir)) {
      fs.cpSync(contentDir, path.join(stage, "content"), { recursive: true });
    }
    if (want.has("media") && mediaDir && fs.existsSync(mediaDir)) {
      fs.cpSync(mediaDir, path.join(stage, "media"), { recursive: true });
    }
    if (want.has("site") && skin && skin.name && skin.dir && fs.existsSync(skin.dir)) {
      fs.cpSync(skin.dir, path.join(stage, "skins", skin.name), { recursive: true });
    }
    if (want.has("site") && faviconDir && fs.existsSync(faviconDir)) {
      fs.cpSync(faviconDir, path.join(stage, "favicon"), { recursive: true });
    }
    // Belt-and-braces: `profile === "full"` stays as a hard gate alongside the
    // section check, so a "site" profile can NEVER emit credentials even if a
    // caller passes sections:["credentials"] by mistake or by malice.
    if (profile === "full" && want.has("credentials") && authConfigPath && fs.existsSync(authConfigPath)) {
      fs.copyFileSync(authConfigPath, path.join(stage, "auth-config.json"));
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    // A "full" artifact carries the password hash and the TOTP secret in
    // cleartext, so it must never exist at the ambient umask (0644) even briefly,
    // and tar must not be allowed to follow a symlink planted at the output path.
    // Create it ourselves first: O_EXCL fails on an existing name (symlink or
    // not), and the 0600 survives because tar then truncates a file that is
    // already there rather than creating one.
    if (profile === "full") {
      // Unlink first so re-exporting to the same path still works — on a symlink
      // this removes the LINK, not its target, so the O_EXCL create below lands
      // on a real file we own.
      fs.rmSync(outFile, { force: true });
      fs.closeSync(fs.openSync(outFile, "wx", 0o600));
    }
    execFileSync("tar", ["-czf", outFile, "-C", stage, "."]);
    if (profile === "full") fs.chmodSync(outFile, 0o600);
    return outFile;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Reject tar members that would escape the extraction dir (absolute paths or a
// `..` segment) BEFORE extracting a single byte.
function assertSafeTar(tarball) {
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  for (const raw of listing.split("\n")) {
    const entry = raw.trim();
    if (!entry) continue;
    const norm = entry.replace(/^\.\//, "");
    if (norm.startsWith("/") || norm.split("/").includes("..")) {
      throw new Error(`unsafe path in archive, refusing to extract: ${entry}`);
    }
  }
}

// assertSafeTar only sees member NAMES. A member can be a symlink whose name is
// perfectly tame ("content/x") but whose TARGET points anywhere ("/etc"), and a
// later member written "through" it would land outside the tree. GNU tar happens
// to refuse that write, but we should not depend on the extractor's goodwill —
// and the symlink itself still gets copied into the data dir, where anything that
// later walks the tree (chown, an uploader, a backup) may follow it.
//
// So after extracting, reject any link that does not resolve inside the package.
function assertNoEscapingLinks(root) {
  const rootResolved = path.resolve(root);
  const contains = (p) => {
    const rel = path.relative(rootResolved, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        // Resolve the link textually, relative to the link's own directory — no
        // realpath, so a link to a not-yet-existing path is still checked.
        const resolved = path.resolve(path.dirname(full), target);
        if (!contains(resolved)) {
          throw new Error(
            `unsafe symlink in archive, refusing to import: ` +
              `${path.relative(rootResolved, full)} -> ${target}`
          );
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(rootResolved);
}

// Resolve a package source (a directory OR a .tar.gz) to a directory on disk.
function resolveSource(src) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    assertNoEscapingLinks(src);
    return { dir: src, cleanup: () => {} };
  }
  assertSafeTar(src);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fp-import-"));
  const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
  try {
    execFileSync("tar", ["-xzf", src, "-C", stage]);
    assertNoEscapingLinks(stage);
  } catch (e) {
    cleanup();
    throw e;
  }
  return { dir: stage, cleanup };
}

function replaceDir(target, source) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

// Install a Site Package into the configured data-dir locations. Replace
// semantics per present section ("make the site look like this package"); auth
// is restored only when present AND explicitly requested.
function importPackage(opts) {
  const {
    src,
    contentDir,
    mediaDir,
    manifestPath,
    authConfigPath,
    skinsDir,
    faviconDir,
    bundledSkinsDir,
    force = false,
    restoreAuth = false,
  } = opts;

  const { dir, cleanup } = resolveSource(src);
  try {
    // Validate the package is renderable before touching the live dir.
    if (!fs.existsSync(path.join(dir, "site.json"))) throw new Error("package missing site.json");
    if (!fs.existsSync(path.join(dir, "content"))) throw new Error("package missing content/");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "site.json"), "utf8"));
    const skinName = manifest.skin;
    // The skin name comes from the PACKAGE's site.json — untrusted input — and is
    // used below as a path segment under skinsDir, where replaceDir()'s first act
    // is a recursive delete. A name like "../media" therefore aims that delete at
    // whatever the operator's data dir holds, and deeper prefixes escape the data
    // dir entirely. It must be one plain directory name, nothing else.
    if (skinName !== undefined && skinName !== null && skinName !== "") {
      if (
        typeof skinName !== "string" ||
        skinName.includes("/") ||
        skinName.includes("\\") ||
        skinName === "." ||
        skinName === ".." ||
        path.basename(skinName) !== skinName
      ) {
        throw new Error(
          `package manifest names an unsafe skin "${skinName}": ` +
            `a skin must be a single directory name, with no path separators`
        );
      }
    }
    if (skinName) {
      const inPkg = fs.existsSync(path.join(dir, "skins", skinName, "templates"));
      const inBundled =
        bundledSkinsDir && fs.existsSync(path.join(bundledSkinsDir, skinName, "templates"));
      if (!inPkg && !inBundled) {
        throw new Error(
          `package manifest names skin "${skinName}" but it is neither in the package nor bundled with the engine`
        );
      }
    }

    // Everything this package will need a destination for must be known BEFORE
    // the first replaceDir: a missing path discovered later throws with content
    // and media already gone, leaving a half-restored data dir and no rollback.
    const required = [
      ["contentDir", contentDir],
      ["mediaDir", mediaDir],
      ["manifestPath", manifestPath],
    ];
    if (skinName && fs.existsSync(path.join(dir, "skins", skinName))) required.push(["skinsDir", skinsDir]);
    if (fs.existsSync(path.join(dir, "favicon"))) required.push(["faviconDir", faviconDir]);
    if (restoreAuth && fs.existsSync(path.join(dir, "auth-config.json"))) {
      required.push(["authConfigPath", authConfigPath]);
    }
    for (const [name, value] of required) {
      if (typeof value !== "string" || value === "") {
        throw new Error(`cannot import: this package needs a ${name}, but none was configured`);
      }
    }

    // Guard against overwriting REAL content, not merely against the directory
    // existing: docs/DEPLOY.md step 1 creates an empty content dir, so testing
    // existence made every first-ever import fail with "already has content" —
    // which was both obstructive and untrue.
    if (!force && fs.existsSync(contentDir) && fs.readdirSync(contentDir).length > 0) {
      throw new Error(
        `refusing to overwrite existing content at ${contentDir} without --force ` +
          `(${fs.readdirSync(contentDir).length} entries)`
      );
    }

    // site.json + content + media are required sections → always replaced.
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.copyFileSync(path.join(dir, "site.json"), manifestPath);
    replaceDir(contentDir, path.join(dir, "content"));
    if (fs.existsSync(path.join(dir, "media"))) {
      replaceDir(mediaDir, path.join(dir, "media"));
    }
    // Optional sections: replaced only when the package carries them.
    if (skinName && fs.existsSync(path.join(dir, "skins", skinName))) {
      replaceDir(path.join(skinsDir, skinName), path.join(dir, "skins", skinName));
    }
    if (fs.existsSync(path.join(dir, "favicon"))) {
      replaceDir(faviconDir, path.join(dir, "favicon"));
    }
    // Credentials: only from a package that carries them, and only on request.
    if (restoreAuth && fs.existsSync(path.join(dir, "auth-config.json"))) {
      fs.copyFileSync(path.join(dir, "auth-config.json"), authConfigPath);
      // Restore must not widen permissions on the password hash + TOTP secret,
      // whatever mode the file had inside the archive.
      fs.chmodSync(authConfigPath, 0o600);
    }
  } finally {
    cleanup();
  }
}

// Build the package paths from runtime config + the resolved manifest. This is
// where the wiring lives (custom-skin detection, favicon, where site.json is);
// the core export/import stay pure and path-injected.
function resolvePackagePaths(config, manifest) {
  const engineRoot = path.dirname(require.resolve("../config"));
  const defaultFavicon = path.join(engineRoot, "public", "favicon");

  // site.json: prefer where the manifest was actually loaded from; fall back to
  // beside content/ (matches src/manifest.js). Never trust config.SITE_MANIFEST
  // alone — it is empty on the live box.
  let manifestPath = manifest && manifest.source;
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    manifestPath = path.join(config.CONTENT_DIR, "..", "site.json");
  }

  // Same per-site skins dir the runtime loads from (config.SITE_SKINS_DIR), so
  // what import writes is what skin.js finds.
  const skinsDir = config.SITE_SKINS_DIR;

  // The active skin is packed only when it is CUSTOM (lives in the per-site
  // skins dir). Bundled skins ship with the engine, so they need not travel.
  let skin = null;
  const skinName = manifest && manifest.skin;
  if (skinName && fs.existsSync(path.join(skinsDir, skinName, "templates"))) {
    skin = { name: skinName, dir: path.join(skinsDir, skinName) };
  }

  // The PER-SITE favicon dir — the same path config.SITE_FAVICON_DIR gives the
  // runtime, so what import writes is what server.js serves. An explicitly-set
  // FAVICON_DIR still wins (it is also first in config.FAVICON_ROOTS). The
  // engine's bundled placeholders are code: never an import target, never packed.
  // Export packs this only if it exists, so a site with no icons of its own
  // exports nothing here.
  const faviconDir =
    config.FAVICON_DIR && path.resolve(config.FAVICON_DIR) !== path.resolve(defaultFavicon)
      ? config.FAVICON_DIR
      : config.SITE_FAVICON_DIR || path.join(config.CONTENT_DIR, "..", "favicon");

  return {
    contentDir: config.CONTENT_DIR,
    mediaDir: config.MEDIA_DIR,
    manifestPath,
    authConfigPath: config.AUTH_CONFIG,
    faviconDir,
    skin,
    skinsDir,
    bundledSkinsDir: config.SKINS_DIR,
  };
}

// Restoring as root leaves root-owned files in the data dir. The site still
// RENDERS (reads work), so nothing looks wrong — but the unprivileged service
// can no longer publish a post or accept an upload, and you find out later.
// When running as root, hand the restored tree back to whoever owns the data
// root, which is the app user on a standard install.
function reownAfterRootRestore(paths) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  const dataRoot = path.dirname(path.resolve(paths.contentDir));
  let owner;
  try {
    owner = fs.statSync(dataRoot);
  } catch {
    return null;
  }
  if (owner.uid === 0 && owner.gid === 0) return null; // data root is root's own; nothing to hand back
  // The whole per-site skins dir, not `paths.skin`: that was resolved BEFORE the
  // import, so on a fresh box (no site.json yet) it is null, and the custom skin
  // the import just wrote — along with the skins dir it created — would stay
  // root-owned. The site would still render, which is exactly the silent
  // half-broken state this function exists to prevent.
  const targets = [
    paths.contentDir,
    paths.mediaDir,
    paths.manifestPath,
    paths.faviconDir,
    paths.authConfigPath,
    paths.skinsDir,
  ].filter((p) => p && fs.existsSync(p));

  // lchown, not chown, and never recurse through a link: chown() FOLLOWS symlinks,
  // so a package carrying `content/x -> /etc/shadow` would hand that file to the
  // app user on a root-run restore. (assertNoEscapingLinks should have rejected
  // such a package already; this is the second lock on the same door.)
  const chownTree = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    fs.lchownSync(p, owner.uid, owner.gid);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) chownTree(path.join(p, e));
  };
  for (const t of targets) chownTree(t);
  return { uid: owner.uid, gid: owner.gid, count: targets.length };
}

// A private 0700 directory for credential-bearing artifacts. The pre-restore
// snapshot used to go straight into /tmp under a fully predictable name
// (featherspress-prerestore-<UTC timestamp>.tar.gz) in a world-WRITABLE dir, so
// a local user could pre-create that path as a symlink and have tar write the
// archive — and the later chmod — through it.
function safeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "featherspress-prerestore-"));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "").replace(/-/g, "").replace("T", "-").slice(0, 15);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") flags.profile = argv[++i];
    else if (a === "--out" || a === "-o") flags.out = argv[++i];
    else if (a === "--force" || a === "-f") flags.force = true;
    else if (a === "--restore-auth") flags.restoreAuth = true;
    else if (a === "--env-file") flags.envFile = argv[++i];
    else if (a === "--allow-engine-dir") flags.allowEngineDir = true;
    else if (a === "--sections") flags.sections = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

// Load a deployment env file (the systemd EnvironmentFile) into process.env so
// the CLI resolves the SAME paths the service uses. Without this, running the
// tool from the engine dir with no env silently resolves to the bundled
// example-site — see the --env-file note in docs/BACKUP-IMPORT-EXPORT.md.
// Already-set vars win, so an explicit `env FOO=…` still overrides the file.
function loadEnvFile(file) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    // Empty counts as unset, matching config.js's env() semantics.
    const cur = process.env[m[1]];
    if (cur === undefined || cur === "") process.env[m[1]] = v;
  }
}

// Refuse to write into the engine's own checkout. `import` with no env resolves
// CONTENT_DIR to the bundled example-site/, and because the app user owns the
// code dir the restore SUCCEEDS: it clobbers git-tracked files, writes
// auth-config.json into the code dir, and leaves the real site empty while
// printing "imported package". That is the worst possible failure mode for a
// disaster restore, so make it loud instead.
function assertNotEngineDir(contentDir, engineRoot, allow) {
  if (allow) return;
  const rel = path.relative(engineRoot, path.resolve(contentDir));
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(
      `refusing to import into the engine's own directory:\n` +
        `  target content dir: ${path.resolve(contentDir)}\n` +
        `  engine dir:         ${engineRoot}\n` +
        `This means no deployment config was loaded, so the paths fell back to the\n` +
        `bundled example-site. Point the tool at your deployment's env file:\n` +
        `  --env-file /etc/featherspress/featherspress.env\n` +
        `(or pass CONTENT_DIR/MEDIA_DIR/AUTH_CONFIG/FAVICON_DIR in the environment).\n` +
        `If you really do mean the engine dir, pass --allow-engine-dir.`
    );
  }
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  // Must happen BEFORE config.js is required: it reads process.env at load time.
  if (flags.envFile) loadEnvFile(flags.envFile);
  const config = require("../config");
  const manifest = require("../src/manifest").load();
  const paths = resolvePackagePaths(config, manifest);

  if (cmd === "export") {
    const profile = flags.profile || "site";
    if (profile !== "site" && profile !== "full") throw new Error(`unknown profile: ${profile}`);
    const outFile = flags.out || path.join(process.cwd(), `featherspress-${profile}-${timestamp()}.tar.gz`);
    const sections = flags.sections
      ? flags.sections.split(",").map((s) => s.trim()).filter(Boolean)
      : sectionsForProfile(profile);
    for (const s of sections) {
      if (!SECTIONS.includes(s)) throw new Error(`unknown section: ${s}`);
    }
    exportPackage({ ...paths, profile, sections, outFile });
    process.stderr.write(`exported ${profile} package → ${outFile}\n`);
    return outFile;
  }

  if (cmd === "import") {
    const src = positional[0];
    if (!src) throw new Error("usage: import <dir|tar.gz> [--force] [--restore-auth]");
    assertNotEngineDir(paths.contentDir, path.dirname(require.resolve("../config")), flags.allowEngineDir);
    // Say where the data is going BEFORE touching it: a restore that silently
    // targets the wrong tree is indistinguishable from one that worked.
    process.stderr.write(
      `restoring into:\n  content: ${paths.contentDir}\n  media:   ${paths.mediaDir}\n` +
        `  manifest: ${paths.manifestPath}\n  skins:   ${paths.skinsDir}\n` +
        `  favicon: ${paths.faviconDir}\n  auth:    ${paths.authConfigPath}${flags.restoreAuth ? "" : " (not restored; pass --restore-auth)"}\n`
    );
    // Pre-restore safety backup of the CURRENT data (full, so nothing is lost),
    // written outside the data dir so a failed restore can't evict it.
    //
    // Only once we know the import will actually be attempted: this snapshot is a
    // "full" export (password hash + cleartext TOTP secret), and an import that is
    // about to be refused for want of --force should not leave one lying around
    // for an operator who reasonably assumes nothing happened.
    const hasExistingData =
      fs.existsSync(paths.contentDir) && fs.readdirSync(paths.contentDir).length > 0;
    if (hasExistingData && !flags.force) {
      throw new Error(
        `refusing to overwrite existing content at ${paths.contentDir} without --force`
      );
    }
    if (hasExistingData) {
      const safety = path.join(safeTmpDir(), `featherspress-prerestore-${timestamp()}.tar.gz`);
      exportPackage({ ...paths, profile: "full", outFile: safety });
      process.stderr.write(`pre-restore backup of current data → ${safety}\n`);
    }
    importPackage({ src, ...paths, force: !!flags.force, restoreAuth: !!flags.restoreAuth });
    const reowned = reownAfterRootRestore(paths);
    if (reowned) {
      process.stderr.write(`restored as root — handed the data back to uid ${reowned.uid}:${reowned.gid}\n`);
    }
    process.stderr.write(`imported package from ${src}\n`);
    return;
  }

  throw new Error(`usage: site-package <export|import> [...]\n  got: ${cmd || "(nothing)"}`);
}

module.exports = { exportPackage, importPackage, resolvePackagePaths, main, SECTIONS, sectionsForProfile };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}
