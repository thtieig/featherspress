import re

# Attribute values may be single- or double-quoted; match the closing quote to
# the opening one. Any absolute uploads URL (any host) becomes root-relative;
# the caller then maps /wp-content/uploads/ → /media/.
UPLOAD_URL_RE = re.compile(
    r'(?P<attr>src|href)=(?P<q>["\'])https?://[^"\']*?(?P<path>/wp-content/uploads/[^"\']*)(?P=q)'
)


def rewrite_links(html, id_to_slug, own_domain=""):
    """Rewrite a post body's links: the site's own `?p=<id>` and pretty
    permalinks become local `/slug/` links; absolute uploads URLs become
    root-relative. `own_domain` is the site's host (from --url); when empty,
    only the uploads rewrite runs (internal-link rewriting needs the domain)."""

    def replace_permalink(match):
        slug = id_to_slug.get(match.group("id"))
        return match.group(0) if slug is None else f'href="/{slug}/"'

    if own_domain:
        host = re.escape(own_domain)
        query_re = re.compile(
            r'href=(?P<q>["\'])https?://(?:www\.)?' + host + r'/\?p=(?P<id>\d+)(?P=q)'
        )
        pretty_re = re.compile(
            r'href=(?P<q>["\'])https?://(?:www\.)?' + host + r'/(?!wp-content/|\?p=)(?P<path>[^"\']*)(?P=q)'
        )
        html = query_re.sub(replace_permalink, html)
        html = pretty_re.sub(lambda m: f'href="/{m.group("path")}"', html)

    html = UPLOAD_URL_RE.sub(lambda m: f'{m.group("attr")}="{m.group("path")}"', html)
    return html
