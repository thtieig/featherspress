import re

from bs4 import BeautifulSoup

# Crayon-style "lang:python" on the <pre>, and Gutenberg/Prism/highlight.js
# "language-python" (usually on an inner <code>, sometimes on the <pre>).
LANG_RE = re.compile(r"lang:([a-zA-Z0-9_+-]+)")
LANG_CLASS_RE = re.compile(r"language-([a-zA-Z0-9_+-]+)")


def _classes(el):
    if el is None:
        return ""
    c = el.get("class")
    return " ".join(c) if isinstance(c, list) else (c or "")


def extract_pre_blocks(html):
    soup = BeautifulSoup(html, "html.parser")
    blocks = []
    for pre in soup.find_all("pre"):
        code = pre.get_text()
        pre_classes = _classes(pre)
        code_el = pre.find("code")
        # Language, in priority order: Crayon lang: on <pre>, then language-*
        # on the inner <code>, then language-* on the <pre> itself.
        m = LANG_RE.search(pre_classes)
        lang = m.group(1) if m else None
        if lang is None:
            m = LANG_CLASS_RE.search(_classes(code_el)) or LANG_CLASS_RE.search(pre_classes)
            lang = m.group(1) if m else None
        title = pre.get("title")
        blocks.append({"lang": lang, "title": title, "code": code})
        placeholder = f"\x00CODEBLOCK{len(blocks) - 1}\x00"
        pre.replace_with(placeholder)
    return str(soup), blocks
