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
ENGINE_DIR="${ENGINE_DIR:-/opt/featherspress}"
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"
NPM_BIN="${NPM_BIN:-/opt/node/bin/npm}"
FP_USER="${FP_USER:-featherspress}"
SERVICE="${SERVICE:-featherspress}"

[ -f "$FP_ENV" ] && { set -a; . "$FP_ENV"; set +a; }
[ -f "$UPDATE_CONF" ] && { set -a; . "$UPDATE_CONF"; set +a; }

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
run_as_owner() {
  if [ "$(id -u)" = "0" ] && [ "$REPO_OWNER" != "root" ]; then
    sudo -u "$REPO_OWNER" --preserve-env=PATH "$@"
  else
    "$@"
  fi
}
git_as() { run_as_owner git -C "$ENGINE_DIR" "$@"; }

git_as fetch --quiet origin "$REPO_REF"
CURRENT="$(git_as rev-parse HEAD)"
AVAILABLE="$(git_as rev-parse "origin/$REPO_REF")"
BEHIND="$(git_as rev-list --count "HEAD..origin/$REPO_REF")"
VERSION="$("$NODE_BIN" -p "require('$ENGINE_DIR/package.json').version" 2>/dev/null || echo unknown)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
AVAILABLE_BOOL=false
[ "$BEHIND" -gt 0 ] && AVAILABLE_BOOL=true

write_status() {
  local tmp
  tmp="$(mktemp)"
  printf '{"available":%s,"behind":%s,"currentCommit":"%s","currentVersion":"%s","availableCommit":"%s","checkedAt":"%s"}\n' \
    "$AVAILABLE_BOOL" "$BEHIND" "$CURRENT" "$VERSION" "$AVAILABLE" "$NOW" > "$tmp"
  mkdir -p "$(dirname "$STATUS_FILE")"
  mv "$tmp" "$STATUS_FILE"
  chmod 644 "$STATUS_FILE"
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

# Success: we're now at the pulled commit; refresh status (behind=0).
CURRENT="$(git_as rev-parse HEAD)"
BEHIND=0
AVAILABLE_BOOL=false
write_status
echo "[update] applied and healthy at ${CURRENT:0:7}."
