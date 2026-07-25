"use strict";

// Turns the root-written backup-status.json into the portable settings.json
// half of a Site Package. Pure (parsed status in, settings object out) and
// shared by both the web app (admin/archive.js, /admin export endpoint) and
// the CLI (tools/site-package.js, scheduled `export --profile full`) — this
// lives here, not in admin/, so the CLI path never has to pull in web/admin
// code just to build a settings object.

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

module.exports = { buildSettings };
