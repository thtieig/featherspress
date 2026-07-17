import re

from markdownify import markdownify

from code_blocks import extract_pre_blocks
from link_rewrite import rewrite_links
from shortcodes import expand_shortcodes

PLACEHOLDER_RE_TEMPLATE = "\x00CODEBLOCK{}\x00"


def _yaml_dq(value):
    """A safe YAML double-quoted scalar: escape backslash and quote, flatten
    newlines. Handles tag names/titles that contain `:`, a leading `-`, or that
    look boolean/numeric, all of which break an unquoted scalar."""
    s = str(value).replace("\\", "\\\\").replace('"', '\\"')
    s = s.replace("\n", " ").replace("\r", " ")
    return f'"{s}"'


def _term_lines(terms):
    lines = []
    for term in terms:
        lines.append(f'  - name: {_yaml_dq(term["name"])}')
        lines.append(f'    slug: {_yaml_dq(term["slug"])}')
    return lines


def _front_matter(post):
    # Categories are deliberately not written to front matter -- 90% of
    # posts were in a single category ("Linux"), so it wasn't really
    # categorizing anything and tags already do the real organizational
    # work. `post["categories"]` may still be present on the input dict
    # (harmless historical data from extraction) but is not emitted here.
    lines = ["---"]
    lines.append(f"title: {_yaml_dq(post['title'])}")
    lines.append(f'date: {post["date"]}')
    lines.append(f'slug: {post["slug"]}')
    # Non-publish posts are only emitted when the caller opts in (--include-drafts);
    # they carry status: draft so the engine keeps them off the public site.
    if post.get("status") == "draft":
        lines.append("status: draft")
    if post["tags"]:
        # Named "postTags", not "tags" -- Eleventy reserves a front matter
        # key literally named "tags" for its own automatic tag-collection
        # mechanism, which silently breaks custom pagination if reused.
        lines.append("postTags:")
        lines.extend(_term_lines(post["tags"]))
    lines.append("---")
    return "\n".join(lines)


