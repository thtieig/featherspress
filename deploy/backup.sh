#!/usr/bin/env bash
#
# featherspress backup: pack the live data into a Site Package (profile "full",
# so credentials are included for disaster recovery), optionally encrypt it, keep
# it in this site's backup folder (the /admin backups list), optionally upload a
# copy off the box, and prune both to keep-last-N. A backup is just an export
# saved somewhere — restore with:  npm run import -- <artifact> [--restore-auth]
#
# Run as root from featherspress-backup@<name>.timer, for that one instance
# (see deploy/instance.sh). Reads two env files from /etc/featherspress/<name>/:
#   featherspress.env   (SITE_PACKAGE, so the exporter resolves the right data)
#   backup.env          (DEST_TYPE/retention/age recipient)
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/instance.sh"
FP_ENV="${FP_ENV:-$CONF_DIR/featherspress.env}"
BACKUP_ENV="${BACKUP_ENV:-$CONF_DIR/backup.env}"
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"
LAST_RUN_FILE="${LAST_RUN_FILE:-$DATA_DIR/backup-last-run.json}"
BACKUP_LOCK="${BACKUP_LOCK:-/run/featherspress-backup-$INSTANCE.lock}"

# Record the outcome for the /admin Backups panel (via backup-control.js status).
record_run() {
  local ok="$1" err="$2" bytes="${3:-0}"
  printf '{"at":"%s","ok":%s,"error":%s,"artifactBytes":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$err" "$bytes" > "$LAST_RUN_FILE" 2>/dev/null || true
  "$NODE_BIN" "$ENGINE_DIR/tools/backup-control.js" status 2>/dev/null || true
}

# Every way this script can fail is recorded as a failed run, so the panel
# shows it, and emailed when /admin → Email alerts is set up. refuse() sets
# the message the panel shows (fixed text: no quotes, no values) and logs the
# detail; anything else that stops the script (set -e, an unset ${VAR:?})
# shows the generic one, and the email's log tail says what it was.
FAIL_MSG="backup run failed"
refuse() {
  FAIL_MSG="$1"
  echo "[backup] refusing: $1${2:+ ($2)}" >&2
  exit 1
}

# A copy of this run's error output, for the failure email. It still goes to
# the journal as before (fd 3 is the original stderr).
ERR_LOG="$(mktemp)"
exec 3>&2 2> >(tee -a "$ERR_LOG" >&3)
TEE_PID=$!

# One email per failed run (tools/notify.js; it sends nothing until email
# alerts are set up, and never fails this script).
send_alert() {
  {
    echo "The backup of this site failed: $FAIL_MSG."
    echo
    echo "The last lines it logged:"
    tail -n 25 "$ERR_LOG"
  } | "$NODE_BIN" "$ENGINE_DIR/tools/notify.js" --subject "Backup failed" || true
}

WORK=""
on_exit() {
  local rc=$?
  # Back to the plain stderr, and let tee finish, so the log copy is complete.
  exec 2>&3
  wait "$TEE_PID" 2>/dev/null || true
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ "$rc" -ne 0 ]; then
    record_run false "\"$FAIL_MSG\"" 0
    send_alert
  fi
  rm -f "$ERR_LOG"
}
trap on_exit EXIT

[ -f "$FP_ENV" ] || refuse "featherspress.env is missing; the exporter needs it to find the site" "$FP_ENV"
[ -f "$BACKUP_ENV" ] || refuse "backup.env is missing; copy deploy/backup.env.example there" "$BACKUP_ENV"

# Serialize with any other backup run — the /admin "back up now" button and the
# scheduled timer can otherwise overlap and race the prune step. Second run bows
# out cleanly rather than corrupting the destination.
if ! exec 9>"$BACKUP_LOCK"; then
  refuse "cannot open the backup lock file" "$BACKUP_LOCK"
fi
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "[backup] another backup is already running; skipping this run" >&2
    exit 0
  fi
else
  echo "[backup] warning: flock not found; concurrent backup runs will NOT be serialized" >&2
