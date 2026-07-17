import gzip
import json
import sys
from pathlib import Path

from sql_dump import detect_table_prefix, iter_insert_rows, unquote

# wp_posts column indexes (standard WordPress schema)
COL_ID = 0
COL_DATE = 2
COL_CONTENT = 4
COL_TITLE = 5
COL_STATUS = 7
COL_SLUG = 11
COL_TYPE = 20


# Manually-reviewed tag consolidation: grammar/spelling variants that split
# what should be one tag across two WordPress term IDs (e.g. "scripts" next
# to the dominant "script"). Deliberately does NOT include version-specific
# looking pairs (e.g. "centos" vs "centos7", "debian" vs "debian 9") -- those
# encode a real distinction and losing it would be a real information loss,
# not tidying. Keyed by lowercased old name -> canonical (name, slug).
TAG_RENAMES = {
    "scripts": ("script", "script"),
    "check": ("checks", "checks"),
    "updates": ("update", "update"),
    "sessions": ("session", "session"),
    "examples": ("example", "example"),
    "users": ("user", "user"),
    "fast-cgi": ("fastcgi", "fastcgi"),
    "useragent": ("user-agent", "user-agent"),
    "networking": ("network", "network"),
}


def _load_terms(dump_text, prefix="wp_"):
    """Map term_id -> {"name": ..., "slug": ...} (WordPress's own slug,
    never re-slugified, since it's the URL contract -- except for the
    deliberate, human-reviewed TAG_RENAMES consolidation above)."""
    terms = {}
    for row in iter_insert_rows(dump_text, f"{prefix}terms"):
        term_id = unquote(row[0])
        name, slug = unquote(row[1]), unquote(row[2])
        rename = TAG_RENAMES.get(name.lower())
        if rename:
            name, slug = rename
        terms[term_id] = {"name": name, "slug": slug}
    return terms


def _load_term_taxonomy(dump_text, terms, prefix="wp_"):
    """Map term_taxonomy_id -> ({"name", "slug"}, taxonomy)."""
    tt = {}
    for row in iter_insert_rows(dump_text, f"{prefix}term_taxonomy"):
        tt_id, term_id, taxonomy = row[0], row[1], unquote(row[2])
        tt[tt_id] = (terms.get(term_id, {"name": "?", "slug": "?"}), taxonomy)
    return tt


def _load_post_terms(dump_text, tt, prefix="wp_"):
    """Map post_id -> {"categories": [{"name","slug"}...], "tags": [...]}."""
    post_terms = {}
    for row in iter_insert_rows(dump_text, f"{prefix}term_relationships"):
        post_id, tt_id = row[0], row[1]
        term, taxonomy = tt.get(tt_id, ({"name": "?", "slug": "?"}, "?"))
        bucket = post_terms.setdefault(post_id, {"categories": [], "tags": []})
        if taxonomy == "category":
            bucket["categories"].append(term)
        elif taxonomy == "post_tag":
            bucket["tags"].append(term)
    return post_terms


def extract_posts(dump_text):
    prefix = detect_table_prefix(dump_text)
    terms = _load_terms(dump_text, prefix)
    tt = _load_term_taxonomy(dump_text, terms, prefix)
    post_terms = _load_post_terms(dump_text, tt, prefix)

    posts = []
    for row in iter_insert_rows(dump_text, f"{prefix}posts"):
        if len(row) <= COL_TYPE:
            continue
        if unquote(row[COL_TYPE]) != "post" or unquote(row[COL_STATUS]) != "publish":
            continue
        post_id = unquote(row[COL_ID])
        bucket = post_terms.get(post_id, {"categories": [], "tags": []})
        posts.append(
            {
                "id": post_id,
                "title": unquote(row[COL_TITLE]),
                "slug": unquote(row[COL_SLUG]),
                "date": unquote(row[COL_DATE]),
                "content": unquote(row[COL_CONTENT]),
                "categories": bucket["categories"],
                "tags": bucket["tags"],
            }
        )
    return posts


def build_id_to_slug(posts):
    return {p["id"]: p["slug"] for p in posts}


def main():
    if len(sys.argv) != 3:
        print("usage: extract_db.py <db.gz> <output.json>", file=sys.stderr)
        sys.exit(1)
    db_gz_path, output_path = Path(sys.argv[1]), Path(sys.argv[2])
    dump_text = gzip.decompress(db_gz_path.read_bytes()).decode("utf-8")
    posts = extract_posts(dump_text)
    output_path.write_text(json.dumps(posts, indent=2, ensure_ascii=False))
    print(f"Extracted {len(posts)} published posts -> {output_path}")


if __name__ == "__main__":
    main()
