#!/usr/bin/env node
"use strict";

// One-time (or re-run-to-rotate) setup: choose a password, generate a TOTP
// secret for 2FA, and generate 8 one-time recovery codes -- all written to
// auth-config.json (gitignored, never committed). Run this once before
// starting the server for the first time:  node setup.js
//
// Lifted from the legacy authoring/setup.js; only the config path and issuer
// string differ.

const bcrypt = require("bcryptjs");
const { generateSecret, generateURI } = require("otplib");
const qrcodeTerminal = require("qrcode-terminal");
const crypto = require("crypto");
const fs = require("fs");
const readline = require("readline");
const config = require("./config");

const AUTH_CONFIG_PATH = config.AUTH_CONFIG;
const RECOVERY_CODE_COUNT = 8;

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = function (stringToWrite) {
      rl.output.write(rl.line.length === 0 ? stringToWrite : "*");
    };
    rl.question(query, (answer) => {
      rl.close();
      console.log();
      resolve(answer);
    });
  });
}

function generateRecoveryCode() {
  const hex = crypto.randomBytes(4).toString("hex");
  return hex.slice(0, 4) + "-" + hex.slice(4);
}

function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function main() {
  console.log("=== Featherspress setup (password + 2FA + recovery codes) ===\n");

  if (fs.existsSync(AUTH_CONFIG_PATH)) {
    console.log("auth-config.json already exists -- continuing will overwrite it");
    console.log("(any device enrolled with the old QR code, and all old recovery codes, will stop working).\n");
  }

  const password = await askHidden("Choose a password: ");
  if (!password || password.length < 8) {
    console.error("\nPassword must be at least 8 characters. Run again.");
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const totpSecret = generateSecret();
  const otpauthUrl = generateURI({ issuer: "Featherspress", label: "admin", secret: totpSecret });

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify({ passwordHash, totpSecret, recoveryCodeHashes }, null, 2));

  console.log("\nScan this with your authenticator app (Google Authenticator, Authy, 1Password, ...):\n");
  qrcodeTerminal.generate(otpauthUrl, { small: true });
  console.log("\nCan't scan it? Enter this key manually instead: " + totpSecret);
  console.log("Tip: scan the same code into a second device/app too (e.g. a backup");
  console.log("phone) so you're not locked out if you lose the first one.");

  console.log("\nRecovery codes -- each works once, in place of the 6-digit code, if you");
  console.log("lose your authenticator device. Save these somewhere safe now; they are");
  console.log("shown only this one time:\n");
  recoveryCodes.forEach((code) => console.log("  " + code));
  console.log("\nRunning low on unused codes later? Just re-run this script to get a fresh set.");

  console.log("\nSaved to " + AUTH_CONFIG_PATH + " (gitignored -- keep it private).");
  console.log("Start the server with: node server.js");
}

main();
