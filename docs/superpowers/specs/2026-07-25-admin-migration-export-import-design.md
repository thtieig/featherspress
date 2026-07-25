# Design: /admin export, restore & migration (+ backup-panel bug fixes)

Date: 2026-07-25
Status: approved (design), not yet implemented
Supersedes nothing. Builds on `2026-07-24-backup-admin-ui-design.md`.

## Goal

One sentence: **spin up a naked VPS, install Featherspress, open `/admin`, upload
an archive, tick what to restore, press Restore — and the site comes back.**

The user's framing, which drives every decision below: *"exactly like restoring a
router."* A router hands you one config file, takes it back, lets you choose what
to apply, and reboots. Nothing in this design should require SSH for the normal
path.

Secondary goal, equally binding: **consolidate**. The scheduled backup, the
manual export, the restore, and the WordPress converter must share one artifact
format and one code path. No parallel implementations.

## What already exists (do not rebuild)

There is already one artifact format with three producers and one consumer:

```
converter/wp_to_package.py  ──┐
                              │
tools/site-package.js export ─┼──> Site Package ──> tools/site-package.js import
   (profiles: site / full)    │   site.json
                              │   content/posts|pages/
deploy/backup.sh ─────────────┘   media/  skins/<name>/  favicon/
   (= export --profile full,       auth-config.json (full only)
      + age, + ship, + prune)
```

`wp_to_package.py` already writes exactly `site.json` + `content/posts|pages/*.md`
+ `media/YYYY/MM/`, and `importPackage`'s `resolveSource()` already accepts a
directory **or** a `.tar.gz`. The converter and the backup system are already the
same format. This design must not fork it.

The engine (`tools/site-package.js`) has survived three review passes and 25 real
bug fixes, including the `rm -rf` via an untrusted `manifest.skin`. Treat its
hardening as load-bearing: `assertSafeTar`, `assertNoEscapingLinks`, the skin-name
whitelist, `lchownSync`, `assertNotEngineDir`, the pre-restore snapshot.

## The five gaps

1. The converter emits a directory, not a `.tar.gz` — not uploadable via a browser
   file picker.
2. Nothing carries **server settings** (backup destination, retention, schedule,
   `AGE_RECIPIENT`, `AUTO_APPLY`, `REPO_REF`), so "restore onto a fresh VPS and
   it's configured like before" is unreachable.
3. **Import cannot be driven from `/admin`.** The app is unprivileged: it cannot
   write `/etc/featherspress/`, cannot `systemctl restart`, and a root-run restore
   needs the ownership hand-back.
4. `importPackage` is all-or-nothing — no selective restore.
5. Uploads cap at 25 MB, held in RAM (`multer.memoryStorage()`).

---

## Section 1 — Sections

Five sections. These are the unit of export, of selective import, **and** of the
scheduled backup's scope.

| Section | Contents | Carries secrets |
|---|---|---|
| `content` | `content/posts/`, `content/pages/` | no |
| `media` | `media/` | no |
| `site` | `site.json` + `skins/<name>/` + `favicon/` | no |
| `settings` | `settings.json` | no (public key only) |
| `credentials` | `auth-config.json` (password hash + TOTP secret) | **yes** |

`site.json` ships together with the skin and favicon **deliberately**: the
manifest *names* the skin, so splitting them permits a restored manifest pointing
at a skin that was not restored — which, per finding #10 below, takes the service
down at boot. Keeping them one section makes that state unreachable.

Restoring `content` without `media` leaves image references dangling. That is
degraded but coherent, and a legitimate choice (you may already have the media).
Warn in the UI; do not block.

### `settings.json`

Portable site decisions only. Box-specific facts are **structurally excluded** —
see Section 3 for why that is free rather than a rule someone must remember.

```json
{
  "schemaVersion": 1,
  "backup": {
    "destType": "local",
    "localDir": "/var/backups/featherspress",
    "remote": null,
    "remotePath": null,
    "keepLast": 14,
    "schedule": { "preset": "daily", "timeOfDay": "00:24", "weekday": null },
    "sections": ["content", "media", "site", "settings", "credentials"],
    "ageRecipient": "age1..."
  },
  "update": { "autoApply": false, "repoRef": "main" }
}
```

