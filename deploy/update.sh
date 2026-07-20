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

cd "$ENGINE_DIR"

git fetch --quiet origin "$REPO_REF"
CURRENT="$(git rev-parse HEAD)"
AVAILABLE="$(git rev-parse "origin/$REPO_REF")"
BEHIND="$(git rev-list --count "HEAD..origin/$REPO_REF")"
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

echo "[update] applying (rollback point: ${CURRENT:0:7})…"
git merge --ff-only "origin/$REPO_REF"
"$NPM_BIN" ci --omit=dev --prefix "$ENGINE_DIR"
chown -R "$FP_USER:$FP_USER" "$ENGINE_DIR"
systemctl restart "$SERVICE"

# Health-check the restarted service; roll back on failure.
ok=0
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "[update] health-check FAILED — rolling back to ${CURRENT:0:7}" >&2
  git reset --hard "$CURRENT"
  "$NPM_BIN" ci --omit=dev --prefix "$ENGINE_DIR" || true
  chown -R "$FP_USER:$FP_USER" "$ENGINE_DIR"
  systemctl restart "$SERVICE"
  # Refresh status to reflect that we're back on the previous commit.
  AVAILABLE_BOOL=true
  write_status
  exit 1
fi

# Success: we're now at the pulled commit; refresh status (behind=0).
CURRENT="$(git rev-parse HEAD)"
BEHIND=0
AVAILABLE_BOOL=false
write_status
echo "[update] applied and healthy at ${CURRENT:0:7}."
