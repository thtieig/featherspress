"use strict";

// The DATA CONTRACT between the engine and a skin. This is the single place that
// turns the in-memory post list (src/posts.js) into the plain objects a skin's
// templates receive. A skin author only needs to know THESE shapes:
//
//   always      site      = { title, tagline, url, skin, homeMode, nav[] }
//               tagCloud  = [{ name, slug, count, weight }]   weight ∈ [0,1]
//               currentPath                                    (nav highlighting)
//   home        recentPosts[]  (feed mode, + optional pinned {title, slug, bodyHtml})
//               OR  page {title, bodyHtml}  (page mode)
//   post        { title, slug, date, tags[], bodyHtml }
//   page        { title, slug, bodyHtml }
//   archive     { heading, posts[] }        (tag pages and the all-posts page)
//   404         (no extra data)
//
// where a list item / post `tags[]` is [{ name, slug }] and every `posts[]`
// entry is { title, slug, date, tags[] }. Search stays client-side against the
// existing /search JSON API, so it needs nothing here.

const posts = require("./posts");
const render = require("./render");
const skin = require("./skin");

let site = null; // the manifest, set once at boot

function setSite(manifest) {
  site = manifest;
}

// ---- shared shapes -------------------------------------------------------

// Plain-text excerpt from a markdown/HTML body: the first `words` words. Skins that
// show a post feed (e.g. a magazine-style home) use it; skins that don't just
// ignore the field.
function excerpt(body, words = 40) {
  const text = String(body || "")
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/<[^>]+>/g, " ") // html tags (format: html bodies)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = text.split(" ");
  return parts.length > words ? parts.slice(0, words).join(" ") + "…" : text;
}

function listItem(p) {
  return {
    title: p.title,
    slug: p.slug,
    date: p.date,
    tags: p.postTags.map((t) => ({ name: t.name, slug: t.slug })),
    excerpt: excerpt(p.body),
  };
}

// Top 45 tags, alphabetical, each with a relative `weight` (0..1) the skin can
// map to a font size. Weight is data (relative frequency), not presentation.
function tagCloud() {
  const top = posts.tagVocab().slice(0, 45);
  if (!top.length) return [];
  const counts = top.map((t) => t.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return top
    .map((t) => ({
      name: t.name,
      slug: t.slug,
      count: t.count,
      weight: max > min ? (t.count - min) / (max - min) : 0.5,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function globals(currentPath, title) {
  return { site, tagCloud: tagCloud(), currentPath, title: title || null };
}

// ---- page renders (mirror the old templates.js call surface) -------------

function home() {
  const ctx = globals("/");
  const mode = String(site.homeMode || "feed");
  if (mode.startsWith("page:")) {
    const slug = mode.slice("page:".length);
    const pg = posts.pageBySlug(slug);
    // A pinned page that is still a draft must not leak onto the public home
    // (the /:slug route already 404s drafts; mirror that here).
    ctx.page =
      pg && pg.status !== "draft"
        ? { title: pg.title, slug: pg.slug, bodyHtml: render.render(pg) }
        : { title: "", slug, bodyHtml: "" };
  } else {
    ctx.recentPosts = posts.publishedPosts().map(listItem);
    if (site.pinnedPage) {
      const pg = posts.pageBySlug(site.pinnedPage);
      if (pg && pg.status !== "draft") {
        ctx.pinned = { title: pg.title, slug: pg.slug, bodyHtml: render.render(pg) };
      }
    }
  }
  return skin.render("home", ctx);
}

// The full post listing (a generic archive), served at the manifest's
// postsPath. A real page at the same slug overrides it (handled in server.js).
function postsIndex(list) {
  const heading = site.postsHeading || "All posts";
  return skin.render("archive", {
    ...globals(site.postsPath || "/posts/", heading),
    heading,
    posts: list.map(listItem),
  });
}

function tagPage(tagName, list) {
  const heading = `Tag: ${tagName}`;
  return skin.render("archive", {
    ...globals("/tag/", heading),
    heading,
    posts: list.map(listItem),
  });
}

function postPage(post, bodyHtml) {
  return skin.render("post", {
    ...globals(`/${post.slug}/`, post.title),
    post: {
      title: post.title,
      slug: post.slug,
      date: post.date,
      tags: post.postTags.map((t) => ({ name: t.name, slug: t.slug })),
      bodyHtml,
    },
  });
}

function pageView(page, bodyHtml) {
  return skin.render("page", {
    ...globals(`/${page.slug}/`, page.title),
    page: { title: page.title, slug: page.slug, bodyHtml },
  });
}

function notFound() {
  return skin.render("notFound", globals("", "Not found"));
}

module.exports = {
  setSite,
  home,
  postsIndex,
  tagPage,
  postPage,
  pageView,
  notFound,
  tagCloud,
};
