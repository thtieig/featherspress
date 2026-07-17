"use strict";

// Admin router, mounted at /admin. Adapted from the legacy authoring/server.js:
//   - No build step. After every write we call posts.reload() so the public
//     site's in-memory list reflects the change immediately (publishing is
//     instant: just write the .md).
//   - Content dirs / media dir / auth config come from config.
//   - Media lives at /media/ (was /wp-content/uploads/).
//   - Drafts: a `status: draft` field; drafts 404 on the public site and are
//     viewable only via the authenticated /admin/preview/:type/:slug route.
// Auth (password + TOTP + one-time recovery codes), rate limiting, sessions,
// upload validation, and the media usage/orphan logic are kept verbatim.

const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { verify: verifyTotp } = require("otplib");
const matter = require("gray-matter");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const config = require("../config");
const posts = require("../src/posts");
const render = require("../src/render");
const contract = require("../src/contract");
const { MAX_UPLOAD_BYTES, saveUpload } = require("./upload");

const POSTS_DIR = path.join(config.CONTENT_DIR, "posts");
const PAGES_DIR = path.join(config.CONTENT_DIR, "pages");
const MEDIA_DIR = config.MEDIA_DIR;
const AUTH_CONFIG_PATH = config.AUTH_CONFIG;
const PUBLIC_DIR = path.join(__dirname, "public");

const router = express.Router();
router.use(express.json());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

function writeAuthConfigAtomic(data) {
  const tmpPath = AUTH_CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, AUTH_CONFIG_PATH);
}

// Use a stable secret from config when one is set (production), else a random
// per-start secret (dev). Either way the session STORE is in-memory, so a
// restart still requires signing in again, which is fine for a single-author tool.
const SESSION_SECRET =
  config.SESSION_SECRET && config.SESSION_SECRET !== "dev-insecure-change-me"
    ? config.SESSION_SECRET
    : crypto.randomBytes(32).toString("hex");

router.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: "auto", // honors trust-proxy: secure behind Apache TLS, plain for local dev
      path: "/admin",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

// ---- Auth: password + TOTP (2FA), gates everything below -----------------

router.get("/login", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

router.post("/api/login", loginLimiter, async (req, res) => {
  if (!fs.existsSync(AUTH_CONFIG_PATH)) {
    return res.status(500).json({ error: "Not set up yet -- run `node setup.js` first." });
  }
  const authConfig = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, "utf8"));
  const { passwordHash, totpSecret, recoveryCodeHashes = [] } = authConfig;
  const { password, code } = req.body;
  if (!password || !code || typeof code !== "string") return res.status(400).json({ error: "Password and code required" });
  if (!bcrypt.compareSync(password, passwordHash)) {
    return res.status(401).json({ error: "Wrong password" });
  }
  let totpResult;
  try {
    totpResult = await verifyTotp({ secret: totpSecret, token: code, epochTolerance: 30 });
  } catch {
    totpResult = { valid: false };
  }
  if (totpResult.valid) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  // One-time recovery code fallback (SHA-256 of the normalized code).
  const codeHash = crypto.createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
  const matchIndex = recoveryCodeHashes.indexOf(codeHash);
  if (matchIndex === -1) {
    return res.status(401).json({ error: "Wrong or expired code" });
  }
  const remaining = recoveryCodeHashes.filter((_, i) => i !== matchIndex);
  writeAuthConfigAtomic({ ...authConfig, recoveryCodeHashes: remaining });
  req.session.authenticated = true;
  res.json({ ok: true });
});

router.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Public, pre-auth: login page favicon.
router.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "favicon.ico"));
});

// The auth gate. Everything below requires a session.
router.use((req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  return res.redirect("/admin/login");
});

router.use(express.static(PUBLIC_DIR));

// ---- content helpers -----------------------------------------------------

// The body is Markdown, authored by the single, authenticated site owner, and
// is stored verbatim: the renderer (src/render.js) runs markdown-it with
// `html: false`, so any raw HTML is escaped to text at render time, and its
// default link validation blocks `javascript:` URLs. Sanitizing here as if the
// body were HTML would destroy legitimate `<word>` placeholder prose (e.g.
// "<hostname>"). That is a data-loss bug, and it adds no safety the renderer
// doesn't already provide. (`format: html` verbatim bodies can't be set via this API.)
function normalizeBody(body) {
  return body == null ? "" : String(body);
}