Never in `settings.json`: `CONTENT_DIR`, `MEDIA_DIR`, `AUTH_CONFIG`, `NODE_BIN`,
`NPM_BIN`, `FP_USER`, `HOST`, `PORT`, `SESSION_SECRET`, rclone credentials.
`ageRecipient` is a **public** key and is safe to travel; the private half is
never on the box by design.

## Section 2 — Export presets

Three presets over those sections, plus custom:

- **Migrate this site** — all five sections. The fresh-VPS artifact. Encryption
  forced (carries `credentials`).
- **Portable site** — `content` + `media` + `site`. Shareable, no secrets,
  encryption optional. Equivalent to today's `site` profile.
- **Custom** — tick your own. Encryption flips from optional to **mandatory** the
  moment `credentials` is ticked.

CLI keeps `--profile site|full`; `full` grows to include `settings`, which is
what disaster recovery wanted all along. A new `--sections a,b,c` flag expresses
the general case, and `--profile` is sugar over it.

Backward compatibility is free: sections are present-or-absent directories, and
the import path already guards every optional one with `existsSync`. Artifacts
already stored on gvm and blog simply lack `settings/` and stay importable.

## Section 3 — Restore architecture

**The web app does not run the import.** It stages and requests; root validates
and acts. This is the same protocol the Backups panel already uses.

```
browser ──upload──> app stages artifact (0600, data dir)
                    app decrypts here if encrypted, piping the uploaded
                    identity to `age -d -i /dev/stdin` ── key never hits disk
                         │
                         └─ writes restore-request.json  {sections, stagedPath}
                                    │  .path unit (+ 2-min safety timer)
                                    ▼
                    root agent (tools/backup-control.js restore):
                      1. validate request (whitelist, O_NOFOLLOW, staged path
                         must resolve inside the data dir)
                      2. pre-restore snapshot of current data (already exists)
                      3. site-package import --sections …
                      4. settings through the SAME validateRequest()
                      5. systemctl restart featherspress
                      6. HEALTH CHECK: /healthz AND / render  (see finding #10)
                      7. on failure → roll back to the snapshot, restart, report
                      8. delete staged artifact + request file
                      9. status: restoring → restarting → done | rolled-back
```

**Why the app must not do it:** the alternative needs `sudo` rules or a setuid
helper, hands the web app a path to `/etc` and `systemctl`, and duplicates
validation. More code, strictly more privilege, same result.

**The settings-portability payoff.** `validateRequest()` already whitelists
exactly `destType / localDir / remote / remotePath / keepLast / schedule` and
rejects everything else, with adversarial cases (traversal, unknown remote,
out-of-range, symlinked request) already verified on a real box. Feeding a
restored `settings.json` through it means box-specific facts **cannot** travel —
not because a rule forbids it, but because the whitelist has no field for them.
One validator, one set of tests, one threat model.

Consequences to honour:
- An archive naming an rclone remote the new box lacks: `validateRequest` rejects
  that field. Apply what validates, skip what doesn't, and **report exactly what
  was skipped**. Do not fail the whole restore over it.
- `sections` gains a whitelist entry in `validateRequest` (backup scope is now
  GUI-configurable — see Section 5).

**Decryption happens in the app, not root**, so the uploaded identity can be
piped straight into `age -d -i /dev/stdin` and never written to a file. Cost: a
plaintext artifact briefly exists in the data dir at 0600, app-owned, deleted by
root as soon as it is consumed. That is the accepted, stated trade.

## Section 4 — Encryption

**Key-based both ways. Passphrase mode was investigated and rejected: it is not
implementable.** Verified on the boxes (age 1.1.1):

```
$ printf 's3cret\ns3cret\n' | age -p -o out.age in.txt
age: error: could not read passphrase: standard input is not a terminal,
     and /dev/tty is not available
```

