"use strict";

// Small helpers shared by the two root agents (tools/backup-control.js and
// tools/update-control.js) and the site-package CLI.

const fs = require("node:fs");

function fail(error) {
  return { ok: false, error };
}

// Read a request file from the app-writable data dir WITHOUT following a
// symlink, capped at 64 KB. Throws on a symlink, an oversize file or bad JSON.
function readRequestNoFollow(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
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

// Write a status file atomically (temp file + rename), 0644 so the
// unprivileged app can read it.
function writeStatusFile(statusPath, obj) {
  const tmp = statusPath + ".tmp";
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, statusPath);
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

module.exports = {
  fail,
  readRequestNoFollow,
  parseEnv,
  parseEnvFile,
  writeStatusFile,
  readAppliedId,
  consumeRequest,
};