function slugify(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Parse a frontmatter date value to milliseconds for sorting (a Date object, or
// a "YYYY-MM-DD HH:MM:SS" string needing the space→T fix). Unparseable → 0.
function dateMs(value) {
  if (value instanceof Date) return value.getTime();
  if (value == null) return 0;
  const d = new Date(String(value).replace(" ", "T"));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// Object.create(null): a bogus `type` (e.g. "constructor") can't resolve to an
// inherited member and falls through as "unknown type".
const DIR_FOR = Object.assign(Object.create(null), { post: POSTS_DIR, page: PAGES_DIR });

function statusOf(data) {
  return data.status === "draft" ? "draft" : "published";
}

function readContentDir(dir, type) {
  fs.mkdirSync(dir, { recursive: true });
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = matter.read(path.join(dir, f));
      return {
        type,
        slug: file.data.slug || f.replace(/\.md$/, ""),
        title: file.data.title || "(untitled)",
        date: file.data.date || "",
        postTags: file.data.postTags || [],
        status: statusOf(file.data),
        filename: f,
      };
    });
}

function readAllPosts() {
  return readContentDir(POSTS_DIR, "post").sort((a, b) => dateMs(b.date) - dateMs(a.date));
}

function readAllContent() {
  return [...readContentDir(POSTS_DIR, "post"), ...readContentDir(PAGES_DIR, "page")].sort(
    (a, b) => dateMs(b.date) - dateMs(a.date)
  );
}

function findContent(type, slug) {
  const dir = DIR_FOR[type];
  if (!dir) return null;
  const item = readContentDir(dir, type).find((p) => p.slug === slug);
  return item ? { item, dir } : null;
}

function vocab() {
  const tagMap = new Map();
  for (const p of readAllPosts()) {
    for (const t of p.postTags) {
      const existing = tagMap.get(t.slug);
      tagMap.set(t.slug, { name: t.name, count: (existing?.count || 0) + 1 });
    }
  }
  return {
    tags: [...tagMap.entries()]
      .map(([slug, v]) => ({ slug, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count),
  };
}

function normTagName(s) {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

// Canonical tag by normalized name: the most-used existing tag wins. Lets a
// re-typed tag reattach to the existing one instead of forking a new slug:
// e.g. typing "linux" reuses the incumbent {name:"linux", slug:"linux-2"}
// rather than minting a fresh "linux" slug (the near-duplicate bug).
function canonicalTagMap() {
  const best = new Map(); // normName -> {name, slug, count}
  for (const t of vocab().tags) {
    const key = normTagName(t.name);
    const cur = best.get(key);
    if (!cur || t.count > cur.count) best.set(key, { name: t.name, slug: t.slug, count: t.count });
  }
  return best;
}

function termList(namesCsv) {
  const canonical = canonicalTagMap();
  return (namesCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => {
      const hit = canonical.get(normTagName(name));
      // Reuse the existing tag's canonical name + slug; else a brand-new tag.
      return hit ? { name: hit.name, slug: hit.slug } : { name, slug: slugify(name) };
    });
}

// Apply a status value to a frontmatter data object: draft is stored
// explicitly; published removes the key so files match the 208 legacy posts
// (missing status = published).
function applyStatus(data, status) {
  if (status === "draft") data.status = "draft";
  else delete data.status;
  return data;
}

// ---- media usage index (adapted: /media/ prefix) -------------------------

const UPLOAD_REF_RE = /\/media\/[A-Za-z0-9._~%/-]+/g;
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif"]);

function decodePath(p) {
  try {
    return decodeURIComponent(String(p || ""));
  } catch {
    return String(p || "");
  }
}

function buildUsageIndex() {
  const usage = new Map();
  for (const item of readAllContent()) {
    const file = matter.read(path.join(DIR_FOR[item.type], item.filename));
    const seen = new Set();
    for (const raw of file.content.match(UPLOAD_REF_RE) || []) {
      const key = decodePath(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!usage.has(key)) usage.set(key, []);
      usage.get(key).push({ type: item.type, slug: item.slug, title: item.title });
    }
  }
  return usage;
}

function listMediaFiles(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMediaFiles(abs, base));
    else if (entry.isFile()) {
      const rel = path.relative(base, abs).split(path.sep).join("/");
      out.push({ abs, urlPath: `/media/${rel}` });
    }
  }
  return out;
}

// Resolve a client /media/... path to an absolute path provably inside
// MEDIA_DIR (blocks traversal, absolute paths, symlink escapes, missing files).
function resolveUploadPath(urlPath) {
  const prefix = "/media/";
  const decoded = decodePath(urlPath);
  if (!decoded.startsWith(prefix)) return null;
  const abs = path.resolve(MEDIA_DIR, decoded.slice(prefix.length));
  const within = path.relative(MEDIA_DIR, abs);
  if (within.startsWith("..") || path.isAbsolute(within)) return null;
  if (!fs.existsSync(abs)) return null;
  const realRoot = fs.realpathSync(MEDIA_DIR);
  const realAbs = fs.realpathSync(abs);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) return null;
  return abs;
}

function orphansOf(type, slug) {
  const usage = buildUsageIndex();
  const orphans = [];
  for (const [urlPath, refs] of usage) {
    const others = refs.filter((r) => !(r.type === type && r.slug === slug));
    if (refs.length && others.length === 0) orphans.push(urlPath);
  }
  return orphans;
}

// ---- API -----------------------------------------------------------------

router.get("/api/posts", (req, res) => {
  res.json(readAllContent());
});

router.get("/api/meta", (req, res) => {
  res.json(vocab());
});

router.get("/api/post/:type/:slug", (req, res) => {
  const found = findContent(req.params.type, req.params.slug);
  if (!found) return res.status(404).json({ error: "not found" });
  const file = matter.read(path.join(found.dir, found.item.filename));
  res.json({
    type: found.item.type,
    slug: found.item.slug,
    title: file.data.title,
    date: file.data.date,
    postTags: file.data.postTags || [],
    status: statusOf(file.data),
    body: file.content.trim(),
  });
});

router.get("/api/post/:type/:slug/orphans", (req, res) => {
  const found = findContent(req.params.type, req.params.slug);
  if (!found) return res.status(404).json({ error: "not found" });
  res.json({ orphans: orphansOf(found.item.type, found.item.slug) });
});

router.post("/api/post", (req, res) => {
  const { title, tags, body, type, status } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: "Title is required" });

  const contentType = type === "page" ? "page" : "post";
  // A title made only of non-ASCII/symbol characters slugifies to "", which
  // would write ".md" and be unreachable at /:slug. Fall back to a safe,
  // near-unique slug so the content is still addressable.
  let slug = slugify(title);
  if (!slug) slug = `${contentType}-${Date.now().toString(36)}`;
  const dir = DIR_FOR[contentType];
  fs.mkdirSync(dir, { recursive: true });

  // Posts and pages share the /:slug/ URL space, so slug must be unique across both.
  for (const t of ["post", "page"]) {
    if (fs.existsSync(path.join(DIR_FOR[t], `${slug}.md`))) {
      return res.status(409).json({ error: `A ${t} with slug "${slug}" already exists` });
    }
  }

  const data = applyStatus(
    {
      title: title.trim(),
      date: new Date(), // a real Date -> unquoted YAML timestamp
      slug,
      postTags: termList(tags),
    },
    status
  );
  fs.writeFileSync(path.join(dir, `${slug}.md`), matter.stringify(normalizeBody(body), data));
  posts.reload();
  res.json({ ok: true, type: contentType, slug, status: statusOf(data), url: `/${slug}/` });
});

