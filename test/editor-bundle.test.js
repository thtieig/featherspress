"use strict";

// The vendored editor bundle (built by tools/editor-bundle/build.js) must carry
// a DOMPurify 3.x, not the 2.3.3 copy @toast-ui/editor 3.2.2 ships inline.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const BUNDLE = fs.readFileSync(
  path.join(__dirname, "..", "admin", "public", "vendor", "toastui-editor.bundle.js"),
  "utf8"
);

test("the editor bundle embeds exactly one DOMPurify, version 3.x", () => {
  const versions = [...BUNDLE.matchAll(/\.version="([0-9.]+)"/g)].map((m) => m[1]);
  assert.strictEqual(versions.length, 1, `DOMPurify versions found: ${versions}`);
  assert.match(versions[0], /^3\./);
});
