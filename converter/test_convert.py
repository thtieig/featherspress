#!/usr/bin/env python3
"""Converter tests. Run them with the converter venv:

    converter/.venv/bin/python converter/test_convert.py

Builds synthetic mysqldump-style dumps in a temp dir and runs the real CLI
against them, asserting the behaviour of the bug fixes (SQL escaping, table
prefix, media paths, statuses, shortcodes, link rewriting, YAML safety).
"""
import json
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable  # the venv python running this file


def sqlstr(v):
    """Render a Python value as a mysqldump-style SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    s = (
        str(v)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )
    return f"'{s}'"


def post_row(**kw):
    """A 23-column wp_posts row. Only the columns the converter reads matter;
    the rest are placeholders."""
    cols = ["" for _ in range(23)]
    cols[0] = kw["id"]
    cols[2] = kw.get("date", "2020-01-01 00:00:00")
    cols[4] = kw.get("content", "")
    cols[5] = kw.get("title", "")
    cols[7] = kw.get("status", "publish")
    cols[11] = kw.get("name", "")
    cols[20] = kw.get("ptype", "post")
    return "(" + ",".join(sqlstr(c) for c in cols) + ")"


def insert(table, rows):
    return f"INSERT INTO `{table}` VALUES " + ",".join(rows) + ";\n"


def build_dump(prefix="wp_"):
    posts = [
        post_row(
            id=1,
            title="First Post",
            name="first-post",
            content=(
                "<p>See <a href='https://example.com/?p=2'>the second</a> and "
                "<a href='https://www.example.com/second-post/'>again</a>.</p>"
                "<pre>C:\\newdir and a regex \\d+ here</pre>"
                "<p>Set the &lt;hostname&gt; value.</p>"
                "[caption id=\"x\" width=\"9\"]<img src='https://example.com/wp-content/uploads/2020/01/a.png'/> A cap[/caption]"
                "[code lang=\"python\"]print('hi')[/code]"
                "<p><img src='https://example.com/wp-content/uploads/flat.png'/></p>"
                "<pre class='wp-block-code'><code class='language-js'>console.log(1)</code></pre>"
                "[gallery ids='1,2,3']"
            ),
        ),
        post_row(id=2, title="Second Post", name="second-post", content="<p>Two.</p>"),
        post_row(id=3, title="A Page", name="a-page", ptype="page", content="<p>Page body.</p>"),
        post_row(id=4, title="Secret", name="secret", status="private", content="<p>hush</p>"),
        post_row(id=5, title="Draft", name="draft-one", status="draft", content="<p>wip</p>"),
        # A revision + an attachment: must never become content.
        post_row(id=6, name="1-revision-v1", status="inherit", ptype="revision", content="<p>old</p>"),
        post_row(id=7, name="a-png", status="inherit", ptype="attachment"),
    ]
    terms = [
        f"(10,{sqlstr('C++ : notes')},{sqlstr('cpp')},0)",
        f"(11,{sqlstr('linux')},{sqlstr('linux')},0)",
    ]
    tt = [
        f"(100,10,{sqlstr('post_tag')},'',0,1)",
        f"(101,11,{sqlstr('category')},'',0,1)",  # a category: must NOT appear
    ]
    rel = ["(1,100,0)", "(1,101,0)"]  # first-post: tag cpp + category linux
    return (
        insert(f"{prefix}posts", posts)
        + insert(f"{prefix}terms", terms)
        + insert(f"{prefix}term_taxonomy", tt)
        + insert(f"{prefix}term_relationships", rel)
    )


def run(dump_text, extra=None, prefix="wp_"):
    tmp = Path(tempfile.mkdtemp(prefix="fp-conv-"))
    db = tmp / "dump.sql"
    db.write_text(dump_text, encoding="utf-8")
    out = tmp / "pkg"
    cmd = [
        PY, str(HERE / "wp_to_package.py"),
        "--db", str(db),
        "--url", "https://example.com",
        "--title", "T",
        "--out", str(out),
    ] + (extra or [])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 0, f"converter failed:\n{proc.stderr}\n{proc.stdout}"
    return out, proc.stdout + proc.stderr


def read(out, rel):
    p = out / rel
    return p.read_text(encoding="utf-8") if p.exists() else None


def main():
    checks = []

    def check(name, cond):
        checks.append((name, bool(cond)))

    # --- default run (wp_ prefix) ---
    out, log = run(build_dump())
    first = read(out, "content/posts/first-post.md")
    page = read(out, "content/pages/a-page.md")

    check("published post emitted", first is not None)
    check("page emitted", page is not None)
    check("private NOT emitted by default", read(out, "content/posts/secret.md") is None)
    check("draft NOT emitted by default", read(out, "content/posts/draft-one.md") is None)
    check("revision NOT emitted", read(out, "content/posts/1-revision-v1.md") is None)
    check("skip summary printed", "skipped (not published)" in log and "1 private" in log and "1 draft" in log)

    # SQL backslash escaping (the unquote-order bug).
    check("backslash path preserved (C:\\newdir)", "C:\\newdir" in first)
    check("regex backslash preserved (\\d+)", "\\d+" in first)
    # Angle-bracket placeholder survives (entity in source → literal text).
    check("placeholder <hostname> survives", "<hostname>" in first)
    # Internal links rewritten for the site's own domain (from --url).
    check("?p=2 link rewritten to /second-post/", "/second-post/" in first)
    check("no leftover absolute example.com link", "example.com/second-post" not in first)
    check("no leftover ?p= link", "?p=2" not in first)
    # Media: both date-foldered and flat uploads become /media/ refs.
    check("date media rewritten", "/media/2020/01/a.png" in first)
    check("flat media rewritten", "/media/flat.png" in first)
    # Shortcodes.
    check("caption inner kept (caption text)", "A cap" in first and "[caption" not in first)
    check("code shortcode fenced as python", "```python" in first and "print('hi')" in first)
    check("gallery shortcode removed", "[gallery" not in first)
    # Gutenberg code language detected.
    check("gutenberg js fence", "```js" in first and "console.log(1)" in first)
    # Tags: quoted+safe YAML, categories excluded.
    check("tag name YAML-quoted", 'name: "C++ : notes"' in first)
    check("category NOT in front matter", "linux" not in first.split("\n\n")[0])

    # Front matter must be valid: title quoted.
    check("title quoted in front matter", 'title: "First Post"' in first)

    # --- --include-drafts ---
    out2, _ = run(build_dump(), extra=["--include-drafts"])
    draft = read(out2, "content/posts/draft-one.md")
    check("draft emitted with --include-drafts", draft is not None)
    check("imported draft marked status: draft", draft and "status: draft" in draft)

    # --- non-default table prefix (auto-detect) ---
    out3, log3 = run(build_dump(prefix="myblog_"), prefix="myblog_")
    check("auto-detected non-wp_ prefix", read(out3, "content/posts/first-post.md") is not None)
    check("prefix reported", "myblog_" in log3)

    # --- --tar: uploadable archive with package-root-relative members ---
    out4, log4 = run(build_dump(), extra=["--tar"])
    tgz = out4.parent / (out4.name + ".tar.gz")
    check("--tar reports the archive path", "uploadable archive" in log4)
    check("--tar archive file created", tgz.exists())
    if tgz.exists():
        with tarfile.open(tgz, "r:gz") as tf:
            names = tf.getnames()
        check("archive has site.json at the root", "site.json" in names)
        check("archive has content/posts/first-post.md at the root", "content/posts/first-post.md" in names)
        check(
            "no member path includes the output dir name (root-relative, not absolute)",
            not any(n.startswith(out4.name) or n.startswith("/") or ".." in n.split("/") for n in names),
        )

    # --- report ---
    ok = sum(1 for _, c in checks if c)
    for name, c in checks:
        print(f"  {'ok  ' if c else 'FAIL'} {name}")
    print(f"\n{ok}/{len(checks)} checks passed")
    sys.exit(0 if ok == len(checks) else 1)


if __name__ == "__main__":
    main()
