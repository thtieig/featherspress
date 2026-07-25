"use strict";

// Artifact helpers for the /admin export + restore path: age encryption, and
// turning the root-written backup-status.json into a portable settings.json.
//
// Encryption is KEY-BASED in both directions. `age -p` cannot be used: it opens
// /dev/tty unconditionally and 1.1.1 has no --passphrase-file, so a web app
// cannot drive it. Decryption pipes the identity to `age -d -i -`, so the
// operator's private key is never written to disk. Note: `-i -` (age's
// "read the identity from stdin" flag), NOT `-i /dev/stdin` — the latter looks
// equivalent from a bash pipeline, but when stdin is supplied via
// execFileSync's `input:` option (as here) it is not an openable device node,
// and age fails with "failed to open file: open /dev/stdin: no such device or
// address". Confirmed empirically on a box with age 1.1.1.

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function encryptToRecipient(inFile, outFile, recipient) {
  if (!recipient) throw new Error("no age recipient configured");
  execFileSync("age", ["-r", recipient, "-o", outFile, inFile], { stdio: "pipe" });
  // age writes 0644; an artifact carrying credentials must not sit world-readable.
  fs.chmodSync(outFile, 0o600);
}

function decryptWithIdentity(inFile, outFile, identityText) {
  try {
    execFileSync("age", ["-d", "-i", "-", "-o", outFile, inFile], {
      input: identityText,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Never echo age's stderr: it is attacker-influenced and adds nothing.
    throw new Error("could not decrypt");
  }
  fs.chmodSync(outFile, 0o600);
}

// The portable half of the box's configuration. Box-specific facts (paths,
// users, NODE_BIN, SESSION_SECRET) are absent by construction — this only ever
// reads fields the root agent already publishes.
function buildSettings(status) {
  const c = (status && status.config) || {};
  const sch = c.schedule || {};
  return {
    schemaVersion: 1,
    backup: {
      destType: c.destType || "local",
      localDir: c.localDir || null,
      remote: c.remote || null,
      remotePath: c.remotePath || null,
      keepLast: typeof c.keepLast === "number" ? c.keepLast : 14,
      schedule: {
        preset: sch.preset || "daily",
        timeOfDay: sch.timeOfDay || "00:24",
        weekday: sch.weekday || null,
      },
      sections: Array.isArray(c.sections) ? c.sections : null,
      ageRecipient: (status && status.ageRecipient) || null,
    },
    update: {
      autoApply: !!(status && status.update && status.update.autoApply),
      repoRef: (status && status.update && status.update.repoRef) || "main",
    },
  };
}

module.exports = { encryptToRecipient, decryptWithIdentity, buildSettings };