router.put("/api/post/:type/:slug", (req, res) => {
  const found = findContent(req.params.type, req.params.slug);
  if (!found) return res.status(404).json({ error: "not found" });

  const filePath = path.join(found.dir, found.item.filename);
  const existing = matter.read(filePath);
  const { title, tags, body, status } = req.body;

  const data = {
    ...existing.data,
    // Guard non-string titles (e.g. JSON null), since `.trim()` on them would 500.
    title: typeof title === "string" ? title.trim() : existing.data.title,
    postTags: tags !== undefined ? termList(tags) : existing.data.postTags,
  };
  if (status !== undefined) applyStatus(data, status);
  const newBody = body !== undefined ? normalizeBody(body) : existing.content.trim();
  fs.writeFileSync(filePath, matter.stringify(newBody, data));
  posts.reload();
  res.json({ ok: true, type: found.item.type, slug: found.item.slug, status: statusOf(data), url: `/${found.item.slug}/` });
});

// Draft/publish toggle.
router.post("/api/post/:type/:slug/status", (req, res) => {
  const found = findContent(req.params.type, req.params.slug);
  if (!found) return res.status(404).json({ error: "not found" });
  const status = req.body && req.body.status === "draft" ? "draft" : "published";
  const filePath = path.join(found.dir, found.item.filename);
  const existing = matter.read(filePath);
  const data = applyStatus({ ...existing.data }, status);
  fs.writeFileSync(filePath, matter.stringify(existing.content.trim(), data));
  posts.reload();
  res.json({ ok: true, status });
});

