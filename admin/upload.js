// Media upload handling, lifted verbatim from the legacy authoring/upload.js
// (magic-byte validation, filename sanitization, collision-safe writes). The
// only Featherspress change: saved files are returned as /media/... URLs and
// callers pass MEDIA_DIR as `uploadsRoot`.

const fs = require("fs");
const path = require("path");

// file-type is ESM-only from v21 ("type": "module") and this server is
// CommonJS. require() of ESM is only unflagged on Node >= 20.19, while
// package.json sets the supported floor at Node 20 -- so import() it
// dynamically (works on every Node 18+) and cache the promise so the module
// is only actually loaded once, on the first upload.
let fileTypePromise = null;
function loadFileType() {
  if (!fileTypePromise) fileTypePromise = import("file-type");
  return fileTypePromise;
}

// Comfortably above the largest legacy attachment (unlocker208.zip, 10.7MB).
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Maps the stored extension to the content types file-type may legitimately
// sniff for it. Deliberately not an identity map -- sniffing is coarser than
// the extension in two ways:
//   - Legacy Office files (.doc/.xls) are OLE2 compound files; file-type
//     reports "cfb" for both and cannot tell Word from Excel apart.
//   - .docx/.xlsx are zip containers, identified by inspecting zip entries,
//     which only works when [Content_Types].xml leads the archive. Otherwise
//     a genuine .docx falls back to plain "zip".
// Absent on purpose: txt/csv (no magic bytes at all -- they cannot be
// positively identified, so they cannot be safely allowed) and svg (can carry
// an inline <script>).
// Object.create(null) means there is no prototype chain to shadow a lookup --
// a file named "evil.constructor" or "evil.__proto__" cannot resolve to an
// inherited Object.prototype member and must fall through to the "not on the
// allowlist" branch below instead of crashing on a missing .includes().
const ALLOWED = Object.assign(Object.create(null), {
  jpg: ["jpg"],
  jpeg: ["jpg"],
  png: ["png"],
  gif: ["gif"],
  webp: ["webp"],
  pdf: ["pdf"],
  zip: ["zip"],
  doc: ["cfb"],
  xls: ["cfb"],
  docx: ["docx", "zip"],
  xlsx: ["xlsx", "zip"],
});

function splitName(originalName) {
  // Windows browsers can submit a full path, and basename() only treats "/"
  // as a separator on posix -- so fold "\" into "/" before taking the base.
  const base = path.basename(String(originalName || "").replace(/\\/g, "/"));
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { stem: base, ext: "" };
  return { stem: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() };
}

function sanitizeFilename(originalName) {
  const { stem, ext } = splitName(originalName);
  // Both stem and extension are independently reduced to [a-z0-9-] / [a-z0-9]
  // with no dots at all -- this holds structurally, regardless of what the
  // caller passes in or whether validateUpload ran first. So the output
  // cannot contain "..", a path separator, a leading dot, or stray markup/NUL
  // bytes -- traversal and injection are structurally impossible here rather
  // than merely filtered for.
  let clean = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 100)
    .replace(/^-+|-+$/g, "");
  if (!clean) clean = "file";
  const cleanExt = ext.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cleanExt ? `${clean}.${cleanExt}` : clean;
}

async function validateUpload(buffer, originalName) {
  const { ext } = splitName(originalName);
  const allowedSniffs = ALLOWED[ext];
  if (!allowedSniffs) {
    return { ok: false, error: `Unsupported file type "${ext ? "." + ext : originalName}"` };
  }

  const { fileTypeFromBuffer } = await loadFileType();
  const sniffed = await fileTypeFromBuffer(buffer);
  if (!sniffed) {
    return { ok: false, error: "Could not identify the file's content" };
  }
  if (!allowedSniffs.includes(sniffed.ext)) {
    return {
      ok: false,
      error: `File content (${sniffed.ext}) does not match its ".${ext}" extension`,
    };
  }
  return { ok: true, ext };
}

async function saveUpload(buffer, originalName, { uploadsRoot, now = new Date() } = {}) {
  // Defence-in-depth: the HTTP layer (multer) is expected to enforce this
  // limit too, but saveUpload must not trust that it always will.
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "File exceeds the maximum upload size" };
  }

  const validation = await validateUpload(buffer, originalName);
  if (!validation.ok) return validation;

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dir = path.join(uploadsRoot, yyyy, mm);
  fs.mkdirSync(dir, { recursive: true });

  const filename = sanitizeFilename(originalName);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";

  // photo.jpg, photo-2.jpg, photo-3.jpg ... -- WordPress's own convention,
  // which is why some legacy filenames already look like this.
  for (let n = 1; n <= 500; n++) {
    const candidate = n === 1 ? filename : `${stem}-${n}${ext}`;
    try {
      // "wx" fails if the path exists, making the check-then-create a single
      // atomic step -- an existsSync() guard could race and silently
      // overwrite an existing file between the check and the write.
      fs.writeFileSync(path.join(dir, candidate), buffer, { flag: "wx" });
      // Featherspress serves uploads at /media/ (was /wp-content/uploads/).
      return { ok: true, url: `/media/${yyyy}/${mm}/${candidate}` };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  return { ok: false, error: "Too many files already share that name" };
}

module.exports = { MAX_UPLOAD_BYTES, ALLOWED, sanitizeFilename, validateUpload, saveUpload };
