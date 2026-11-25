"use strict";

// In-memory content store. Reads posts/*.md and pages/*.md with gray-matter at
// boot into a plain array; the public site and admin share this one list.
// A blog is small, so a full re-read on admin writes is cheap and avoids any
// incremental-update bugs.
//
// A post is a DRAFT only when its frontmatter says `status: draft`. Anything
// else is published: a missing status, or a stray legacy value like `status: ok`.

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const config = require("../config");

let contentDir = config.CONTENT_DIR;
let posts = []; // all posts (published + draft), newest-first
let pages = []; // all pages

function coerceDate(value) {
  if (value instanceof Date) return value;
  if (value == null) return null;
  // Frontmatter dates are usually parsed to Date by js-yaml, but a quoted
  // string like "2017-02-16 16:16:19" needs the space→T fix to parse.
  const d = new Date(String(value).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

function parseFile(dir, filename, type) {
  const raw = fs.readFileSync(path.join(dir, filename), "utf8");
  // Options ({}) bypass gray-matter's cache, which stores a file BEFORE parsing
  // it: without this a broken file throws once, then "parses" on the next read.
  const { data, content } = matter(raw, {});
  const slug = data.slug || path.basename(filename, ".md");
  return {
    type, // "post" | "page"
    slug,
    title: data.title || slug,
    date: coerceDate(data.date),
    postTags: Array.isArray(data.postTags) ? data.postTags : [],
    status: data.status === "draft" ? "draft" : "published",
    // `format: html` → body is trusted author-written HTML, served verbatim
    // (skips markdown rendering). Used for bespoke pages like a pinned home.
    format: data.format === "html" ? "html" : "markdown",
    body: content,
    filename,
    data, // raw frontmatter, kept for admin round-tripping
  };
}

function loadDir(sub, type) {
  const dir = path.join(contentDir, sub);
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    // One file with broken front matter must not stop the whole site.
    try {
      items.push(parseFile(dir, f, type));
    } catch (err) {
      console.warn(`Skipping ${path.join(dir, f)}: ${err.message}`);
    }
  }
  return items;
}

function byDateDesc(a, b) {
  return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
}

/** (Re)read all content from disk. Call at boot and after admin writes. */
function load(dir) {
  if (dir) contentDir = dir;
  posts = loadDir("posts", "post").sort(byDateDesc);
  pages = loadDir("pages", "page");
  return { posts: posts.length, pages: pages.length };
}

// ---- queries -------------------------------------------------------------

/** Published posts only (public site). Newest-first. */
function publishedPosts() {
  return posts.filter((p) => p.status === "published");
}

/** Find a post by slug (any status). */
function postBySlug(slug) {
  return posts.find((p) => p.slug === slug) || null;
}

function pageBySlug(slug) {
  return pages.find((p) => p.slug === slug) || null;
}

/** Find a post or page by slug (any status), for the public router. */
function bySlug(slug) {
  return postBySlug(slug) || pageBySlug(slug);
}

/** Published posts carrying the given tag slug. Newest-first. */
function byTag(tagSlug) {
  return publishedPosts().filter((p) =>
    p.postTags.some((t) => t.slug === tagSlug)
  );
}

/**
 * Tag vocabulary over PUBLISHED posts: [{name, slug, count}], most-used first.
 * Drafts don't contribute: the public tag cloud must not leak them.
 */
function tagVocab() {
  const bySlugMap = new Map();
  for (const post of publishedPosts()) {
    for (const tag of post.postTags) {
      const entry = bySlugMap.get(tag.slug) || {
        name: tag.name,
        slug: tag.slug,
        count: 0,
      };
      entry.count += 1;
      bySlugMap.set(tag.slug, entry);
    }
  }
  return [...bySlugMap.values()].sort((a, b) => b.count - a.count);
}

/** Look up a tag's display name from its slug (or the slug if unknown). */
function tagName(tagSlug) {
  const hit = tagVocab().find((t) => t.slug === tagSlug);
  return hit ? hit.name : tagSlug;
}

module.exports = {
  load,
  publishedPosts,
  postBySlug,
  pageBySlug,
  bySlug,
  byTag,
  tagVocab,
  tagName,
};
