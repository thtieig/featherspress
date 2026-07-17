"""Best-effort WordPress shortcode handling.

WordPress stores shortcodes as literal text in post_content; without handling
they leak verbatim into the Markdown. We convert the common ones and otherwise
leave text alone. We are deliberately conservative: we do NOT strip arbitrary
`[...]`, which would eat legitimate prose like "[1]" or "[optional]".

Runs on the raw HTML content, BEFORE code-block extraction and markdownify:
  - [caption ...]INNER[/caption]      → INNER (keeps the image + caption text)
  - [code]/[php]/[python]/[sourcecode]/[crayon ...]BODY[/code]
                                       → <pre class="lang:LANG">BODY</pre>
                                         (so the code-block extractor fences it)
  - a small list of container/self-closing shortcodes (gallery, embed, audio,
    video, playlist, vc_row/column, et al.) → unwrapped / removed
"""
import html as _html
import re

# Code-carrying shortcodes → a <pre> the extractor will turn into a fence.
_CODE_TAGS = {
    "code": None,
    "sourcecode": None,
    "crayon": None,
    "php": "php",
    "python": "python",
    "js": "javascript",
    "javascript": "javascript",
    "html": "html",
    "css": "css",
    "sql": "sql",
    "bash": "bash",
    "shell": "sh",
}

_ATTR_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')


def _attrs(attr_str):
    return {k.lower(): v for k, v in _ATTR_RE.findall(attr_str or "")}


def _expand_code(m):
    tag = m.group("tag").lower()
    attrs = _attrs(m.group("attrs"))
    lang = _CODE_TAGS.get(tag) or attrs.get("lang") or attrs.get("language") or ""
    # The body may be HTML-entity-encoded (WP encodes code shortcode contents).
    # extract_pre_blocks calls pre.get_text(), which decodes entities, so leave
    # the body as-is inside <pre>; wrap the language as a Crayon-style class.
    cls = f' class="lang:{lang}"' if lang else ""
    body = m.group("body")
    return f"<pre{cls}>{body}</pre>"


def _code_pattern():
    names = "|".join(sorted(_CODE_TAGS, key=len, reverse=True))
    return re.compile(
        r"\[(?P<tag>" + names + r")(?P<attrs>[^\]]*)\](?P<body>.*?)\[/(?P=tag)\]",
        re.S | re.I,
    )


_CAPTION_RE = re.compile(r"\[caption[^\]]*\](.*?)\[/caption\]", re.S | re.I)
_CODE_RE = _code_pattern()

# Container shortcodes: drop the tags, keep inner content.
_CONTAINERS = ["vc_row", "vc_column", "vc_column_text", "row", "col", "column"]
_CONTAINER_RE = re.compile(
    r"\[/?(?:" + "|".join(_CONTAINERS) + r")(?:[^\]]*)\]", re.I
)
# Self-closing / media shortcodes with no useful text: remove entirely.
_SELF_CLOSING = ["gallery", "embed", "audio", "video", "playlist", "wpvideo", "youtube", "vimeo"]
_SELF_CLOSING_RE = re.compile(
    r"\[/?(?:" + "|".join(_SELF_CLOSING) + r")(?:[^\]]*)\]", re.I
)


def expand_shortcodes(html):
    html = _CODE_RE.sub(_expand_code, html)
    html = _CAPTION_RE.sub(lambda m: m.group(1), html)
    html = _CONTAINER_RE.sub("", html)
    html = _SELF_CLOSING_RE.sub("", html)
    return html
