#!/usr/bin/env bash
#
# Add one Featherspress site ("instance") to this server, as root:
#
#   add-instance.sh <name> <domain> <port> [repo-url] [git-ref]
#
#   code     /opt/featherspress/<name>          its own git checkout
#   data     /var/lib/featherspress/<name>      content, media, login, status
#   config   /etc/featherspress/<name>/         featherspress.env, backup.env, update.conf
#   backups  /var/backups/featherspress/<name>
#   user     fp-<name>
#   units    featherspress@<name> and its backup/update timers and agents
#   vhost    /etc/apache2/sites-available/featherspress-<name>.conf (HTTP)
#
# Node must already be in /opt/node (tools/install-node.sh /opt/node). Safe to
# re-run: it keeps an existing checkout, config and login. Apache is only
# reloaded when RELOAD_APACHE=1. repo-url may be a local path or git bundle.
set -euo pipefail

die() { echo "add-instance: $*" >&2; exit 1; }
[ $# -ge 3 ] || die "usage: add-instance.sh <name> <domain> <port> [repo-url] [git-ref]"
NAME="$1" DOMAIN="$2" PORT="$3"
REPO="${4:-https://github.com/thtieig/featherspress.git}"
REF="${5:-main}"
ETC="${FP_ETC:-/etc}"   # where existing instances and vhosts are looked up (tests move it)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Paths for this name, the same way the scripts and agents derive them.
unset CONF_DIR DATA_DIR
INSTANCE="$NAME" ENGINE_DIR="/opt/featherspress/$NAME"
. "$HERE/instance.sh"
CODE="$ENGINE_DIR" BACKUPS="/var/backups/featherspress/$NAME" FP_USER="fp-$NAME"

[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
  die "'$DOMAIN' is not a domain name (lowercase, like blog.example.org)"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] ||
  die "port must be a number from 1024 to 65535"

# --- Check everything before touching anything --------------------------------
for f in "$ETC"/featherspress/*/featherspress.env; do
  [ -f "$f" ] || continue
  other="$(basename "$(dirname "$f")")"
  used="$(sed -n 's/^PORT=["'\'']\{0,1\}\([0-9]*\).*/\1/p' "$f" | tail -n1)"
  if [ "$other" = "$NAME" ]; then
    [ "$used" = "$PORT" ] || die "$NAME already exists, on port $used"
  elif [ "$used" = "$PORT" ]; then
    die "port $PORT is already used by instance $other"
  fi
done
for f in "$ETC"/apache2/sites-available/*.conf; do
  [ -f "$f" ] || continue
  names="$(awk 'tolower($1) ~ /^server(name|alias)$/ { for (i = 2; i <= NF; i++) print tolower($i) }' "$f")"
  case "$(basename "$f")" in
    "featherspress-$NAME.conf" | "featherspress-$NAME-le-ssl.conf")
      grep -qxF "$DOMAIN" <<<"$names" || die "$NAME already serves $(head -n1 <<<"$names"), not $DOMAIN" ;;
    *)
      ! grep -qxF "$DOMAIN" <<<"$names" || die "$DOMAIN is already served by $(basename "$f")" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run this as root"
[ -x /opt/node/bin/node ] || die "no Node in /opt/node; run tools/install-node.sh /opt/node first"
for cmd in git openssl; do command -v "$cmd" >/dev/null || die "$cmd is not installed"; done
cd /   # the site user cannot read root's working directory

# --- User and directories ------------------------------------------------------
id -u "$FP_USER" >/dev/null 2>&1 ||
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$FP_USER"
install -d -m 0755 /opt/featherspress /var/lib/featherspress /etc/featherspress
install -d -m 0700 /var/backups/featherspress "$BACKUPS"
install -d -o "$FP_USER" -g "$FP_USER" -m 0755 "$CODE"
# 0751: Apache may pass through to media/, but nobody else can list the data.
install -d -o "$FP_USER" -g "$FP_USER" -m 0751 "$DATA_DIR"
install -d -o "$FP_USER" -g "$FP_USER" -m 0755 "$DATA_DIR/content" "$DATA_DIR/content/posts" \
  "$DATA_DIR/content/pages" "$DATA_DIR/media"
install -d -o root -g "$FP_USER" -m 0750 "$CONF_DIR"

# --- Code ----------------------------------------------------------------------
as_site() { runuser -u "$FP_USER" -- env PATH="/opt/node/bin:$PATH" "$@"; }
if [ ! -d "$CODE/.git" ]; then
  echo "Cloning $REPO ($REF) into $CODE"
  as_site git clone --quiet --branch "$REF" "$REPO" "$CODE"
fi
echo "Installing dependencies"
as_site npm ci --omit=dev --no-audit --no-fund --loglevel=error --prefix "$CODE"

# --- Config (kept if already there) -------------------------------------------
# write_conf <file> <group> <mode> <sed args...>: fill in deploy/<file>.example.
write_conf() {
  local file="$1" group="$2" mode="$3"; shift 3
  if [ -e "$CONF_DIR/$file" ]; then echo "Keeping $CONF_DIR/$file"; return; fi
  install -o root -g "$group" -m "$mode" /dev/null "$CONF_DIR/$file"
  sed -e "s|@INSTANCE@|$NAME|g" "$@" "$CODE/deploy/$file.example" > "$CONF_DIR/$file"
}
write_conf featherspress.env "$FP_USER" 0640 -e "s|^PORT=.*|PORT=$PORT|" \
  -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|"
write_conf backup.env root 0600
write_conf update.conf root 0600 -e "s|^REPO_REF=.*|REPO_REF=$REF|"

# --- systemd -------------------------------------------------------------------
# The templates are shared by every instance on the server.
install -m 0644 "$CODE"/deploy/featherspress*@.service "$CODE"/deploy/featherspress*@.timer \
  "$CODE"/deploy/featherspress*@.path /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now --quiet "featherspress@$NAME.service" \
  "featherspress-backup@$NAME.timer" "featherspress-update@$NAME.timer" \
  "featherspress-backup-control@$NAME.path" "featherspress-backup-control@$NAME.timer" \
  "featherspress-update-control@$NAME.path" "featherspress-update-control@$NAME.timer"

# --- Apache --------------------------------------------------------------------
VHOST="/etc/apache2/sites-available/featherspress-$NAME.conf"
if [ -d /etc/apache2/sites-available ]; then
  [ -e "$VHOST" ] ||
    sed -e "s|@INSTANCE@|$NAME|g; s|@DOMAIN@|$DOMAIN|g; s|@PORT@|$PORT|g" \
      "$CODE/deploy/apache/featherspress.conf" > "$VHOST"
  a2enmod -q proxy proxy_http headers rewrite >/dev/null
  a2ensite -q "featherspress-$NAME" >/dev/null
  if [ "${RELOAD_APACHE:-0}" = 1 ]; then apache2ctl configtest && systemctl reload apache2; fi
else
  echo "Apache is not installed: no vhost written. Point your proxy at 127.0.0.1:$PORT."
fi

cat <<EOF

Featherspress instance "$NAME" is running on 127.0.0.1:$PORT.

Next steps:
  1. Apache:  apache2ctl configtest && systemctl reload apache2
     HTTPS:   certbot --apache -d $DOMAIN
  2. Create the admin login (password + 2FA):
       sudo -u $FP_USER env SITE_PACKAGE=$DATA_DIR /opt/node/bin/node $CODE/setup.js
     Then either start writing at https://$DOMAIN/admin, or restore a backup
     there (Backup & Restore -> Restore), which brings back the old login too.
EOF