router.delete("/api/post/:type/:slug", (req, res) => {
  const found = findContent(req.params.type, req.params.slug);
  if (!found) return res.status(404).json({ error: "not found" });

  // Orphan cleanup runs while the .md still exists so the usage index still
  // attributes attachments to it; the server decides what is a true orphan.
  const removedAttachments = [];
  if (req.body && req.body.deleteOrphans) {
    for (const urlPath of orphansOf(found.item.type, found.item.slug)) {
      const abs = resolveUploadPath(urlPath);
      if (abs) {
        try {
          fs.unlinkSync(abs);
          removedAttachments.push(urlPath);
        } catch {
          /* best-effort; a failed attachment unlink must not abort the delete */
        }
      }
    }
  }

  fs.unlinkSync(path.join(found.dir, found.item.filename));
  posts.reload();
  res.json({ ok: true, deletedAttachments: removedAttachments });
});

// ---- draft preview (authenticated; public URL still 404s drafts) ---------
router.get("/preview/:type/:slug", (req, res) => {
  const found = findContent(req.params.type, req.params.slug);
  if (!found) return res.status(404).type("html").send(contract.notFound());
  const file = matter.read(path.join(found.dir, found.item.filename));
  const item = {
    type: found.item.type,
    slug: found.item.slug,
    title: file.data.title || found.item.slug,
    date: file.data.date ? new Date(String(file.data.date).replace(" ", "T")) : null,
    postTags: file.data.postTags || [],
    status: statusOf(file.data),
    format: file.data.format === "html" ? "html" : "markdown",
    body: file.content,
  };
  const bodyHtml = render.render(item);
  const html = item.type === "page" ? contract.pageView(item, bodyHtml) : contract.postPage(item, bodyHtml);
  res.type("html").send(html);
});

// ---- media ---------------------------------------------------------------

router.get("/api/media", (req, res) => {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const usage = buildUsageIndex();
  const files = listMediaFiles(MEDIA_DIR, MEDIA_DIR).map((f) => {
    const key = decodePath(f.urlPath);
    const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    let size = 0;
    try {
      size = fs.statSync(f.abs).size;
    } catch {
      /* vanished between listing and stat */
    }
    return { path: f.urlPath, size, kind: IMAGE_EXTS.has(ext) ? "image" : "other", usage: usage.get(key) || [] };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  res.json(files);
});

router.delete("/api/media", (req, res) => {
  const urlPath = req.body && req.body.path;
  const force = !!(req.body && req.body.force);
  const abs = resolveUploadPath(urlPath);
  if (!abs) return res.status(400).json({ error: "Invalid or unknown file path" });

  const refs = buildUsageIndex().get(decodePath(urlPath)) || [];
  if (refs.length && !force) {
    return res.status(409).json({ error: "File is in use", referencedBy: refs });
  }
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    return res.status(500).json({ error: "Could not delete the file: " + err.message });
  }
  res.json({ ok: true, referencedBy: refs });
});

router.get("/api/tag-audit", (req, res) => {
  const { tags } = vocab();
  const singleUse = tags.filter((t) => t.count === 1);
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const groups = new Map();
  for (const t of tags) {
    const key = norm(t.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const nearDuplicates = [...groups.values()].filter((g) => g.length > 1);
  res.json({ total: tags.length, singleUseCount: singleUse.length, nearDuplicates, all: tags });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

router.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? "File is too large (25MB maximum)" : "Upload failed" });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    try {
      const result = await saveUpload(req.file.buffer, req.file.originalname, { uploadsRoot: MEDIA_DIR });
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json({ url: result.url });
    } catch (writeErr) {
      res.status(500).json({ error: "Could not save the file: " + writeErr.message });
    }
  });
});

module.exports = router;
