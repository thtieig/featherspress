#!/usr/bin/env bash
#
# Take one Featherspress site off this server, as root:
#
#   remove-instance.sh <name>
#
# Stops and disables its units, and removes its code checkout, its config and
# its Apache vhost. Its data (/var/lib/featherspress/<name>), its backups
# (/var/backups/featherspress/<name>) and its user (fp-<name>) are LEFT in
# place, so nothing you might still need is lost: remove those yourself once
# you are sure. Run it from another checkout than the one it removes.
set -euo pipefail

die() { echo "remove-instance: $*" >&2; exit 1; }
[ $# -eq 1 ] || die "usage: remove-instance.sh <name>"
unset CONF_DIR DATA_DIR
INSTANCE="$1" ENGINE_DIR="/opt/featherspress/$1"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/instance.sh"
[ "$(id -u)" = 0 ] || die "run this as root"
[ -d "$ENGINE_DIR" ] || [ -d "$CONF_DIR" ] || die "there is no instance $INSTANCE on this server"

for unit in "featherspress@$INSTANCE.service" \
  "featherspress-backup@$INSTANCE.timer" "featherspress-update@$INSTANCE.timer" \
  "featherspress-backup-control@$INSTANCE.path" "featherspress-backup-control@$INSTANCE.timer" \
  "featherspress-update-control@$INSTANCE.path" "featherspress-update-control@$INSTANCE.timer"; do
  systemctl disable --now --quiet "$unit" 2>/dev/null || true
done
rm -rf "/etc/systemd/system/featherspress-backup@$INSTANCE.timer.d"
systemctl daemon-reload
systemctl reset-failed "featherspress*@$INSTANCE.*" 2>/dev/null || true

for site in "featherspress-$INSTANCE" "featherspress-$INSTANCE-le-ssl"; do
  if [ -e "/etc/apache2/sites-available/$site.conf" ]; then
    a2dissite -q "$site" >/dev/null 2>&1 || true
    rm -f "/etc/apache2/sites-available/$site.conf"
  fi
done

rm -rf "$ENGINE_DIR" "$CONF_DIR"

cat <<EOF
Removed instance "$INSTANCE" (units, code, config, vhost).
Reload Apache:  apache2ctl configtest && systemctl reload apache2
Still here, delete when sure:
  $DATA_DIR
  /var/backups/featherspress/$INSTANCE
  user fp-$INSTANCE      (userdel fp-$INSTANCE)
EOF