def _fence_for(block):
    info = block["lang"] or ""
    if block["title"]:
        info = f'{info} title="{block["title"]}"' if info else f'title="{block["title"]}"'
    # Use a fence longer than any backtick run in the code, so a snippet that
    # itself contains ``` doesn't prematurely close the block.
    code = block["code"]
    longest = max((len(m) for m in re.findall(r"`+", code)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}{info}\n{code}\n{fence}"


# Placeholder name may itself contain an escaped underscore
# (<session_save> -> <session\_save> after markdownify) -- without
# tolerating that, the regex fails to match the whole bracketed token and
# leaves stray bare "<"/">" outside a code span that only wrapped the
# inner word. The whole pattern repeats (one-or-more) so adjacent
# placeholders joined by path characters, or with no separator at all
# ("<cache><backend>"), become a single clean span instead of two
# adjacent ones with an orphaned character between them.
PLACEHOLDER_NAME = r"[a-zA-Z](?:[a-zA-Z0-9_]|\\_)*"
BARE_PLACEHOLDER_RE = re.compile(r"(?:[\w./-]*<" + PLACEHOLDER_NAME + r">)+[\w./-]*")
# Deliberately restricted to identifier-shaped tokens (word chars, escaped
# underscores, dots, slashes, hyphens) -- NOT "anything up to the next
# asterisk/whitespace". A real corpus post has multi-line PHP wrapped in
# emphasis where adjacent spans butt together mid-line
# ("...false);**define(..."); a looser pattern matched across punctuation
# like quotes and parens and produced broken markdown (backticks inserted
# mid-token). This only fires for genuinely single technical terms.
IDENTIFIER_WITH_UNDERSCORE = r"[\w./-]*\\_[\w\\_./-]*"
EMPHASIS_TECHNICAL_TERM_RE = re.compile(r"\*{1,3}(" + IDENTIFIER_WITH_UNDERSCORE + r")\*{1,3}")
BARE_ESCAPED_UNDERSCORE_RE = re.compile(IDENTIFIER_WITH_UNDERSCORE)
TRAILING_PUNCT = ".,;:'\")"


def _apply_to_prose_only(text, fn):
    """Apply fn to text outside fenced code blocks and inline code spans,
    so formatting fixes never touch content that's already real code."""
    parts = re.split(r"(```.*?```)", text, flags=re.S)
    out = []
    for part in parts:
        if part.startswith("```"):
            out.append(part)
            continue
        subparts = re.split(r"(`[^`]*`)", part)
        for sub in subparts:
            if sub.startswith("`") and sub.endswith("`") and len(sub) >= 2:
                out.append(sub)
            else:
                out.append(fn(sub))
    return "".join(out)


def _wrap_bare_placeholders(text):
    def replace(m):
        token = m.group(0).replace("\\_", "_")
        core, trailer = _split_trailing_punct(token)
        return f"`{core}`{trailer}"

    return BARE_PLACEHOLDER_RE.sub(replace, text)


def _split_trailing_punct(token):
    """Peel off trailing punctuation that belongs to the sentence, not the
    identifier (e.g. "id_rsa'" -> "id_rsa", "'")."""
    trailer = ""
    while token and token[-1] in TRAILING_PUNCT:
        trailer = token[-1] + trailer
        token = token[:-1]
    return token, trailer


def _clean_emphasis_wrapped_technical_terms(text):
    def replace(m):
        inner = m.group(1).replace("\\_", "_")
        core, trailer = _split_trailing_punct(inner)
        return f"`{core}`{trailer}"

    return EMPHASIS_TECHNICAL_TERM_RE.sub(replace, text)


def _wrap_bare_escaped_underscore_words(text):
    def replace(m):
        token = m.group(0).replace("\\_", "_")
        core, trailer = _split_trailing_punct(token)
        return f"`{core}`{trailer}"

    return BARE_ESCAPED_UNDERSCORE_RE.sub(replace, text)


def _fix_prose_formatting(body, wrap_underscore_words=False):
    body = _apply_to_prose_only(body, _wrap_bare_placeholders)
    body = _apply_to_prose_only(body, _clean_emphasis_wrapped_technical_terms)
    if wrap_underscore_words:
        # Aggressive: wrap every escaped-underscore word in backticks. Right for
        # a code-heavy blog, wrong generically (turns prose "first_name" into
        # code), so it's opt-in.
        body = _apply_to_prose_only(body, _wrap_bare_escaped_underscore_words)
    else:
        # Still undo markdownify's `\_` escaping so no literal "\_" leaks into
        # prose (intraword underscores don't trigger emphasis in CommonMark).
        body = _apply_to_prose_only(body, lambda s: s.replace("\\_", "_"))
    return body


def normalize_post(post, id_to_slug, lang_overrides=None, own_domain="", wrap_underscore_words=False):
    html = expand_shortcodes(post["content"])
    html = rewrite_links(html, id_to_slug, own_domain)
    html, blocks = extract_pre_blocks(html)

    # Overrides both fill in missing languages (Gutenberg-era blocks carry
    # none at all) and correct mistagged ones (author-set Crayon tags are
    # usually right but occasionally wrong, e.g. a config file tagged as a
    # programming language it isn't).
    overrides_for_post = (lang_overrides or {}).get(post["slug"], {})
    for i, block in enumerate(blocks):
        if i in overrides_for_post:
            block["lang"] = overrides_for_post[i]

    body = markdownify(html)
    for i, block in enumerate(blocks):
        placeholder = PLACEHOLDER_RE_TEMPLATE.format(i)
        body = body.replace(placeholder, _fence_for(block))

    body = re.sub(r"\n{3,}", "\n\n", body)
    body = _fix_prose_formatting(body, wrap_underscore_words)

    return _front_matter(post) + "\n\n" + body.strip() + "\n"
