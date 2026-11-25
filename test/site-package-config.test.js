"use strict";

// An instance's featherspress.env sets SITE_PACKAGE and nothing else about
// paths. Every per-site file must then live inside that one directory: the
// root agents look for the request and status files there, and the backup
// expects the login there. Run in a child process, since config.js reads the
// environment once, at load time.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function configWith(env) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) {
    if (/^(SITE_|CONTENT_DIR|MEDIA_DIR|AUTH_CONFIG|FAVICON_DIR|UPDATE_|BACKUP_|RESTORE_|IMPORT_)/.test(k)) delete clean[k];
  }
  const out = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./config')))"], {
    cwd: ROOT,
    env: { ...clean, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("SITE_PACKAGE alone puts every per-site file inside the package", () => {
  const pkg = "/var/lib/featherspress/alpha";
  const c = configWith({ SITE_PACKAGE: pkg });
  assert.strictEqual(c.CONTENT_DIR, path.join(pkg, "content"));
  assert.strictEqual(c.MEDIA_DIR, path.join(pkg, "media"));
  assert.strictEqual(c.SITE_MANIFEST, path.join(pkg, "site.json"));
  assert.strictEqual(c.AUTH_CONFIG, path.join(pkg, "auth-config.json"));
  assert.strictEqual(c.SITE_SKINS_DIR, path.join(pkg, "skins"));
  assert.strictEqual(c.SITE_FAVICON_DIR, path.join(pkg, "favicon"));
  for (const k of ["UPDATE_STATUS_FILE", "UPDATE_REQUEST_FILE", "UPDATE_APPLY_STATUS_FILE",
    "BACKUP_REQUEST_FILE", "BACKUP_STATUS_FILE", "RESTORE_REQUEST_FILE", "IMPORT_STAGING_DIR"]) {
    assert.strictEqual(path.dirname(c[k]), pkg, k);
  }
});

test("an explicit AUTH_CONFIG still wins over the package", () => {
  const c = configWith({ SITE_PACKAGE: "/srv/site", AUTH_CONFIG: "/srv/elsewhere/auth.json" });
  assert.strictEqual(c.AUTH_CONFIG, "/srv/elsewhere/auth.json");
});

test("with nothing set, the login file stays beside the engine (the demo setup)", () => {
  const c = configWith({});
  assert.strictEqual(c.AUTH_CONFIG, path.join(ROOT, "auth-config.json"));
});
