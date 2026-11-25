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
    // The editor asks for dompurify ^2.3.3; force a version without known XSS bugs.
    overrides: { dompurify: "^3.4.12" },
  }));
  fs.copyFileSync(path.join(__dirname, "entry.js"), path.join(work, "entry.js"));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "@toast-ui/editor@3.2.2", "esbuild@0.28"], { cwd: work, stdio: "inherit" });

  // The override alone changes nothing: the editor's dist/esm/index.js has its
  // own copy of DOMPurify 2.3.3 pasted in. Cut that copy out and import the
  // installed dompurify package instead. The editor only calls
  // purify.sanitize(), which DOMPurify 3 keeps as is.
  const esm = path.join(work, "node_modules/@toast-ui/editor/dist/esm/index.js");
  const src = fs.readFileSync(esm, "utf8");
  const start = src.indexOf("/*! @license DOMPurify 2.3.3 ");
  const endMark = "\nvar purify = createDOMPurify();\n";
  const end = src.indexOf(endMark, start);
  if (start === -1 || end === -1 || src.indexOf(endMark, end + 1) !== -1) {
    throw new Error("Inlined DOMPurify not found where expected in " + esm);
  }
  fs.writeFileSync(esm, src.slice(0, start) + 'import purify from "dompurify";\n' + src.slice(end + endMark.length));

  require(path.join(work, "node_modules/esbuild")).buildSync({
    entryPoints: [path.join(work, "entry.js")],
    bundle: true,
    minify: true,
    outfile: out,
    format: "iife",
    globalName: "ToastuiBundle",
    target: "es2019",
  });
  const versions = [...fs.readFileSync(out, "utf8").matchAll(/\.version="([0-9.]+)"/g)].map((m) => m[1]);
  if (versions.length !== 1 || !versions[0].startsWith("3.")) {
    throw new Error("Expected one DOMPurify 3.x in the bundle, found: " + versions.join(", "));
  }
  console.log("Bundled editor (DOMPurify " + versions[0] + ") ->", path.relative(repo, out));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
