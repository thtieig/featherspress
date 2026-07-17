"use strict";

// Markdown → HTML renderer. The Shiki fence renderer, language map, theme, and
// `html: false` setting are lifted VERBATIM from the legacy site/.eleventy.js so
// rendered post bodies are visually identical to the old static build.
//
// No cache: rendering a post is ~milliseconds and this is a personal-scale blog.
// The Shiki highlighter is created once at boot (initHighlighter) and reused.

const MarkdownIt = require("markdown-it");
const { createHighlighter, createCssVariablesTheme } = require("shiki");

const cssVarsTheme = createCssVariablesTheme({
  name: "css-variables",
  variablePrefix: "--shiki-",
  variableDefaults: {},
  fontStyle: true,
});

const SHIKI_LANG_MAP = {
  sh: "sh",
  bash: "bash",
  python: "python",
  mysql: "sql",
  ruby: "ruby",
  apache: "apache",
  php: "php",
  xhtml: "html",
  ini: "ini",
  vim: "vim",
  powershell: "powershell",
  bat: "bat",
  systemd: "systemd",
  shellsession: "shellsession",
  nginx: "nginx",
  json: "json",
};

const SHIKI_LANGS = [
  "sh", "bash", "python", "sql", "ruby", "apache", "php", "html", "text",
  "ini", "vim", "powershell", "bat", "systemd", "shellsession", "nginx", "json",
];

let highlighter;

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderFence(tokens, idx) {
  const token = tokens[idx];
  const info = token.info.trim();
  const langMatch = info.match(/^([a-zA-Z0-9_+-]*)/);
  const rawLang = langMatch ? langMatch[1] : "";
  const titleMatch = info.match(/title="([^"]*)"/);
  const title = titleMatch ? titleMatch[1] : null;
  const shikiLang = SHIKI_LANG_MAP[rawLang] || "text";

  let highlighted;
  try {
    highlighted = highlighter.codeToHtml(token.content, {
      lang: shikiLang,
      theme: cssVarsTheme,
    });
  } catch (e) {
    highlighted = highlighter.codeToHtml(token.content, {
      lang: "text",
      theme: cssVarsTheme,
    });
  }

  const capParts = [];
  if (title) capParts.push(`<span class="fname">${escapeHtml(title)}</span>`);
  if (rawLang) capParts.push(`<span class="lang">${escapeHtml(rawLang)}</span>`);
  const cap = capParts.length
    ? `<div class="code-cap">${title ? capParts[0] : "<span></span>"}<div class="code-cap-right">${rawLang ? `<span class="lang">${escapeHtml(rawLang)}</span>` : ""}<button class="copy-btn" type="button" aria-label="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg></button></div></div>`
    : "";

  return `<div class="code-block">${cap}${highlighted}</div>`;
}

// Eleventy's markdown-it had raw-HTML passthrough disabled (`html: false`)
// because 45 posts use angle-bracket placeholder text in prose that would
// otherwise be swallowed. markdown-it's other defaults (linkify/typographer off) match
// Eleventy's, so a plain instance + the fence rule reproduces the old output.
const md = new MarkdownIt({ html: false });
md.renderer.rules.fence = renderFence;

/** Create the Shiki highlighter once. Await at boot before serving. */
async function initHighlighter() {
  if (highlighter) return highlighter;
  highlighter = await createHighlighter({
    themes: [cssVarsTheme],
    langs: SHIKI_LANGS,
  });
  return highlighter;
}

/** Render a Markdown string to HTML. */
function renderMarkdown(markdown) {
  return md.render(markdown || "");
}

/** Render a post/page object's body to HTML. */
function render(post) {
  // Raw-HTML content (frontmatter `format: html`) is trusted and served as-is.
  if (post.format === "html") return post.body || "";
  return renderMarkdown(post.body);
}

module.exports = { initHighlighter, render, renderMarkdown };
