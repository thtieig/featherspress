"use strict";

// src/settings.js: buildSettings turns the root-written backup-status.json
// into the portable settings.json half of a Site Package. Shared by the
// /admin export endpoint and the CLI (tools/site-package.js).

const test = require("node:test");
const assert = require("node:assert");
const { buildSettings } = require("../src/settings");

test("buildSettings pulls the portable fields out of status", () => {
  const s = buildSettings({
    config: {
      destType: "local",
      localDir: "/var/backups/featherspress",
      keepLast: 14,
      schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" },
      sections: ["content"],
    },
    ageRecipient: "age1abc",
    update: { autoApply: false, repoRef: "main" },
  });
  assert.strictEqual(s.schemaVersion, 1);
  assert.strictEqual(s.backup.keepLast, 14);
  assert.strictEqual(s.backup.schedule.weekday, "Sun");
  assert.strictEqual(s.backup.ageRecipient, "age1abc");
  assert.strictEqual(s.update.autoApply, false);
  assert.strictEqual(s.backup.localDir, "/var/backups/featherspress");
});

test("buildSettings defaults the backup time to 00:20, the shipped timer's time", () => {
  const { DEFAULT_BACKUP_TIME } = require("../src/settings");
  assert.strictEqual(DEFAULT_BACKUP_TIME, "00:20");
  assert.strictEqual(buildSettings({}).backup.schedule.timeOfDay, "00:20");
});
