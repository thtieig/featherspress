# Backup admin UI — design

Status: **approved-pending-review** · 2026-07-24

Let a signed-in `/admin` user **see and control scheduled backups** — status,
destination, retention (keep-last-N), schedule, and a "back up now" button —
**without granting the web application any new privilege**. The unprivileged app
never runs as root, never gets sudo, and never handles cloud credentials.

This spec covers the *feature*. The production rollout of the new engine to
gvm.tian.it and blog.tian.it is a separate runbook (see "Deployment", last
section) produced after the feature is built and rehearsed on the test VPS.

## Background: what exists today

- Backups are `deploy/backup.sh`, run as **root** by
  `featherspress-backup.timer` (systemd, not cron). It exports a `full` Site
  Package, age-encrypts it, ships it (`local` or `rclone`), prunes to
  `KEEP_LAST`.
- Config lives in `/etc/featherspress/backup.env` (root-owned, `0600`).
- The app already reads one root-written status file — `update-status.json` —
  and shows a read-only "update available" banner. This feature reuses that
  proven pattern.
- **Security model being preserved:** the engine runs as an unprivileged user
  with a read-only code dir; only root touches systemd and `/etc`. Nothing in
  this feature may erode that. (This session found bugs where the importer could
  `rm -rf` arbitrary dirs and where local backups leaked credentials — so the
  bar for "root consumes app-controlled input" is high.)

## Approach: root agent watching a request file (chosen)

The app writes a *desired-config* document into the data dir — the one place it
can already write. A **root-side agent validates it against a strict whitelist**,
applies it, and writes back a status file the UI polls. The app gains no
privilege; it can only *propose*.

