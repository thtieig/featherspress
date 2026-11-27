# Sourced by the deploy scripts: which named instance this is, and its
# directories, all derived from the name. tools/agent-lib.js is the Node twin.
#
# The name is INSTANCE, or else the name of the checkout this script lives in
# (/opt/featherspress/<name>), so the systemd units and a hand-run
# `sudo /opt/featherspress/<name>/deploy/update.sh` agree without being told.
# Each directory can be moved from the environment (the tests do).
ENGINE_DIR="${ENGINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTANCE="${INSTANCE:-$(basename "$ENGINE_DIR")}"
if ! [[ "$INSTANCE" =~ ^[a-z][a-z0-9-]{0,23}$ ]]; then
  echo "invalid instance name '$INSTANCE' (lowercase letters, digits and dashes, 24 at most)" >&2
  exit 1
fi
CONF_DIR="${CONF_DIR:-/etc/featherspress/$INSTANCE}"
DATA_DIR="${DATA_DIR:-/var/lib/featherspress/$INSTANCE}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/featherspress/$INSTANCE}"
# Exported so the Node agents these scripts call agree on the same instance.
export ENGINE_DIR INSTANCE CONF_DIR DATA_DIR BACKUP_ROOT

# put_data_file <target> <mode>: write stdin to <target>, a file in the site's
# data dir, safely as root. The site user owns that dir, so it can put a
# symlink at any name in it (or swap root's temp file for one), and the
# kernel's symlink protection does not cover a dir that is not sticky and
# world-writable. So the file is made in a fresh root-only dir beside the data
# dir (the same filesystem) and renamed into place: rename(2) replaces a link
# planted at the target, it never writes through it.
put_data_file() {
  local target="$1" mode="$2" d rc=0
  d="$(mktemp -d "$(dirname "$(dirname "$target")")/.fp-put.XXXXXX")" || return 1
  { cat > "$d/f" && chmod "$mode" "$d/f" && mv -fT "$d/f" "$target"; } || rc=1
  rm -rf "$d"
  return "$rc"
}
