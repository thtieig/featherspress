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

// Stage the canonical layout into a fresh temp dir, then tar it. Staging (a
// copy) means a mid-publish write to the live dir can't yield a truncated entry.
function exportPackage(opts) {
  const { contentDir, mediaDir, manifestPath, authConfigPath, faviconDir, skin, profile, outFile } = opts;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fp-export-"));
  try {
    if (manifestPath && fs.existsSync(manifestPath)) {
      fs.copyFileSync(manifestPath, path.join(stage, "site.json"));
    }
    if (contentDir && fs.existsSync(contentDir)) {
      fs.cpSync(contentDir, path.join(stage, "content"), { recursive: true });
    }
    if (mediaDir && fs.existsSync(mediaDir)) {
      fs.cpSync(mediaDir, path.join(stage, "media"), { recursive: true });
    }
    if (skin && skin.name && skin.dir && fs.existsSync(skin.dir)) {
      fs.cpSync(skin.dir, path.join(stage, "skins", skin.name), { recursive: true });
    }
    if (faviconDir && fs.existsSync(faviconDir)) {
      fs.cpSync(faviconDir, path.join(stage, "favicon"), { recursive: true });
    }
    if (profile === "full" && authConfigPath && fs.existsSync(authConfigPath)) {
      fs.copyFileSync(authConfigPath, path.join(stage, "auth-config.json"));
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    execFileSync("tar", ["-czf", outFile, "-C", stage, "."]);
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

// Resolve a package source (a directory OR a .tar.gz) to a directory on disk.
function resolveSource(src) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) return { dir: src, cleanup: () => {} };
  assertSafeTar(src);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fp-import-"));
  execFileSync("tar", ["-xzf", src, "-C", stage]);
  return { dir: stage, cleanup: () => fs.rmSync(stage, { recursive: true, force: true }) };
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

    if (!force && fs.existsSync(contentDir)) {
      throw new Error("target data dir already has content; refusing to overwrite without force");
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

  // The PER-SITE favicon dir. config.FAVICON_DIR points at the engine's bundled
  // placeholders unless the operator overrode it, and those are engine code:
  // never an import target, never worth packing. So when it is the default,
  // resolve the per-site location beside content/, as skins and site.json do.
  // Export still packs this only if it exists on disk, so a site that never set
  // its own icons exports nothing here.
  const faviconDir =
    config.FAVICON_DIR && path.resolve(config.FAVICON_DIR) !== path.resolve(defaultFavicon)
      ? config.FAVICON_DIR
      : path.join(config.CONTENT_DIR, "..", "favicon");

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
    else positional.push(a);
  }
  return { flags, positional };
}

function main(argv = process.argv.slice(2)) {
  const config = require("../config");
  const manifest = require("../src/manifest").load();
  const paths = resolvePackagePaths(config, manifest);
  const cmd = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));

  if (cmd === "export") {
    const profile = flags.profile || "site";
    if (profile !== "site" && profile !== "full") throw new Error(`unknown profile: ${profile}`);
    const outFile = flags.out || path.join(process.cwd(), `featherspress-${profile}-${timestamp()}.tar.gz`);
    exportPackage({ ...paths, profile, outFile });
    process.stderr.write(`exported ${profile} package → ${outFile}\n`);
    return outFile;
  }

  if (cmd === "import") {
    const src = positional[0];
    if (!src) throw new Error("usage: import <dir|tar.gz> [--force] [--restore-auth]");
    // Pre-restore safety backup of the CURRENT data (full, so nothing is lost),
    // written outside the data dir so a failed restore can't evict it.
    if (fs.existsSync(paths.contentDir) && fs.readdirSync(paths.contentDir).length) {
      const safety = path.join(os.tmpdir(), `featherspress-prerestore-${timestamp()}.tar.gz`);
      exportPackage({ ...paths, profile: "full", outFile: safety });
      process.stderr.write(`pre-restore backup of current data → ${safety}\n`);
    }
    importPackage({ src, ...paths, force: !!flags.force, restoreAuth: !!flags.restoreAuth });
    process.stderr.write(`imported package from ${src}\n`);
    return;
  }

  throw new Error(`usage: site-package <export|import> [...]\n  got: ${cmd || "(nothing)"}`);
}

module.exports = { exportPackage, importPackage, resolvePackagePaths, main };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}
