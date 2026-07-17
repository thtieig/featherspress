"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const posts = require("../src/posts");

const FIXTURES = path.join(__dirname, "fixtures");

test.before(() => {
  posts.load(FIXTURES);
});

test("loads all posts and pages", () => {
  // alpha, beta, gamma(draft), delta = 4 posts; about + welcome = 2 pages
  assert.strictEqual(posts.allPosts().length, 4);
  assert.strictEqual(posts.allPages().length, 2);
});

test("published excludes only status:draft (legacy status:ok counts)", () => {
  const pub = posts.publishedPosts();
  const slugs = pub.map((p) => p.slug).sort();
  assert.deepStrictEqual(slugs, ["alpha-post", "beta-post", "delta-legacy-status"]);
  assert.ok(!slugs.includes("gamma-draft"));
});

test("published posts are newest-first", () => {
  const dates = posts.publishedPosts().map((p) => p.date.getTime());
  const sorted = [...dates].sort((a, b) => b - a);
  assert.deepStrictEqual(dates, sorted);
  assert.strictEqual(posts.publishedPosts()[0].slug, "beta-post"); // 2022
});

test("bySlug finds posts and pages; postBySlug finds drafts too", () => {
  assert.strictEqual(posts.bySlug("alpha-post").title, "Alpha Post");
  assert.strictEqual(posts.bySlug("about").type, "page");
  assert.strictEqual(posts.postBySlug("gamma-draft").status, "draft");
  assert.strictEqual(posts.bySlug("nope"), null);
});

test("byTag returns published posts only, newest-first", () => {
  const linux = posts.byTag("linux").map((p) => p.slug);
  assert.deepStrictEqual(linux, ["beta-post", "alpha-post"]);
  // gamma-draft's 'secret' tag must not surface any published post
  assert.deepStrictEqual(posts.byTag("secret"), []);
});

test("tagVocab counts published only, most-used first", () => {
  const vocab = posts.tagVocab();
  const linux = vocab.find((t) => t.slug === "linux");
  const shell = vocab.find((t) => t.slug === "shell");
  assert.strictEqual(linux.count, 2); // alpha + beta
  assert.strictEqual(shell.count, 2); // alpha + delta
  assert.ok(!vocab.some((t) => t.slug === "secret")); // draft tag excluded
  // most-used first: counts are non-increasing
  const counts = vocab.map((t) => t.count);
  assert.deepStrictEqual(counts, [...counts].sort((a, b) => b - a));
});

test("tagName resolves display name from slug", () => {
  assert.strictEqual(posts.tagName("linux"), "linux");
  assert.strictEqual(posts.tagName("unknown-tag"), "unknown-tag");
});

test("dates parse to Date objects", () => {
  assert.ok(posts.postBySlug("alpha-post").date instanceof Date);
});