fi

# Export the app's data-dir vars so `node tools/site-package.js` resolves them.
set -a
# shellcheck disable=SC1090
. "$FP_ENV"
# shellcheck disable=SC1090
. "$BACKUP_ENV"
set +a

DEST_TYPE="${DEST_TYPE:-local}"
case "$DEST_TYPE" in
  local|rclone) : ;;
  *) refuse "unknown DEST_TYPE in backup.env; use local or rclone" "got '$DEST_TYPE'" ;;
esac
KEEP_LAST="${KEEP_LAST:-14}"
# KEEP_LAST=0 prunes the artifact this run just made, so the job "succeeds" and
# leaves you with NO backups at all. Refuse rather than quietly delete the lot.
case "$KEEP_LAST" in
  ''|*[!0-9]*) refuse "KEEP_LAST must be a whole number of at least 1" "got '$KEEP_LAST'" ;;
esac
[ "$KEEP_LAST" -ge 1 ] || refuse "KEEP_LAST must be at least 1; 0 would delete every backup, including this one"

# Encryption is MANDATORY off-box (the full artifact carries the TOTP secret and
# password hash). Local stays plaintext (same trust boundary as the machine).
if [ "$DEST_TYPE" != "local" ] && [ -z "${AGE_RECIPIENT:-}" ]; then
  refuse "an off-box destination needs encryption; set up an encryption key first" "DEST_TYPE=$DEST_TYPE, no AGE_RECIPIENT"
fi

# Every backup is kept on this server: that copy is what the /admin backups
# list restores from. DEST_TYPE=rclone ALSO uploads it, as the safety copy for
# a lost box. Same KEEP_LAST in both places.
LOCAL_DIR="${LOCAL_DIR:-$BACKUP_ROOT}"

# Off-box, each site gets its own folder under the configured remote path
# (RCLONE_REMOTE=s3:bucket/featherspress -> s3:bucket/featherspress/<name>), so
# sites sharing a remote never prune each other's backups.
if [ "$DEST_TYPE" = "rclone" ]; then
  [ -n "${RCLONE_REMOTE:-}" ] ||
    refuse "off-box is chosen but no remote is set (RCLONE_REMOTE in backup.env)"
  REMOTE_DIR="${RCLONE_REMOTE%/}/$INSTANCE"
  # Fewer retries than rclone's defaults: refused credentials or a stopped
  # server fail at once, an unreachable host within a few minutes (about 4 on
  # the test box), instead of holding the run much longer.
  export RCLONE_CONTIMEOUT="${RCLONE_CONTIMEOUT:-20s}" RCLONE_TIMEOUT="${RCLONE_TIMEOUT:-60s}"
  export RCLONE_RETRIES="${RCLONE_RETRIES:-2}" RCLONE_LOW_LEVEL_RETRIES="${RCLONE_LOW_LEVEL_RETRIES:-2}"
fi

# Which sections the scheduled backup captures (set from /admin). Empty = all.
# A bash array is used so that an empty BACKUP_SECTIONS passes NO --sections
# argument at all — an empty string argument would be parsed by site-package.js
# as a (single, invalid) section name rather than meaning "all of them".
BACKUP_SECTIONS="${BACKUP_SECTIONS:-}"
SECTION_ARGS=()
if [ -n "$BACKUP_SECTIONS" ]; then
  SECTION_ARGS=(--sections "$BACKUP_SECTIONS")
fi

# The name carries the engine's short commit, so the /admin backups list can
# show which engine took a backup without opening it (engine.json inside says
# the same). Left out when the checkout has no readable git metadata.
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ENGINE_COMMIT="$("$NODE_BIN" -e 'process.stdout.write(require(process.argv[1]).engineInfo(process.argv[2]).commit || "")' \
  "$ENGINE_DIR/tools/agent-lib.js" "$ENGINE_DIR" 2>/dev/null || true)"
