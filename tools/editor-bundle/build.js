// Rebuilds admin/public/vendor/toastui-editor.bundle.js, the Markdown editor
// used by /admin. @toast-ui/editor's prebuilt dist file expects its
// ProseMirror dependencies to be loaded separately, so a plain <script> tag
// can't load it on its own. This bundles everything into one self-contained
// file, served locally with no CDN.
//
// Run from the repo root (build tools are installed in a temp dir, not in the
// engine's package.json):
//   node tools/editor-bundle/build.js
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "../..");
const out = path.join(repo, "admin/public/vendor/toastui-editor.bundle.js");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fp-editor-"));
try {
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({
    private: true,
    // dompurify ships inside the editor; force a version without known XSS bugs.
    overrides: { dompurify: "^3.4.12" },
  }));
  fs.copyFileSync(path.join(__dirname, "entry.js"), path.join(work, "entry.js"));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "@toast-ui/editor@3.2.2", "esbuild@0.28"], { cwd: work, stdio: "inherit" });
  require(path.join(work, "node_modules/esbuild")).buildSync({
    entryPoints: [path.join(work, "entry.js")],
    bundle: true,
    minify: true,
    outfile: out,
    format: "iife",
    globalName: "ToastuiBundle",
    target: "es2019",
  });
  console.log("Bundled editor ->", path.relative(repo, out));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
