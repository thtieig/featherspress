"use strict";

// /admin refuses to run (503 on every route) unless SESSION_SECRET is a real
// secret: set, not a placeholder, at least 32 characters. The public site is
// not affected.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");

const ROUTER = require.resolve("../admin/router");
const CONFIG = require.resolve("../config");

// Load a fresh copy of the admin router with SESSION_SECRET set to `secret`
// (undefined = unset) and return the status of GET /admin/login.
async function loginStatus(secret) {
  if (secret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = secret;
  delete require.cache[ROUTER];
  delete require.cache[CONFIG];
  const app = express();
  app.use("/admin", require(ROUTER));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/login`);
    await res.text();
    return res.status;
  } finally {
    server.close();
  }
}

// The placeholder shipped in the env example must never work as a secret.
const EXAMPLE = fs
  .readFileSync(path.join(__dirname, "..", "deploy", "featherspress.env.example"), "utf8")
  .match(/^SESSION_SECRET=(.*)$/m)[1];

for (const [label, secret] of [
  ["missing", undefined],
  ["empty", ""],
  ["the dev default", "dev-insecure-change-me"],
  ["the env example placeholder", EXAMPLE],
  ["any CHANGE_ME value, however long", "CHANGE_ME_" + "x".repeat(40)],
  ["31 characters", "a".repeat(31)],
]) {
  test(`admin is disabled when SESSION_SECRET is ${label}`, async () => {
    assert.strictEqual(await loginStatus(secret), 503);
  });
}

test("admin runs with a secret from `openssl rand -hex 32`", async () => {
  assert.strictEqual(await loginStatus(crypto.randomBytes(32).toString("hex")), 200);
});

test("admin runs with exactly 32 characters", async () => {
  assert.strictEqual(await loginStatus("b".repeat(32)), 200);
});