Rejected alternatives: a narrow **sudoers** grant (puts root one web-app bug
away, permanently — unacceptable given this codebase's recent history) and a
**root socket daemon** (a permanently-running root parser exposed to the app —
more attack surface than a once-a-day feature warrants).

## Components

New root-side files (installed by the deploy, alongside the existing backup
units):

| File | Role |
|---|---|
| `deploy/backup-control.sh` | The agent: read request → validate → apply → refresh status. Runs as root, oneshot. |
| `deploy/backup-status.sh` | The single status writer (below). Runs as root. |
| `deploy/featherspress-backup-control.service` | Oneshot wrapper for the agent. |
| `deploy/featherspress-backup-control.path` | inotify watch on the request file → triggers the service. |
| `deploy/featherspress-backup-control.timer` | 2-minute safety net that also triggers the service (catches any missed inotify event). |

Two files in the data dir — the trust boundary:

- **`backup-request.json`** — written by the app, read by root. **Untrusted.**
- **`backup-status.json`** — written by root, read-only to the app (`0644`, no
  secrets). Same contract as `update-status.json`.

App-side:

- `admin/router.js`: `GET /admin/api/backup-status`, `POST /admin/api/backup-config`,
  `POST /admin/api/backup-run` — all behind the existing session auth gate,
  matching the current admin endpoints' request posture (no new auth/CSRF model).
- `admin/public/index.html` (+ its JS): a **Backups** panel.

## Data flow

```
/admin  ──POST config/run──▶  backup-request.json   (app user; atomic temp+rename; requestId = prev+1)
                                     │
              .path unit fires (ms)  │  + backup-control.timer every 2 min (safety net)
                                     ▼
                         backup-control.sh  (root)
                           • open request O_NOFOLLOW, size-capped (≤64 KB)
                           • parse JSON; VALIDATE every field (below)
                           • if requestId ≤ appliedRequestId: no-op (dedupe)
                           • write /etc/featherspress/backup.env
                           • write timer drop-in (OnCalendar built by root)
                           • systemctl daemon-reload; restart backup.timer
                           • if action=run-now: systemctl start backup.service
                           • backup-status.sh   (refresh status)
                           • re-read request; if requestId changed, loop once
                                     │
                                     ▼
                         backup-status.json  ──poll──▶  /admin renders result
```

The UI writes a request, then polls `backup-status.json` until
`appliedRequestId === sentRequestId`, then shows applied/error. Nothing blocks.

## The validator (deploy/backup-control.sh) — where the security lives

Root parses the request and accepts **only** the following, rejecting the whole
request (and recording a fixed-string error) on any violation:

| Field | Rule |
|---|---|
| `requestId` | integer, strictly greater than `appliedRequestId` |
| `action` | `apply` \| `run-now` |
| `destination.type` | `local` \| `rclone` |
| `destination.localDir` | absolute; resolves under `/var/backups/` (real path, no symlink escape, no `..`). Elsewhere = CLI-only in v1. |
| `destination.remote` | must **exactly equal** a name from `rclone listremotes` on this box. Arbitrary hosts never accepted. |
| `destination.remotePath` | `[A-Za-z0-9._/-]+`, no `..`, no leading `/` |
| `keepLast` | integer 1–365 (0 already refused by backup.sh) |
| `schedule.preset` | `hourly` \| `daily` \| `twice-daily` \| `weekly` |
| `schedule.timeOfDay` | `HH:MM`, 24h (ignored for `hourly`) |
| `schedule.weekday` | `Mon`…`Sun` (required for `weekly` only) |
| `encrypt` | read-only in v1: reflects whether `AGE_RECIPIENT` is set; not settable here |

Root builds the `OnCalendar=` string **itself** from `preset`+`timeOfDay`+
`weekday`; the app never supplies systemd calendar syntax.

Hardening (this is the same bug class the session kept surfacing):

- The request file is in an app-writable dir, so it could be swapped for a
  symlink. Root opens it **`O_NOFOLLOW`**, size-capped.
- Root **never echoes request contents** into the status file — errors are from
  a fixed enum — so a crafted symlink + verbose error can't become file-read.
- Root writes `backup-status.json` by **unlink-then-create** (never following
  whatever is at that path).
- `rclone` is switched to only if `AGE_RECIPIENT` is set (backup.sh already
  refuses off-box without it) — the validator rejects `type=rclone` with no
  recipient and tells the UI to configure encryption first.

## The status writer (deploy/backup-status.sh)

One script, invoked under **`flock`** by both `backup.sh` (after a run) and
`backup-control.sh` (after applying config), so the two never race. It emits
`backup-status.json`:

```json
{
  "schemaVersion": 1,
  "writtenAt": "2026-07-24T00:24:11Z",
  "appliedRequestId": 7,
  "lastRequestOk": true,
  "lastRequestError": null,
  "config": { "destType": "local", "localDir": "/var/backups/featherspress",
              "remote": null, "remotePath": null, "keepLast": 14,
              "schedule": { "preset": "daily", "timeOfDay": "00:24", "weekday": null } },
  "encrypted": true,
  "availableRemotes": ["mys3", "backblaze"],
  "lastRun": { "at": "2026-07-24T00:24:03Z", "ok": true, "error": null,
               "artifactBytes": 2412345 },
  "nextRun": "2026-07-25T00:24:00Z",
  "artifactCount": 3
}
```

- `lastRun` comes from a tiny `last-run.json` that `backup.sh` writes (ts, ok,
  error, size); the status writer merges it.
- `nextRun` from `systemctl show featherspress-backup.timer -p NextElapseUTC…`
  (absolute UTC — avoids the timezone-ambiguity trap).
- `availableRemotes` from `rclone listremotes` (names only).
- `encrypted` = `AGE_RECIPIENT` is set. The recipient value (a public key) is
  not published.
- A `writtenAt` heartbeat lets the UI treat a very stale file as "control not
  available".

## Bootstrap / initial state

The deploy installs a **default `backup.env`** (`DEST_TYPE=local`,
`LOCAL_DIR=/var/backups/featherspress`, `KEEP_LAST=14`, age recipient if a key
was set up), plus all units, and runs the status writer once. So the UI always
edits an existing config — never bootstraps from nothing.

## UI: the Backups panel

Reads `backup-status.json` (poll every few seconds while the panel is open).

```
┌─ Backups ────────────────────────────────────────┐
│ Status   ✓ Last run 24 Jul 00:24 · next 25 Jul   │
│          00:24 · 3 kept · encrypted (age)         │
│ Destination  ● Local   ○ Off-box (rclone)         │
│              [ remote ▾ ] path [ … ]              │
│ Keep last    [ 14 ] backups                       │
│ Schedule     [ Daily ▾ ] at [ 00:24 ]             │
│         [ Save changes ]   [ Back up now ]        │
└───────────────────────────────────────────────────┘
```

Progressive disclosure (as requested):

- **No rclone remotes** → the Off-box option is replaced by a short note:
  *"To enable off-box backups, run `rclone config` as root — the remotes appear
  here automatically."* Options appear the moment the box is configured; no
  redeploy.
- **Not encrypted** (`AGE_RECIPIENT` unset) → a one-line note on how to add an
  age key; off-box stays disabled until then.
- **Stale/absent status** → "Backups aren't configured on this server."

Save/Run-now: write request → poll → show applied or the fixed-string error.

## Error handling

- Validation failure → status `lastRequestOk:false` + fixed-string reason;
  no config change made.
- A run failure (bad remote, unreachable) → `flock` prevents overlap, prune
  never runs on failure (already proven), `lastRun.ok:false` with reason.
- Agent never trusts the request file (O_NOFOLLOW, size cap, whole-request
  reject).
- **Concurrency:** `backup.sh` takes an `flock` so a timer run and a run-now
  can't overlap; the second refuses cleanly. (This closes the lock gap noted
  earlier in the session — now required because the UI can trigger runs.)

