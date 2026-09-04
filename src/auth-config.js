"use strict";

// Auth config (auth-config.json): password hash + TOTP secret + recovery-code
// hashes, all in one gitignored file. This module owns the atomic-write
// primitive (shared by admin/router.js's recovery-code consumption and
// setup.js's password-only reset) plus the password-only reset logic itself.

const bcrypt = require("bcryptjs");
const fs = require("fs");

function writeAuthConfigAtomic(configPath, data) {
  const tmpPath = configPath + ".tmp";
  // 0600 on the temp file, so the rename can never publish a world-readable
  // copy of the TOTP secret even for an instant. writeFileSync's mode applies
  // only when it CREATES the file, so a 0644 leftover from an earlier crash
  // would otherwise keep its mode and be renamed into place — chmod explicitly.
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  // Best-effort: preserve the EXISTING file's owner across the rewrite. This
  // matters for the recovery path (setup.js --password-only run by an
  // operator over SSH, per docs/DEPLOY.md's Account recovery section): run
  // as root, this rename would otherwise publish a root:root
  // auth-config.json that the unprivileged app user can no longer read,
  // turning a password lockout into a total outage. Same fs.chownSync
  // idiom as tools/backup-control.js's generateAgeKey. Wrapped so a failure
  // to chown is a silent no-op, not a hard requirement: the NORMAL caller is
  // the app itself, running as its own unprivileged user, which cannot
  // chown to anyone — that must not make this function throw.
  try {
    const st = fs.statSync(configPath);
    fs.chownSync(tmpPath, st.uid, st.gid);
  } catch {}
  fs.renameSync(tmpPath, configPath);
}

// Rotates just the password hash, leaving totpSecret/recoveryCodeHashes (and
// anything else already in the file) untouched. Validates fully before
// touching disk, so a bad call never partially writes.
function resetPassword(configPath, newPassword) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`No auth config at ${configPath} -- run \`node setup.js\` first.`);
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${configPath}: ${err.message}`);
  }
  const passwordHash = bcrypt.hashSync(newPassword, 12);
  writeAuthConfigAtomic(configPath, { ...existing, passwordHash });
}

module.exports = { writeAuthConfigAtomic, resetPassword };