[[ "$ENGINE_COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || ENGINE_COMMIT=""
BASENAME="featherspress-full-${STAMP}${ENGINE_COMMIT:+-$ENGINE_COMMIT}.tar.gz"

WORK="$(mktemp -d)"
ARTIFACT="$WORK/$BASENAME"

echo "[backup] exporting full Site Package…"
"$NODE_BIN" "$ENGINE_DIR/tools/site-package.js" export --profile full "${SECTION_ARGS[@]}" --out "$ARTIFACT"

# Off-box copies are always encrypted (checked above); local ones only when a
# recipient is configured.
if [ -n "${AGE_RECIPIENT:-}" ]; then
  echo "[backup] encrypting with age…"
  age -r "$AGE_RECIPIENT" -o "$ARTIFACT.age" "$ARTIFACT"
  rm -f "$ARTIFACT"
  ARTIFACT="$ARTIFACT.age"
  BASENAME="$BASENAME.age"
fi

# --- On this server ---------------------------------------------------------
# Every artifact here is a "full" export: password hash + TOTP secret. When
# no AGE_RECIPIENT is set it is PLAINTEXT. The folder is root's, readable by
# its group only: deploy/add-instance.sh makes this site's folder 0750
# root:fp-<name>, so /admin can list, download and restore these backups
# while only root can write or delete them. The site user can already read
# the live login these carry, so this shows it nothing new. A folder we
# create takes its parent's group. If an existing one is wider than that,
# say so rather than silently re-permissioning a path the operator may
# share with other jobs.
if [ -d "$LOCAL_DIR" ]; then
  MODE="$(stat -c %a "$LOCAL_DIR")"
  case "$MODE" in
    *0) : ;; # nothing for "other"
    *)
      echo "[backup] warning: $LOCAL_DIR is mode $MODE — readable beyond its owner and group." >&2
      echo "[backup]          Backups contain your password hash and TOTP secret." >&2
      echo "[backup]          Run: chmod 750 $LOCAL_DIR   (or set AGE_RECIPIENT to encrypt)" >&2
      ;;
  esac
else
  mkdir -p "$LOCAL_DIR"
  chgrp --reference="$(dirname "$LOCAL_DIR")" "$LOCAL_DIR"
  chmod 0750 "$LOCAL_DIR"
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
# Open this backup, and any from before the list existed (0600 root:root),
# to the folder's group.
for f in "$LOCAL_DIR"/featherspress-full-*.tar.gz*; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  chgrp --reference="$LOCAL_DIR" "$f" && chmod 0640 "$f"
done
STORED_BYTES="$(stat -c%s "$LOCAL_DIR/$BASENAME" 2>/dev/null || echo 0)"
echo "[backup] stored $LOCAL_DIR/$BASENAME"
# Prune: keep newest N (names sort chronologically by timestamp).
mapfile -t OLD < <(ls -1 "$LOCAL_DIR"/featherspress-full-*.tar.gz* 2>/dev/null | sort | head -n -"$KEEP_LAST" || true)
for f in "${OLD[@]:-}"; do [ -n "$f" ] && rm -f "$f" && echo "[backup] pruned $(basename "$f")"; done

# --- Off the box ------------------------------------------------------------
if [ "$DEST_TYPE" = "rclone" ]; then
  if ! rclone copyto "$ARTIFACT" "$REMOTE_DIR/$BASENAME"; then
    refuse "the off-box copy failed; this backup is kept on this server only" "$REMOTE_DIR"
  fi
  echo "[backup] uploaded $REMOTE_DIR/$BASENAME"
  # Prune: keep newest N in this site's remote folder.
  mapfile -t OLD < <(rclone lsf "$REMOTE_DIR" --include 'featherspress-full-*' 2>/dev/null | sort | head -n -"$KEEP_LAST" || true)
  for f in "${OLD[@]:-}"; do [ -n "$f" ] && rclone deletefile "$REMOTE_DIR/$f" && echo "[backup] pruned off-box $f"; done
fi

record_run true null "${STORED_BYTES:-0}"
echo "[backup] done."