`age -p` opens `/dev/tty` unconditionally and there is no `--passphrase-file` in
1.1.1, so a web app cannot drive it. Driving it under a pty (`script -qec …`) was
considered and rejected as fragile for a path whose failure mode is an
undecryptable backup.

The key-based design is also more coherent with the "generate the key from the
UI, show it once" flow already chosen:

- **Encrypt** (`age -r <AGE_RECIPIENT>`) — non-interactive, identical to the
  nightly backup. Used for `/admin` export and the scheduled backup alike.
- **Decrypt** (`age -d -i <identity>`) — the operator uploads or pastes the
  private key they saved when they set up encryption.

The private key **never touches disk on restore**: verified that the identity can
be piped, so the app runs `age -d -i /dev/stdin` and writes the key only to the
child process's stdin.

```
$ cat key.txt | age -d -i /dev/stdin -o out.txt cipher.age    # verified working
$ age -d -i wrong.txt cipher.age
age: error: no identity matched any of the recipients          # fails cleanly
```

So the key the "Set up encryption" screen shows you once is exactly the file you
upload to restore. One key, one story, and the existing attic keys and documented
recovery drill keep working unchanged.

Encryption is **optional in general, mandatory when the archive carries
`credentials`** — the rule the user asked for. `settings` alone carries only a
public key, so it does not force encryption. Note `age` writes its output 0644;
a credentials-bearing artifact must be created/chmod'd 0600 by the app, the same
discipline `exportPackage` already applies on the `full` profile.

**Consequence for export on a box with no key yet:** encryption requires an
`AGE_RECIPIENT`. Exporting a `credentials`-bearing archive from a box that has
never set up encryption must therefore direct the operator to "Set up encryption"
first, rather than silently producing a plaintext archive containing the TOTP
secret.

## Section 4b — "Set up encryption" (age key generation from /admin)

The v1 spec deliberately kept the age private key out of the web app. The user's
decision (2026-07-25) is to generate it from `/admin`, **show it once, and never
store the private half**.

Flow, through the existing request/status protocol — the app never generates or
holds the key:

1. Operator presses "Set up encryption". App writes a request with
   `action: "keygen"`.
2. Root agent refuses if `AGE_RECIPIENT` is already set (never silently rotate a
   key that existing backups are encrypted to; require an explicit "replace" flag
   with its own warning).
3. Root runs `age-keygen`, writes the **public** half into `backup.env` as
   `AGE_RECIPIENT`, and writes the **private** half to a one-shot file in the data
   dir, 0600, owned by the app user.
4. App reads that file exactly once, returns it in the HTTP response, and unlinks
   it immediately. The UI shows it with "this is the ONLY copy — save it now" and
   a download button.
5. Status reports `encrypted: true` from then on; the private half exists nowhere
   on the box.

**Stated exposure:** an `/admin` compromise *during that one display* captures the
key. The operator accepted this trade for the convenience, and it is a
single-authenticated-operator tool. Everything else about the key is unchanged —
it is the same file the recovery drill in `docs/BACKUP-IMPORT-EXPORT.md` uses, and
the same file that gets uploaded to decrypt a restore.

## Section 5 — Scheduled-backup scope in the GUI

