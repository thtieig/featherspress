#!/usr/bin/env python3
"""
wp_to_package: convert a WordPress backup into a Featherspress Site Package.

A Site Package is one self-contained blog the engine can serve:

    <out>/
      site.json            manifest (title/tagline/url/skin/homeMode/nav)
      content/posts/*.md    published posts, gray-matter front matter
      content/pages/*.md    published pages
      media/YYYY/MM/…       referenced uploads, served at /media/

Point the engine at it with SITE_PACKAGE=<out>.

Input is an UpdraftPlus-style backup: a database dump (`-db.gz`, `.sql.gz`, or
plain `.sql`) and, optionally, the uploads archive (`-uploads.zip`). Only the
media actually referenced by post/page bodies is copied, so the package stays
lean.

Usage:
    python3 wp_to_package.py \
        --db   backup-db.gz \
        --uploads backup-uploads.zip \
        --url  https://example.com \
        --title "My Blog" --tagline "…" \
        --skin notepad \
        --out  ./my-blog-package

The extraction logic (SQL dump parsing, HTML→Markdown, code-fence and link
normalization) lives in converter/lib/. It is the same pipeline the project has
used since v1, bundled here so the converter is self-contained.
"""
import argparse
import gzip
import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse

# The bundled pipeline modules (converter/lib/) import each other by bare name,
# so put that dir on the path and import them the same way.
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from sql_dump import detect_table_prefix, iter_insert_rows, unquote  # noqa: E402
from normalize_content import normalize_post  # noqa: E402
import extract_db  # noqa: E402

# wp_posts column indices (standard WP schema).
COL = dict(ID=0, DATE=2, CONTENT=4, TITLE=5, STATUS=7, SLUG=11, TYPE=20)

# Any /media/… reference, not only YYYY/MM/… (sites with month/year folders
# turned off, or a custom upload_path, store files flat).
MEDIA_REF_RE = re.compile(r"/media/([^\s\")\]]+)")

# Non-publish statuses we can import as drafts (with --include-drafts). Others
# (auto-draft, inherit=revisions/attachments, trash) are never content.
_DRAFTABLE = {"draft", "pending", "private", "future"}


def read_dump(path: Path) -> str:
    """Read a .sql / .sql.gz / -db.gz dump as text (tolerant decode)."""
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":  # gzip magic
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def load_rows(txt, prefix, include_drafts=False):
    """Return (posts, pages, skipped) where skipped counts non-imported posts/
    pages by status (revisions/attachments/menu items etc. are ignored)."""
    posts, pages = {}, {}
    skipped = {}
    for row in iter_insert_rows(txt, f"{prefix}posts"):
        if len(row) <= COL["TYPE"]:
            continue
        t, status = unquote(row[COL["TYPE"]]), unquote(row[COL["STATUS"]])
        if t not in ("post", "page"):
            continue  # revisions, attachments, nav_menu_item, etc.
        rec = {
            "id": unquote(row[COL["ID"]]),
            "title": unquote(row[COL["TITLE"]]),
            "slug": unquote(row[COL["SLUG"]]),
            "date": unquote(row[COL["DATE"]]),
            "content": unquote(row[COL["CONTENT"]]),
            "tags": [],
            "categories": [],
        }
        if status != "publish":
            if include_drafts and status in _DRAFTABLE:
                rec["status"] = "draft"
            else:
                skipped[status] = skipped.get(status, 0) + 1
                continue
        (posts if t == "post" else pages)[rec["id"]] = rec
    return posts, pages, skipped


def attach_terms(txt, records, prefix):
    terms = extract_db._load_terms(txt, prefix)
    tt = extract_db._load_term_taxonomy(txt, terms, prefix)
    post_terms = extract_db._load_post_terms(txt, tt, prefix)
    for pid, rec in records.items():
        bucket = post_terms.get(pid, {"categories": [], "tags": []})
        rec["tags"] = bucket["tags"]
        rec["categories"] = bucket["categories"]


def uploads_rewriter(url: str):
    """Rewrite absolute/relative uploads URLs for this site to /media/."""
    host = urlparse(url).netloc.replace("www.", "")
    host_re = re.escape(host) if host else r"[^/\"']+"
    pat = re.compile(r"(?:https?://(?:www\.)?" + host_re + r")?/wp-content/uploads/")
    return lambda md: pat.sub("/media/", md)


