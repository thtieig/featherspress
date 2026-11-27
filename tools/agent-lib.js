"use strict";

// Small helpers shared by the two root agents (tools/backup-control.js and
// tools/update-control.js) and the site-package CLI.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// One named instance: every directory and unit name an agent may touch,
// derived from the name alone. The name is INSTANCE, or else the name of the
// checkout this code runs from (/opt/featherspress/<name>), which is how the
// systemd units (they run /opt/featherspress/%i/tools/...) pass it without
// saying so. CONF_DIR, DATA_DIR and BACKUP_ROOT may be moved by the
// environment; the unit names may not. deploy/instance.sh is the shell twin.
const INSTANCE_RE = /^[a-z][a-z0-9-]{0,23}$/;

function instance(env) {
  const engineDir = path.resolve(env.ENGINE_DIR || path.join(__dirname, ".."));
  const name = env.INSTANCE || path.basename(engineDir);
  if (!INSTANCE_RE.test(name)) {
    throw new Error("invalid instance name (lowercase letters, digits and dashes, 24 at most)");
  }
  return {
    name,
    engineDir,
    confDir: env.CONF_DIR || `/etc/featherspress/${name}`,
    dataDir: env.DATA_DIR || `/var/lib/featherspress/${name}`,
    backupRoot: env.BACKUP_ROOT || `/var/backups/featherspress/${name}`,
    service: `featherspress@${name}`,
    backupUnit: `featherspress-backup@${name}`,
  };
}

function fail(error) {
  return { ok: false, error };
}

// Read a request file from the app-writable data dir WITHOUT following a
// symlink, capped at 64 KB. Throws on a symlink, a FIFO or device (opened
// non-blocking, so a FIFO cannot hang root), an oversize file or bad JSON.
function readRequestNoFollow(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > 64 * 1024) throw new Error("request too large");
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return JSON.parse(buf.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

// Parse a shell-style env file (KEY=value lines, as bash would source them)
// without sourcing it. An `export ` prefix is allowed and one layer of
// matching quotes is stripped.
function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Same, from a file; a missing file is an empty config.
function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  return parseEnv(fs.readFileSync(p, "utf8"));
}

// Write a file into the app-owned data dir as root, safely. The site user
// owns that dir, so it can put a symlink at any name in it, and the kernel's
// symlink protection does not cover a dir that is not sticky and world-
// writable. So: a new file under a random name, created exclusively and
// without following a link (O_EXCL), its mode and owner set on the open file
// itself, then renamed over the target. rename() replaces a link planted at
// the target; it never writes through it. `owner` ({uid, gid}) is optional.
function writeFileSafely(target, data, mode, owner) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString("hex")}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    try {
      fs.writeSync(fd, data);
      fs.fchmodSync(fd, mode);
      if (owner) fs.fchownSync(fd, owner.uid, owner.gid);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

// A status file, 0644 so the unprivileged app can read it.
function writeStatusFile(statusPath, obj) {
  writeFileSafely(statusPath, JSON.stringify(obj, null, 2) + "\n", 0o644);
}

// The last request id this agent processed, 0 if none.
function readAppliedId(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")).appliedRequestId || 0;
  } catch {
    return 0;
  }
}

// Delete a request we have finished with (applied or rejected). Left behind,
// it is re-read on every trigger and recorded as "stale" forever, and because
// the app renames new requests into place, the .path unit's watch stays on the
// old inode and the next real request waits for the safety timer.
//
// Only unlink when the file still holds the request we processed: one that
// landed while we were working is the next run's to handle.
function consumeRequest(requestPath, requestId) {
  try {
    if (readRequestNoFollow(requestPath).requestId !== requestId) return;
  } catch {
    return; // unreadable or already gone: nothing safe to remove
  }
  try {
    fs.unlinkSync(requestPath);
  } catch {}
}

// ---- the backups in a site's own backup folder ------------------------------
// deploy/backup.sh names every backup featherspress-full-<UTC stamp>[-<engine
// commit>].tar.gz[.age]. The /admin list, its Download and its Restore all go
// through these, so a name that does not match is never read, served or
// restored, and a request can only ever name a file, never a path.
const BACKUP_NAME_RE = /^featherspress-full-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-([0-9a-f]{7,40}))?\.tar\.gz(\.age)?$/;

function parseBackupName(name) {
  const m = typeof name === "string" && name.match(BACKUP_NAME_RE);
  if (!m) return null;
  return {
    at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
    engine: m[7] || null,
    encrypted: !!m[8],
  };
}

function isInside(root, p) {
  const rel = path.relative(root, p);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Where this site's local backups are: the configured folder when it is inside
// the site's own backup root (the only place backup-control lets it be), else
// the root itself.
function backupDir(localDir, root) {
  if (!root) return null;
  return localDir && isInside(root, path.normalize(localDir)) ? path.normalize(localDir) : root;
}

// Regular files with a backup's name, newest first. A folder that does not
// exist yet is an empty list; any other error (no permission) is thrown.
function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    const meta = parseBackupName(name);
    if (!meta) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // never a symlink or a directory
    out.push({ name, ...meta, size: st.size });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// The full path of one listed backup, or null when the name is not a backup's,
// or the file is missing, a symlink or not a regular file.
function backupFile(dir, name) {
  if (!dir || !parseBackupName(name)) return null;
  const p = path.join(dir, name);
  try {
    return fs.lstatSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

// ---- which engine this is -----------------------------------------------------
// The engine's short commit and package.json version, recorded in every Site
// Package (engine.json) and in a backup's name. Read straight from .git rather
// than by running git: the checkout belongs to the site user, and git refuses
// to work in it as root ("dubious ownership"). Any trouble gives commit null.
function gitDir(engineDir) {
  const dotGit = path.join(engineDir, ".git");
  const st = fs.statSync(dotGit);
  if (st.isDirectory()) return { dir: dotGit, common: dotGit };
  // A worktree: ".git" is a file naming the real git dir, whose refs live in
  // the common dir.
  const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
  const dir = path.resolve(engineDir, m[1].trim());
  let common = dir;
  try {
    common = path.resolve(dir, fs.readFileSync(path.join(dir, "commondir"), "utf8").trim());
  } catch {}
  return { dir, common };
}

function headCommit(engineDir) {
  const { dir, common } = gitDir(engineDir);
  const head = fs.readFileSync(path.join(dir, "HEAD"), "utf8").trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head; // detached
  const ref = (head.match(/^ref:\s*(refs\/[A-Za-z0-9._\/-]+)$/) || [])[1];
  if (!ref || ref.split("/").includes("..")) return null;
  for (const base of [dir, common]) {
    try {
      const v = fs.readFileSync(path.join(base, ref), "utf8").trim();
      if (/^[0-9a-f]{40}$/.test(v)) return v;
    } catch {}
  }
  const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

function engineInfo(engineDir) {
  let commit = null;
  let version = null;
  try {
    const c = headCommit(engineDir);
    commit = c ? c.slice(0, 7) : null;
  } catch {}
  try {
    const v = JSON.parse(fs.readFileSync(path.join(engineDir, "package.json"), "utf8")).version;
    version = typeof v === "string" ? v : null;
  } catch {}
  return { commit, version };
}

module.exports = {
  engineInfo,
  BACKUP_NAME_RE,
  parseBackupName,
  backupDir,
  listBackups,
  backupFile,
  instance,
  fail,
  readRequestNoFollow,
  parseEnv,
  parseEnvFile,
  writeStatusFile,
  writeFileSafely,
  readAppliedId,
  consumeRequest,
};