The nightly backup's scope becomes selectable from the same five sections
(user's explicit request). This closes the long-standing "different sets of what
to backup" question with a concrete use case: choosing what the *nightly*
captures, not partial disaster recovery.

- `backup-request.json` gains `sections`.
- `validateRequest` whitelists it (each entry must be one of the five).
- `backup.env` gains `BACKUP_SECTIONS=content,media,site,settings,credentials`.
- `backup.sh` passes `--sections "$BACKUP_SECTIONS"` to the exporter.
- `backup-status.json` reports it so the form round-trips.

**Safety rail:** a scheduled scope omitting `content` or `credentials` cannot
fully restore the site. Warn plainly in the panel ("this scheduled backup will
not be able to fully restore your site"). Warn, do not block — it is the
operator's call.

## Section 6 — UI

One **"Backup & Restore"** tab, replacing "Backups" (the router model — configure,
export, restore, all in one place):

```
Scheduled backup
  Destination  (o) Local  ( ) Off-box
  What to back up  [x] content [x] media [x] site [x] settings [x] credentials
  Keep last    [14] backups
  Schedule     [Daily v] at [00:24]
  [Save changes]  [Back up now]

Export
  (o) Migrate this site  (all sections)
  ( ) Portable site      (no secrets)
  ( ) Custom...
  [x] Encrypt (age)   — forced on, this archive contains credentials
  [Download archive]

Restore
  [Choose file...]
  Encrypted? paste or upload your age private key [__________]
  Restore: [x] content [x] media [x] site [ ] settings [ ] credentials
  [Restore]
```

The "Set up encryption" control lives in the Scheduled backup block: it asks the
root agent to run `age-keygen`, keeps the public half in `backup.env`, and shows
the private half **once** with a "this is the only copy — save it now" warning.

"Back up now" and "Download archive" are the same engine differing only in
destination — that is the consolidation made visible.

## Section 7 — Uploads

`multer.memoryStorage()` → `diskStorage` streaming into a staging dir inside the
data dir. Cap raised to 2 GB (configurable via `MAX_IMPORT_BYTES`), with a
free-disk check before accepting the upload. Current sizes: gvm 1.2 MB media,
blog 17 MB; boxes have 33–47 GB free. The 25 MB media-upload limit is unchanged —
this is a separate, import-only limit.

## Section 8 — Converter

`wp_to_package.py` gains `--tar` to emit `<out>.tar.gz` alongside (or instead of)
the directory. Format unchanged. This is the only change needed to make a
WordPress conversion directly uploadable through `/admin`, and it keeps the
converter's output and the backup artifact literally the same thing.

## Section 9 — Bootstrap on a fresh box

Two things that will read as failures if not signposted:

1. **You still need `setup.js` for a first login** before `/admin` exists to
   import into. DEPLOY.md gains a "migrate from an archive" variant of its
   bootstrap: install → `setup.js` → log in → Restore → log in again.
2. **Restoring `credentials` swaps your login to the old site's** password and
   authenticator, mid-restore. You are signed out and must log back in with the
   *old* box's credentials and 2FA device. Correct for a migration, but it looks
   exactly like a lockout. The UI must say so bluntly before the restore runs,
   and the restore-complete screen must repeat it.

## Section 10 — Bug fixes folded into this work

Found in the 2026-07-25 scan. #2 and #3 are load-bearing for this feature, not
separate cleanup: the settings export reads its values from `backup-status.json`,
which today does not carry a structured schedule at all.

| # | Severity | Defect |
|---|---|---|
| 1 | high | **"Back up now" silently reschedules the timer.** `router.js:214` builds the run-now schedule from `status.config.schedule`, which root only ever writes as `{raw}` (`backup-control.js:253`), so `.preset` is always undefined and it falls back to a hardcoded daily 00:24 — and `applyRequest` rewrites the drop-in for *every* valid request (`backup-control.js:294`). Reproduced: a site on `Sun *-*-* 03:00:00` becomes `*-*-* 00:24:00`. |
| 2 | high | **The panel never shows or restores the configured schedule**, so a plain Save resets it too. `renderBackupStatus` (`index.html:1008-1013`) repopulates every field *except* preset/time/weekday, because status carries no structured schedule. Form defaults are Daily 00:24. |
| 3 | medium | **`nextRun` is permanently null in production** (verified on both boxes). Status is only ever refreshed from inside `backup.sh`'s `record_run`, i.e. while the backup service is active and systemd reports no next elapse, because the 2-minute safety timer runs `apply`, which returns early without refreshing when no request file exists (`backup-control.js:270-276`). A standalone probe returns the value correctly. |
| 4 | low | No explicit `sameSite` on the admin session cookie (`router.js:74-79`). Every state-changing endpoint is a JSON POST with no CSRF token; protection rests entirely on the browser's Lax default. Fix before adding a destructive import endpoint. |
| 5 | low | `writeBackupRequest` doesn't chmod after write (`router.js:178-182`) — `writeFileSync`'s `mode` is ignored on an existing `.tmp`. Same pattern already fixed in `writeAuthConfigAtomic`. |
| 6 | low | `backup.sh:25-29` — if `exec 9>…` fails, `flock` fails on a bad fd and the script reports "another backup is already running" and **exits 0**. Fail-silent-success. |
| 7 | medium (dormant) | `update.sh` half-applies with no rollback: `npm ci` failure is handled (`:137-141`) but `chown -R "$FP_USER"` (`:142`) and `systemctl restart` (`:143`) are not — `set -e` aborts and `rollback()` never runs. On blog (app user `blogadmin`) a missing `FP_USER` makes that chown fail. Dormant only because `AUTO_APPLY=0`. |
| 8 | low | `update.sh` `FP_USER` (`:17`) and derived `REPO_OWNER` (`:41`) can silently disagree; everything runs as `REPO_OWNER` but the chown uses `FP_USER`. Default `FP_USER` to `REPO_OWNER`. |
| 9 | cleanup | `search.js:82` dead ternary `inBody ? term : inTitle ? term : term`. |
| 10 | **design input** | `manifest.load()` rethrows on malformed `site.json` (`manifest.js:85`), and manifest + skin load at module scope (`server.js:21-23`). A restore writing a bad `site.json`, or naming an absent skin, kills the service at restart. **The restore agent must health-check and roll back**, exactly as `update.sh` does. Reflected in Section 3, steps 6–7. |

## Testing

Unit / integration (in-repo, `node --test`):
- Section selection matrix for export and import (each section present/absent).
- `settings.json` round-trip through `validateRequest`, including an archive
  naming an unknown rclone remote → that field skipped, rest applied, reported.
- Backward compatibility: an artifact with no `settings/` still imports.
- Regression tests for bugs #1 and #2 — the reproduction already written proves
  the current failure and becomes the guard.
- Converter `--tar` output imports cleanly (closes the format loop end-to-end).
- `assertSafeTar` / `assertNoEscapingLinks` still reject the known-bad packages.
- age round-trip: encrypt to a recipient, decrypt with the identity piped via
  `/dev/stdin`, and confirm a wrong identity fails rather than yielding garbage.
- A `credentials`-bearing export on a box with no `AGE_RECIPIENT` is refused, not
  silently written in plaintext.

On real hardware (`test-feathers`, 77.68.32.182, 112 GB free):
- **The drill that matters:** bare box → install → `setup.js` → upload a
  "Migrate this site" archive taken from gvm → tick all sections → Restore →
  site serves gvm's content, with gvm's login and 2FA, and the backup schedule
  restored. Verify with a real screenshot, not an HTTP 200.
- Failure paths: malformed `site.json` and an absent skin must both roll back and
  leave the site serving.
- A restore of an old (pre-`settings`) artifact.

**Not on production.** Restore's whole job is to overwrite a live site; it is
proven on `test-feathers` only. gvm and blog get the code, a verified panel, and
a verified *export*.

## Rollout

Per the user's decision, in two passes:

1. **Pass 1 → production tonight:** bug fixes #1–#9 plus the export/download side.
   Both low-risk and immediately useful; backups keep working throughout. This
   also stops the schedule-reset bug, which fires the first time the panel is
   touched (`appliedRequestId` is still 0 on both boxes, so it has not fired yet).
2. **Pass 2 → production once proven:** the restore path, after it survives the
   full fresh-VPS drill on `test-feathers`.

## Out of scope

- Restoring rclone *credentials* (`rclone.conf`). Cloud secrets stay a deliberate
  `rclone config` step over SSH; the archive carries the remote's **name** only.
- Restoring `SESSION_SECRET`. A fresh one costs one re-login and avoids carrying
  a secret between boxes.
- Apache vhosts and systemd units — deploy artifacts, covered by DEPLOY.md.
- Finer-grained scopes than the five sections (e.g. posts-only). The five cover
  the stated use cases; revisit only with a concrete need.
