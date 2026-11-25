#!/usr/bin/env bash
#
# featherspress update: check the git remote for newer engine code and write a
# status file the admin UI reads. If AUTO_APPLY=1 it also applies the update
# (pull → npm ci → restart → health-check → rollback on failure). Run as root
# from a systemd timer.
#
# The app itself never runs git or restarts — that stays here, in root's hands,
# so the hardened (unprivileged, read-only-code) service model is preserved.
set -euo pipefail

FP_ENV="${FP_ENV:-/etc/featherspress/featherspress.env}"
UPDATE_CONF="${UPDATE_CONF:-/etc/featherspress/update.conf}"
UPDATE_LOCK="${UPDATE_LOCK:-/run/featherspress-update.lock}"

# Serialize with any other update run — the GUI's "Apply now" button
# (tools/update-control.js) and the routine daily check can otherwise overlap
# and both step on the same rollback point / npm ci. This is the same guard
# as deploy/backup.sh's, with ONE deliberate deviation: BLOCK up to 30s
# (`flock -w 30`, not `flock -n`) and, on failure to acquire, `exit 1` (not
# `exit 0`). A non-blocking skip is right for backup.sh — a missed scheduled
# backup just retries next tick — but wrong here: if a GUI-triggered
# forced-apply lost a non-blocking race against the routine daily check and
# silently exited 0, tools/update-control.js would read that as success and
# report "applied" when nothing was actually done. A routine check only takes
# a few seconds, so the 30s wait is never felt in practice, and a genuine
# second-apply-in-progress should fail loudly rather than lie about
# succeeding.
if ! exec 9>"$UPDATE_LOCK"; then
  echo "[update] refusing: cannot open the lock file $UPDATE_LOCK" >&2
  exit 1
fi
if command -v flock >/dev/null 2>&1; then
  if ! flock -w 30 9; then
    echo "[update] could not acquire the update lock within 30s; another update run is in progress" >&2
    exit 1
  fi
else
  echo "[update] warning: flock not found; concurrent update runs will NOT be serialized" >&2
fi

# update.conf holds this box's settings, but a value already set in the
# environment wins over it. That is how "Apply now" (tools/update-control.js)
# or an operator (`AUTO_APPLY=1 update.sh`) forces one apply on a box whose
# update.conf says AUTO_APPLY=0, while REPO_REF, NODE_BIN and the rest still
# come from update.conf.
OVERRIDABLE="AUTO_APPLY REPO_REF ENGINE_DIR NODE_BIN NPM_BIN SERVICE FP_USER"
declare -A FROM_ENV=()
for v in $OVERRIDABLE; do [ -n "${!v:-}" ] && FROM_ENV[$v]="${!v}"; done
[ -f "$FP_ENV" ] && { set -a; . "$FP_ENV"; set +a; }
[ -f "$UPDATE_CONF" ] && { set -a; . "$UPDATE_CONF"; set +a; }
for v in "${!FROM_ENV[@]}"; do printf -v "$v" '%s' "${FROM_ENV[$v]}"; done

ENGINE_DIR="${ENGINE_DIR:-/opt/featherspress}"
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"
NPM_BIN="${NPM_BIN:-/opt/node/bin/npm}"
SERVICE="${SERVICE:-featherspress}"
AUTO_APPLY="${AUTO_APPLY:-0}"
REPO_REF="${REPO_REF:-main}"
PORT="${PORT:-8787}"
STATUS_FILE="${UPDATE_STATUS_FILE:-${CONTENT_DIR:-/var/lib/featherspress/content}/../update-status.json}"

# systemd gives this unit a bare PATH, but npm's shebang is `#!/usr/bin/env node`
# — without node's dir on PATH, `npm ci` dies with "env: 'node': No such file or
# directory" *after* the code has already been moved forward.
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH

cd "$ENGINE_DIR"

# The code dir is owned by the unprivileged app user, and git refuses to operate
# on a repo owned by someone else ("detected dubious ownership"), which makes
# every git call below fail when this runs as root from the timer. Run git AS the
# owner instead of teaching root to trust the path: it also keeps newly written
# objects owned correctly, so no chown -R is needed to repair them afterwards.
REPO_OWNER="$(stat -c %U "$ENGINE_DIR")"
# Default to whoever actually owns the code dir: everything else runs as
# REPO_OWNER, and a divergent FP_USER makes the chown below fail (or hand the
# repo to the wrong user) on any box whose app user is not "featherspress".
FP_USER="${FP_USER:-$REPO_OWNER}"
run_as_owner() {
  if [ "$(id -u)" = "0" ] && [ "$REPO_OWNER" != "root" ]; then
    # `env PATH=…` rather than relying on --preserve-env=PATH alone: sudoers
    # `secure_path` (set by default on Debian) replaces PATH, and while root's
    # sudo does honour --preserve-env here, setting it explicitly inside the
    # target command removes the dependency on that. Without node's dir on PATH,
    # npm's `#!/usr/bin/env node` shebang cannot start.
    sudo -u "$REPO_OWNER" env PATH="$PATH" "$@"
  else
    "$@"
  fi
}
git_as() { run_as_owner git -C "$ENGINE_DIR" "$@"; }

