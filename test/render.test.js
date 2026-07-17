"use strict";

const test = require("node:test");
const assert = require("node:assert");
const render = require("../src/render");

test.before(async () => {
  await render.initHighlighter();
});

test("inline code renders as <code>", () => {
  const html = render.renderMarkdown("Use `ls -la` to list.");
  assert.match(html, /<code>ls -la<\/code>/);
});

test("fenced code uses the code-block wrapper + Shiki spans", () => {
  const html = render.renderMarkdown("```bash\necho hi\n```");
  assert.match(html, /<div class="code-block">/);
  assert.match(html, /<span class="lang">bash<\/span>/);
  assert.match(html, /<pre class="shiki/); // Shiki output
  assert.match(html, /--shiki-/); // css-variables theme
});

test("fence title= caption is honored", () => {
  const html = render.renderMarkdown('```python title="run.py"\nprint(1)\n```');
  assert.match(html, /<span class="fname">run\.py<\/span>/);
  assert.match(html, /<span class="lang">python<\/span>/);
});

test("unknown fence language falls back to text without throwing", () => {
  const html = render.renderMarkdown("```notalang\nsome text\n```");
  assert.match(html, /<div class="code-block">/);
  assert.match(html, /<span class="lang">notalang<\/span>/);
});

test("html:false: raw angle-bracket text is escaped, not swallowed", () => {
  const html = render.renderMarkdown("Edit the `<router_ip>` value and <name> here.");
  // Inline-code angle brackets escaped:
  assert.match(html, /<code>&lt;router_ip&gt;<\/code>/);
  // Bare prose angle-bracket text survives as literal text, not an HTML tag:
  assert.match(html, /&lt;name&gt;/);
});