def emit_content(posts, pages, out: Path, to_media, own_domain, wrap_underscore_words=False):
    # id2slug covers posts AND pages so internal ?p=<id> links to either resolve.
    id2slug = {p["id"]: p["slug"] for p in posts.values()}
    id2slug.update({p["id"]: p["slug"] for p in pages.values()})
    media_refs = set()
    used_slugs = set()  # posts and pages share the /:slug/ space, so keep unique
    (out / "content" / "posts").mkdir(parents=True, exist_ok=True)
    (out / "content" / "pages").mkdir(parents=True, exist_ok=True)

    def unique(slug):
        base = slug or "post"
        candidate, n = base, 1
        while candidate in used_slugs:
            n += 1
            candidate = f"{base}-{n}"
        used_slugs.add(candidate)
        return candidate

    def emit(rec, subdir):
        slug = unique(rec["slug"])
        if slug != rec["slug"]:
            print(f"  ! duplicate slug '{rec['slug']}' -> '{slug}'", file=sys.stderr)
        md = to_media(
            normalize_post(rec, id2slug, {}, own_domain=own_domain, wrap_underscore_words=wrap_underscore_words)
        )
        media_refs.update(MEDIA_REF_RE.findall(md))
        (out / "content" / subdir / f"{slug}.md").write_text(md, encoding="utf-8")

    for rec in posts.values():
        emit(rec, "posts")
    for rec in pages.values():
        emit(rec, "pages")
    return sorted(media_refs)


def extract_media(uploads_zip: Path, media_refs, out: Path):
    """Copy only referenced uploads into <out>/media/YYYY/MM/…."""
    if not uploads_zip or not media_refs:
        return 0
    dest = out / "media"
    copied = 0
    with zipfile.ZipFile(uploads_zip) as zf:
        # index entries by the path after the last "uploads/"
        index = {}
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            key = name.split("uploads/", 1)[-1]
            index[key] = name
        for ref in media_refs:
            entry = index.get(ref)
            if entry is None:  # try a looser suffix match
                entry = next((n for n in index.values() if n.endswith("/" + ref) or n.endswith(ref)), None)
            if entry is None:
                print(f"  ! media not found in zip: {ref}", file=sys.stderr)
                continue
            target = dest / ref
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(entry))
            copied += 1
    return copied


def write_manifest(out: Path, args):
    path = out / "site.json"
    if path.exists():
        print(f"  site.json exists, left untouched ({path})")
        return
    manifest = {
        "title": args.title or urlparse(args.url).netloc,
        "tagline": args.tagline or "",
        "url": args.url,
        "skin": args.skin,
        "homeMode": args.home_mode,
        "nav": [{"label": "Home", "href": "/"}],
    }
    if args.author:
        manifest["author"] = args.author
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"  wrote starter {path}")


def main():
    ap = argparse.ArgumentParser(description="Convert a WordPress backup to a Featherspress Site Package.")
    ap.add_argument("--db", required=True, type=Path, help="database dump (-db.gz / .sql.gz / .sql)")
    ap.add_argument("--uploads", type=Path, help="uploads archive (-uploads.zip)")
    ap.add_argument("--out", required=True, type=Path, help="output package directory")
    ap.add_argument("--url", required=True, help="site URL, e.g. https://example.com")
    ap.add_argument("--title", help="site title (default: the URL host)")
    ap.add_argument("--tagline", help="site tagline")
    ap.add_argument("--skin", default="notepad", help="skin name (default: notepad)")
    ap.add_argument("--author", help="single-author display name (optional)")
    ap.add_argument("--home-mode", default="feed", help='"feed" or "page:<slug>" (default: feed)')
    ap.add_argument("--table-prefix", help="WordPress table prefix (default: auto-detect, usually wp_)")
    ap.add_argument(
        "--include-drafts",
        action="store_true",
        help="also import draft/pending/private/future posts (as status: draft)",
    )
    ap.add_argument(
        "--wrap-underscore-words",
        action="store_true",
        help="wrap prose words containing underscores in `code` (for code-heavy blogs)",
    )
    args = ap.parse_args()

    txt = read_dump(args.db)
    prefix = args.table_prefix or detect_table_prefix(txt)
    own_domain = urlparse(args.url).netloc.replace("www.", "")
    posts, pages, skipped = load_rows(txt, prefix, include_drafts=args.include_drafts)
    attach_terms(txt, {**posts, **pages}, prefix)
    print(f"table prefix: {prefix!r}")
    print(f"parsed: {len(posts)} posts, {len(pages)} pages")
    if skipped:
        summary = ", ".join(f"{n} {status}" for status, n in sorted(skipped.items()))
        hint = "" if args.include_drafts else "  (use --include-drafts to keep drafts/private)"
        print(f"skipped (not published): {summary}{hint}")

    to_media = uploads_rewriter(args.url)
    args.out.mkdir(parents=True, exist_ok=True)
    media_refs = emit_content(posts, pages, args.out, to_media, own_domain, args.wrap_underscore_words)
    print(f"content written; {len(media_refs)} media references")

    copied = extract_media(args.uploads, media_refs, args.out)
    if args.uploads:
        print(f"media copied: {copied}/{len(media_refs)}")
    elif media_refs:
        print("  (no --uploads given; media not copied)")

    write_manifest(args.out, args)
    print(f"\nSite Package ready: {args.out}")
    print(f"Serve it with:  SITE_PACKAGE={args.out} npm start")


if __name__ == "__main__":
    main()
