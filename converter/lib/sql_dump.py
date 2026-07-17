import re

INSERT_RE = re.compile(r"INSERT INTO `(\w+)` VALUES\s*")


def _split_top_level_tuples(text):
    """Split a `(...), (...), (...);` VALUES list into individual tuple
    bodies, respecting single-quoted strings and backslash escaping.
    Stops at the first *top-level* semicolon (not one inside quoted post
    content, which routinely contains semicolons in code snippets), and
    returns the index just past that semicolon so the caller can resume
    scanning for the next INSERT statement from the correct position."""
    tuples = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "(":
            depth, j, in_str = 1, i + 1, False
            while j < n and depth > 0:
                cj = text[j]
                if in_str:
                    if cj == "\\":
                        j += 2
                        continue
                    elif cj == "'":
                        in_str = False
                else:
                    if cj == "'":
                        in_str = True
                    elif cj == "(":
                        depth += 1
                    elif cj == ")":
                        depth -= 1
                j += 1
            tuples.append(text[i + 1 : j - 1])
            i = j
        elif c == ";":
            return tuples, i + 1
        else:
            i += 1
    return tuples, n


def split_fields(row):
    fields, cur, in_str, depth, i, n = [], [], False, 0, 0, len(row)
    while i < n:
        c = row[i]
        if in_str:
            cur.append(c)
            if c == "\\":
                if i + 1 < n:
                    cur.append(row[i + 1])
                i += 2
                continue
            elif c == "'":
                in_str = False
        else:
            if c == "'":
                in_str = True
                cur.append(c)
            elif c == "(":
                depth += 1
                cur.append(c)
            elif c == ")":
                depth -= 1
                cur.append(c)
            elif c == "," and depth == 0:
                fields.append("".join(cur).strip())
                cur = []
            else:
                cur.append(c)
        i += 1
    fields.append("".join(cur).strip())
    return fields


# mysqldump backslash escapes. Anything else after a backslash is that literal
# character (mysqldump leaves e.g. "\d" untouched, meaning a literal "d").
_UNESCAPE = {
    "0": "\0",
    "b": "\b",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "Z": "\x1a",
    "\\": "\\",
    "'": "'",
    '"': '"',
}
_ESCAPE_RE = re.compile(r"\\(.)", re.S)


def unquote(field):
    field = field.strip()
    if field == "NULL":
        return ""
    if not (field.startswith("'") and field.endswith("'")):
        return field
    inner = field[1:-1]
    # Single left-to-right pass: decode each backslash-escape exactly once, so a
    # literal backslash (stored as "\\") is consumed as one unit and never
    # re-interpreted with the following character. (The previous chained
    # str.replace() ran "\n"→newline BEFORE "\\"→"\", corrupting e.g. "C:\\new"
    # into "C:<newline>ew".)
    return _ESCAPE_RE.sub(lambda m: _UNESCAPE.get(m.group(1), m.group(1)), inner)


# The WordPress table prefix is user-configurable ("wp_" by default). Detect it
# from the posts table so a dump using any prefix still parses.
_PREFIX_RE = re.compile(r"INSERT INTO `([0-9a-zA-Z_]*?)posts` VALUES")


def detect_table_prefix(dump_text, default="wp_"):
    m = _PREFIX_RE.search(dump_text)
    return m.group(1) if m else default


def iter_insert_rows(dump_text, table_name):
    """Yield split-field lists for every row across *all* INSERT INTO
    statements for the given table (mysqldump splits large tables into more
    than one INSERT statement)."""
    pos = 0
    marker = f"INSERT INTO `{table_name}` VALUES"
    while True:
        start = dump_text.find(marker, pos)
        if start == -1:
            break
        values_start = start + len(marker)
        tuples, consumed = _split_top_level_tuples(dump_text[values_start:])
        for row in tuples:
            yield split_fields(row)
        pos = values_start + consumed