git_as fetch --quiet origin "$REPO_REF"
CURRENT="$(git_as rev-parse HEAD)"
AVAILABLE="$(git_as rev-parse "origin/$REPO_REF")"
BEHIND="$(git_as rev-list --count "HEAD..origin/$REPO_REF")"
# Re-read on every write_status: after an apply, package.json is a NEW file, and
# reporting the pre-update version next to the post-update commit would have the
# admin banner quietly lying about what is deployed.
read_version() {
  "$NODE_BIN" -p "require('$ENGINE_DIR/package.json').version" 2>/dev/null || echo unknown
}
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
AVAILABLE_BOOL=false
[ "$BEHIND" -gt 0 ] && AVAILABLE_BOOL=true

write_status() {
  local tmp
  # In the status file's own directory, so the rename is atomic — a mktemp in
  # /tmp can land on another filesystem, making `mv` a copy the admin UI could
  # read half-written.
  mkdir -p "$(dirname "$STATUS_FILE")"
  tmp="$(mktemp "$(dirname "$STATUS_FILE")/.update-status.XXXXXX")"
  printf '{"available":%s,"behind":%s,"currentCommit":"%s","currentVersion":"%s","availableCommit":"%s","checkedAt":"%s"}\n' \
    "$AVAILABLE_BOOL" "$BEHIND" "$CURRENT" "$(read_version)" "$AVAILABLE" "$NOW" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$STATUS_FILE"
}
write_status
echo "[update] behind=$BEHIND current=${CURRENT:0:7} available=${AVAILABLE:0:7} auto_apply=$AUTO_APPLY"

[ "$BEHIND" -eq 0 ] && { echo "[update] up to date."; exit 0; }
[ "$AUTO_APPLY" != "1" ] && { echo "[update] update available — AUTO_APPLY off, leaving for the operator."; exit 0; }

# A modified code dir makes `git merge --ff-only` abort with git's own wording,
# which reads like a developer problem rather than "this box stopped updating".
# Worse, an edit to a file the incoming commit does not touch merges cleanly and
# survives silently. Say plainly what is wrong before attempting the merge.
DIRTY="$(git_as status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "[update] refusing to apply: $ENGINE_DIR has uncommitted local changes" >&2
  echo "$DIRTY" >&2
  echo "[update] commit, stash, or 'git checkout --' them, then re-run." >&2
  exit 1
fi

echo "[update] applying (rollback point: ${CURRENT:0:7})…"

# Restore the code to the rollback point and get the service running on it again.
# Used both when the new code fails its health check and when the new code never
# got as far as installing — a half-applied update (new code, old deps) must
# never be left behind.
rollback() {
  echo "[update] rolling back to ${CURRENT:0:7}" >&2
  git_as reset --hard "$CURRENT"
  run_as_owner "$NPM_BIN" ci --omit=dev --prefix "$ENGINE_DIR" || true
  chown -R "$FP_USER:$FP_USER" "$ENGINE_DIR"
  systemctl restart "$SERVICE"
  AVAILABLE_BOOL=true
  write_status
  if healthy; then
    echo "[update] rolled back and healthy at ${CURRENT:0:7}." >&2
  else
    echo "[update] ROLLBACK DID NOT RECOVER THE SERVICE — manual intervention needed." >&2
  fi
}

# A restarted engine is healthy only if it both answers /healthz AND renders the
# home page. /healthz alone is too weak: it returns 200 even with no content and
# no skin at all, so it cannot tell a working deploy from a broken render.
healthy() {
  local i
  for i in $(seq 1 10); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null &&
       curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

git_as merge --ff-only "origin/$REPO_REF"

# From here on the code dir has MOVED FORWARD. Any failure below must restore
# the rollback point rather than leave a half-applied update behind: `set -e`
# would otherwise abort straight past rollback() on a failed chown or restart.
trap 'echo "[update] step failed — rolling back" >&2; rollback; exit 1' ERR

if ! run_as_owner "$NPM_BIN" ci --omit=dev --prefix "$ENGINE_DIR"; then
  echo "[update] dependency install FAILED on the new commit" >&2
  rollback
  exit 1
fi
chown -R "$FP_USER:$FP_USER" "$ENGINE_DIR"
systemctl restart "$SERVICE"

if ! healthy; then
  echo "[update] health-check FAILED after restart" >&2
  rollback
  exit 1
fi

# Success: the restart and health-check both passed, so the deploy is already
# healthy — disarm the rollback trap BEFORE the status refresh below, since an
# assignment from a failing command substitution fires ERR too, and that would
# roll back an already-healthy, already-restarted deploy over nothing worse
# than a flaky `git rev-parse`.
trap - ERR

# Refresh status (behind=0) now that we're at the pulled commit.
CURRENT="$(git_as rev-parse HEAD)"
BEHIND=0
AVAILABLE_BOOL=false
write_status
echo "[update] applied and healthy at ${CURRENT:0:7}."
