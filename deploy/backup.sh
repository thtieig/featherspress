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

# Serialize with any other backup run — the /admin "back up now" button and the
# scheduled timer can otherwise overlap and race the prune step. Second run bows
# out cleanly rather than corrupting the destination.
if ! exec 9>"/run/featherspress-backup.lock"; then
  echo "[backup] refusing: cannot open the lock file /run/featherspress-backup.lock" >&2
  exit 1
fi
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  echo "[backup] another backup is already running; skipping this run" >&2
  exit 0
fi

# Record the outcome for the /admin Backups panel (via backup-control.js status).
LAST_RUN_FILE="${LAST_RUN_FILE:-/var/lib/featherspress/backup-last-run.json}"
record_run() {
  local ok="$1" err="$2" bytes="${3:-0}"
  printf '{"at":"%s","ok":%s,"error":%s,"artifactBytes":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$err" "$bytes" > "$LAST_RUN_FILE" 2>/dev/null || true
  "${NODE_BIN:-/opt/node/bin/node}" "${ENGINE_DIR:-/opt/featherspress}/tools/backup-control.js" status 2>/dev/null || true
}
# On ANY failure below, record it (with a fixed message — never the raw error).
trap 'record_run false "\"backup run failed\"" 0' ERR

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
    # Every artifact here is a "full" export: password hash + TOTP secret. When
    # no AGE_RECIPIENT is set it is PLAINTEXT, so the destination must not be
    # world-readable. Tighten a directory we create ourselves; if one already
    # exists with wider permissions, say so rather than silently re-permissioning
    # a path the operator may share with other jobs.
    if [ -d "$LOCAL_DIR" ]; then
      MODE="$(stat -c %a "$LOCAL_DIR")"
      case "$MODE" in
        700|750|*00) : ;;
        *)
          echo "[backup] warning: $LOCAL_DIR is mode $MODE — readable beyond its owner." >&2
          echo "[backup]          Backups contain your password hash and TOTP secret." >&2
          echo "[backup]          Run: chmod 700 $LOCAL_DIR   (or set AGE_RECIPIENT to encrypt)" >&2
          ;;
      esac
    else
      mkdir -p "$LOCAL_DIR"
      chmod 0700 "$LOCAL_DIR"
    fi
    # Sweep any truncated leftovers from a run that died mid-copy (see below).
    rm -f "$LOCAL_DIR"/.featherspress-full-*.partial
    # Copy to a temp name in the SAME dir, then rename. A plain `cp` to the final
    # name leaves a truncated file behind if the run is killed mid-copy (a full
    # disk, a reboot, systemd timing it out) — and that stub then looks like a
    # backup, counts against KEEP_LAST, and can push a real backup out.
    cp -f "$ARTIFACT" "$LOCAL_DIR/.$BASENAME.partial"
    chmod 0600 "$LOCAL_DIR/.$BASENAME.partial"
    mv -f "$LOCAL_DIR/.$BASENAME.partial" "$LOCAL_DIR/$BASENAME"
    STORED_BYTES="$(stat -c%s "$LOCAL_DIR/$BASENAME" 2>/dev/null || echo 0)"
    echo "[backup] stored $LOCAL_DIR/$BASENAME"
    # Prune: keep newest N (names sort chronologically by timestamp).
    mapfile -t OLD < <(ls -1 "$LOCAL_DIR"/featherspress-full-*.tar.gz* 2>/dev/null | sort | head -n -"$KEEP_LAST" || true)
    for f in "${OLD[@]:-}"; do [ -n "$f" ] && rm -f "$f" && echo "[backup] pruned $(basename "$f")"; done
    ;;
  rclone)
    : "${RCLONE_REMOTE:?set RCLONE_REMOTE for DEST_TYPE=rclone, e.g. s3:bucket/path or dropbox:featherspress}"
    rclone copyto "$ARTIFACT" "$RCLONE_REMOTE/$BASENAME"
    STORED_BYTES="$(stat -c%s "$ARTIFACT" 2>/dev/null || echo 0)"
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

record_run true null "${STORED_BYTES:-0}"
echo "[backup] done."
