#!/usr/bin/env bash
#
# featherspress backup: pack the live data into a Site Package (profile "full",
# so credentials are included for disaster recovery), optionally encrypt it, ship
# it to a destination, and prune to keep-last-N. A backup is just an export saved
# somewhere — restore with:  npm run import -- <artifact> [--restore-auth]
#
# Run as root from a systemd timer. Reads two env files:
#   /etc/featherspress/featherspress.env   (CONTENT_DIR/MEDIA_DIR/AUTH_CONFIG — so
#                                            the exporter resolves the right data)
#   /etc/featherspress/backup.env          (DEST_TYPE/retention/age recipient)
set -euo pipefail

FP_ENV="${FP_ENV:-/etc/featherspress/featherspress.env}"
BACKUP_ENV="${BACKUP_ENV:-/etc/featherspress/backup.env}"
ENGINE_DIR="${ENGINE_DIR:-/opt/featherspress}"
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"

[ -f "$FP_ENV" ] || { echo "missing $FP_ENV (needed so the exporter finds the data dir)" >&2; exit 1; }
[ -f "$BACKUP_ENV" ] || { echo "missing $BACKUP_ENV (copy deploy/backup.env.example there)" >&2; exit 1; }

# Export the app's data-dir vars so `node tools/site-package.js` resolves them.
set -a
# shellcheck disable=SC1090
. "$FP_ENV"
# shellcheck disable=SC1090
. "$BACKUP_ENV"
set +a

DEST_TYPE="${DEST_TYPE:-local}"
KEEP_LAST="${KEEP_LAST:-14}"
# KEEP_LAST=0 prunes the artifact this run just made, so the job "succeeds" and
# leaves you with NO backups at all. Refuse rather than quietly delete the lot.
case "$KEEP_LAST" in
  ''|*[!0-9]*) echo "[backup] refusing: KEEP_LAST must be a positive integer (got '$KEEP_LAST')" >&2; exit 1 ;;
esac
[ "$KEEP_LAST" -ge 1 ] || { echo "[backup] refusing: KEEP_LAST must be >= 1 (got $KEEP_LAST) — 0 would delete every backup, including the one just taken" >&2; exit 1; }
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASENAME="featherspress-full-${STAMP}.tar.gz"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ARTIFACT="$WORK/$BASENAME"

echo "[backup] exporting full Site Package…"
"$NODE_BIN" "$ENGINE_DIR/tools/site-package.js" export --profile full --out "$ARTIFACT"

# Encryption is MANDATORY off-box (the full artifact carries the TOTP secret and
# password hash). Local stays plaintext (same trust boundary as the machine).
if [ "$DEST_TYPE" != "local" ]; then
  if [ -z "${AGE_RECIPIENT:-}" ]; then
    echo "[backup] refusing: DEST_TYPE=$DEST_TYPE requires AGE_RECIPIENT (age public key) to encrypt off-box" >&2
    exit 1
  fi
  echo "[backup] encrypting with age…"
  age -r "$AGE_RECIPIENT" -o "$ARTIFACT.age" "$ARTIFACT"
  rm -f "$ARTIFACT"
  ARTIFACT="$ARTIFACT.age"
  BASENAME="$BASENAME.age"
elif [ -n "${AGE_RECIPIENT:-}" ]; then
  # Encrypt local copies too if a recipient is configured (optional).
  echo "[backup] encrypting local copy with age…"
  age -r "$AGE_RECIPIENT" -o "$ARTIFACT.age" "$ARTIFACT"
  rm -f "$ARTIFACT"
  ARTIFACT="$ARTIFACT.age"
  BASENAME="$BASENAME.age"
fi

case "$DEST_TYPE" in
  local)
    : "${LOCAL_DIR:?set LOCAL_DIR for DEST_TYPE=local}"
    mkdir -p "$LOCAL_DIR"
    # Copy to a temp name in the SAME dir, then rename. A plain `cp` to the final
    # name leaves a truncated file behind if the run is killed mid-copy (a full
    # disk, a reboot, systemd timing it out) — and that stub then looks like a
    # backup, counts against KEEP_LAST, and can push a real backup out.
    cp -f "$ARTIFACT" "$LOCAL_DIR/.$BASENAME.partial"
    mv -f "$LOCAL_DIR/.$BASENAME.partial" "$LOCAL_DIR/$BASENAME"
    echo "[backup] stored $LOCAL_DIR/$BASENAME"
    # Prune: keep newest N (names sort chronologically by timestamp).
    mapfile -t OLD < <(ls -1 "$LOCAL_DIR"/featherspress-full-*.tar.gz* 2>/dev/null | sort | head -n -"$KEEP_LAST" || true)
    for f in "${OLD[@]:-}"; do [ -n "$f" ] && rm -f "$f" && echo "[backup] pruned $(basename "$f")"; done
    ;;
  rclone)
    : "${RCLONE_REMOTE:?set RCLONE_REMOTE for DEST_TYPE=rclone, e.g. s3:bucket/path or dropbox:featherspress}"
    rclone copyto "$ARTIFACT" "$RCLONE_REMOTE/$BASENAME"
    echo "[backup] uploaded $RCLONE_REMOTE/$BASENAME"
    # Prune: keep newest N at the remote.
    mapfile -t OLD < <(rclone lsf "$RCLONE_REMOTE" --include 'featherspress-full-*' 2>/dev/null | sort | head -n -"$KEEP_LAST" || true)
    for f in "${OLD[@]:-}"; do [ -n "$f" ] && rclone deletefile "$RCLONE_REMOTE/$f" && echo "[backup] pruned $f"; done
    ;;
  *)
    echo "[backup] unknown DEST_TYPE: $DEST_TYPE (use local|rclone)" >&2
    exit 1
    ;;
esac

echo "[backup] done."
