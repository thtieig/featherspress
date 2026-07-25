"use strict";

// In-memory search over published posts, replacing Pagefind. The corpus is 208
// small posts already in RAM, so a linear scan per query is instant. Matches on
// title, tag names, and body text (case-insensitive substring); returns results
// shaped like the old Pagefind client expected: {url, title, excerpt} with the
// matched term wrapped in <mark>.

const posts = require("./posts");

const MAX_RESULTS = 8;
const EXCERPT_RADIUS = 90; // chars of context on each side of a match

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Rough plain-text of a markdown body for excerpting: drop fenced code, then
// strip the most common inline markdown punctuation. Good enough for a snippet.
function plainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build an excerpt centered on the first case-insensitive match of `term`,
// escaping the surrounding text and wrapping the match in <mark>.
function excerptFor(text, term) {
  const lower = text.toLowerCase();
  const at = lower.indexOf(term.toLowerCase());
  if (at === -1) {
    return escapeHtml(text.slice(0, EXCERPT_RADIUS * 2)) + (text.length > EXCERPT_RADIUS * 2 ? "…" : "");
  }
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(text.length, at + term.length + EXCERPT_RADIUS);
  const before = (start > 0 ? "…" : "") + escapeHtml(text.slice(start, at));
  const hit = "<mark>" + escapeHtml(text.slice(at, at + term.length)) + "</mark>";
  const after = escapeHtml(text.slice(at + term.length, end)) + (end < text.length ? "…" : "");
  return before + hit + after;
}

/**
 * Search published posts. Returns up to MAX_RESULTS of {url, title, excerpt}.
 * Ranking: title matches first, then tag matches, then body matches; ties keep
 * newest-first (publishedPosts is already sorted).
 */
function search(query) {
  const term = String(query || "").trim();
  if (!term) return [];
  const needle = term.toLowerCase();

  const scored = [];
  for (const post of posts.publishedPosts()) {
    const title = post.title || "";
    const tagText = post.postTags.map((t) => t.name).join(" ");
    const bodyPlain = plainText(post.body || "");

    const inTitle = title.toLowerCase().includes(needle);
    const inTags = tagText.toLowerCase().includes(needle);
    const inBody = bodyPlain.toLowerCase().includes(needle);
    if (!inTitle && !inTags && !inBody) continue;

    const rank = inTitle ? 0 : inTags ? 1 : 2;
    // Prefer a body excerpt around the match; fall back to title/tags context.
    let excerptSource = bodyPlain;
    if (!inBody) excerptSource = inTitle ? title : `Tagged: ${tagText}`;

    scored.push({
      rank,
      url: `/${post.slug}/`,
      title,
      excerpt: excerptFor(excerptSource, term),
    });
  }

  scored.sort((a, b) => a.rank - b.rank); // stable: keeps newest-first within rank
  return scored.slice(0, MAX_RESULTS).map(({ rank, ...r }) => r);
}

module.exports = { search };