## Testing

TDD. Nothing touches production until it passes on the test VPS
(`77.68.32.182`).

Unit (node --test):
- Validator: every field's accept/reject; unknown remote; `..`/absolute/symlink
  `localDir`; `keepLast` bounds; each `schedule.preset` → expected `OnCalendar`;
  `requestId` dedupe; oversized/symlinked request file rejected.
- Status writer: shape; merges `last-run.json`; `availableRemotes` names only;
  `encrypted` reflects `AGE_RECIPIENT`.
- Admin API: status shape; config round-trip; run-now; all require a session.

End-to-end on the test box:
- Change destination local→rclone from the UI (against the box's existing
  `rclone serve s3`/SFTP remotes) and confirm a real encrypted upload.
- Change retention and confirm pruning to the new N.
- Change schedule and confirm the timer's real `NextElapseUTC` moves.
- Run-now and see the result surface.
- Adversarial: a request with an unknown remote and one with a traversal
  `localDir` are both refused, the app gains nothing, no file outside
  `/var/backups` is touched.
- Concurrency: run-now during a scheduled run → one refuses, no corruption, no
  half-written artifact.

## Deployment (separate runbook, after the feature is proven)

Order the user set: build + rehearse on the test VPS, **then** production.
`main` is already merged/pushed at `e8ae422`.

**Facts verified on the boxes (2026-07-24):**

| | gvm.tian.it (77.68.66.109) | blog.tian.it (82.165.221.229) |
|---|---|---|
| On the new engine? | yes (migrated 2026-07-20) | **no — older engine** |
| Code dir | git-**archive** (no `.git`) | git-**archive** (no `.git`) |
| Service user | `featherspress` | `blogadmin` |
| Node | `/opt/node` (v24) | system `/usr/bin/node` (v22), `/usr/bin/npm` |
| `auth-config.json` | **644** (fix→600) | **644** (fix→600) |
| env file | **unquoted `SITE_TITLE` — breaks backup.sh** (fix) | already quoted, sources fine |
| Must preserve | site.json (homeMode feed, `pinnedPage: here-we-go`, heroImage); 2FA | site.json (`postsPath: /here-my-pages/`, homeMode page:welcome, nav/headings); 2FA; `OLD_UPLOADS_DIR` env |

**Both boxes** therefore need the archive→clone conversion (commit-pinned per
DEPLOY.md §3) before they can take the update or run the update/backup timers —
gvm is lower-risk (data already new-shape) but not a trivial `git pull`.

**Rules for both:**
1. **Pre-deploy raw backup** with system `tar` (engine-independent):
   `tar czf /root/<box>-predeploy-<date>.tar.gz /var/lib/featherspress /etc/featherspress`.
2. **Deploy CODE only.** Never touch `/var/lib/featherspress` except
   permissions. **Never run `setup.js` or `import` on production** — that is how
   2FA/settings would be lost.
3. `chmod 600 auth-config.json`; fix env quoting (gvm only).
4. Install backup + backup-control units; write a per-box `backup.env`
   (blog: `NODE_BIN=/usr/bin/node`, `FP_USER=blogadmin`; gvm: defaults) and
   `update.conf` (`REPO_REF=main`, per-box `FP_USER`).
5. Keep the old code dir moved-aside for rollback; verify the live site (home,
   a post, the posts path, media, admin login **with the preserved 2FA**) before
   declaring done.

blog additionally: "migrate locally properly first" = import blog's attic Site
Package onto the test box, run the new engine against it, verify `/here-my-pages/`
+ the welcome page + 209 posts render, before the production deploy.

## Out of scope (v1)

- Setting/rotating the age key from the UI (would put the private key through the
  web app). CLI-configured; UI only detects presence.
- Entering cloud credentials in the UI (remotes are pre-configured via
  `rclone config` as root; UI selects by name).
- Local destinations outside `/var/backups/` (CLI-only).
- Age-based or size-based retention (count-only, per decision).
- Restore from the UI (stays a deliberate CLI operation).
