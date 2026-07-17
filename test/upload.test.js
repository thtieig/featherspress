"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { saveUpload, sanitizeFilename } = require("../admin/upload");

// A real 1x1 PNG so file-type can sniff it by magic bytes.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

test("saveUpload writes to uploadsRoot/YYYY/MM and returns a /media/ URL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-upload-"));
  const now = new Date("2026-07-15T12:00:00Z");
  const res = await saveUpload(PNG_1x1, "My Photo.PNG", { uploadsRoot: tmp, now });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.url, "/media/2026/07/my-photo.png");
  assert.ok(fs.existsSync(path.join(tmp, "2026", "07", "my-photo.png")));
});

test("saveUpload avoids collisions with -N suffix", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-upload-"));
  const now = new Date("2026-07-15T12:00:00Z");
  const a = await saveUpload(PNG_1x1, "pic.png", { uploadsRoot: tmp, now });
  const b = await saveUpload(PNG_1x1, "pic.png", { uploadsRoot: tmp, now });
  assert.strictEqual(a.url, "/media/2026/07/pic.png");
  assert.strictEqual(b.url, "/media/2026/07/pic-2.png");
});

test("saveUpload rejects a type mismatch (content != extension)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-upload-"));
  const res = await saveUpload(PNG_1x1, "notreally.pdf", { uploadsRoot: tmp });
  assert.strictEqual(res.ok, false);
});

test("sanitizeFilename blocks traversal and stray chars", () => {
  assert.strictEqual(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.strictEqual(sanitizeFilename("weird name!!.PNG"), "weird-name.png");
  assert.ok(!sanitizeFilename("a/../b.png").includes("/"));
});
