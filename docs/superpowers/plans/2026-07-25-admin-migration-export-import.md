# /admin Export, Restore & Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator spin up a naked VPS, install Featherspress, open `/admin`, upload an archive, tick what to restore, and get their site back — while consolidating the scheduled backup, manual export, restore, and WordPress converter onto one artifact format and one code path.

**Architecture:** Five sections (`content`, `media`, `site`, `settings`, `credentials`) become the shared unit of export, selective import, and the scheduled backup's scope. The unprivileged web app stages and *requests*; the existing root agent (`tools/backup-control.js`) validates and acts, reusing its `validateRequest()` whitelist so box-specific facts structurally cannot travel to a new box. Restore borrows `update.sh`'s health-check-and-rollback discipline.

**Tech Stack:** Node 20+ CommonJS, Express 5, `node --test`, systemd (`.path` + `.timer` units), `tar`, `age` 1.1.1, Python 3 (converter).

**Spec:** `docs/superpowers/specs/2026-07-25-admin-migration-export-import-design.md`

## Global Constraints

- **Never break the existing artifact format.** `converter/wp_to_package.py`, `tools/site-package.js`, and `deploy/backup.sh` already share it. Old artifacts (no `settings/`) must stay importable.
- **The app never gains privilege.** No `sudo`, no setuid, no writes to `/etc`, no `systemctl` from `admin/router.js`. Anything privileged goes through a request file that root validates.
- **Validator errors are fixed strings** — never echo untrusted input back (`tools/backup-control.js` `fail()`).
- **Credential-bearing files are 0600, and chmod'd explicitly** after write (`writeFileSync`'s `mode` is ignored on an existing file — this bug has already been fixed twice in this codebase).
- Section names, exactly: `content`, `media`, `site`, `settings`, `credentials`.
- Schedule presets, exactly: `hourly`, `daily`, `twice-daily`, `weekly`. Weekdays: `Mon`–`Sun`.
- `keepLast` range: 1–365. Local backup dir must resolve under `/var/backups`.
- Node on gvm/test-feathers is `/opt/node/bin/node`; on blog it is `/usr/bin/node`. Never hardcode.
- **Never `pkill -f server.js` on a production box** — it kills the live site. Kill temp-boot processes by captured PID only.
- Run the full suite with `npm test` (currently 108 passing). It must stay green at every commit.

---

## Pass 1 — Bug fixes + export (ships to production)

### Task 1: Persist the schedule structurally, so status can report it

**Root cause of bugs #1 and #2:** the applied schedule exists only as an `OnCalendar` string in a systemd drop-in, so nothing can report `preset`/`timeOfDay`/`weekday` back to the UI. Store it in `backup.env` (root-owned, already the config store, already preserved by `renderBackupEnv`) rather than reverse-parsing the drop-in.

**Files:**
- Modify: `tools/backup-control.js` (`renderBackupEnv`, `refreshStatus`)
- Test: `test/backup-control.test.js`

**Interfaces:**
- Produces: `renderBackupEnv(config, prev)` additionally emits `BACKUP_SCHEDULE_PRESET`, `BACKUP_SCHEDULE_TIME`, `BACKUP_SCHEDULE_WEEKDAY`.
- Produces: `refreshStatus` writes `config.schedule = { preset, timeOfDay, weekday, raw }`.

- [ ] **Step 1: Write the failing test**

```js
test("renderBackupEnv persists the schedule structurally", () => {
  const config = {
    destType: "local", localDir: "/var/backups/featherspress", keepLast: 14,
    schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" },
  };
  const out = bc.renderBackupEnv(config, {});
  assert.match(out, /^BACKUP_SCHEDULE_PRESET=weekly$/m);
  assert.match(out, /^BACKUP_SCHEDULE_TIME=03:00$/m);
  assert.match(out, /^BACKUP_SCHEDULE_WEEKDAY=Sun$/m);
  assert.match(out, /^KEEP_LAST=14$/m);
});

test("the rendered env round-trips through parseEnvFile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-env-"));
  const file = path.join(dir, "backup.env");
  fs.writeFileSync(file, bc.renderBackupEnv({
    destType: "local", localDir: "/var/backups/featherspress", keepLast: 14,
    schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" },
  }, {}));
  const parsed = bc.parseEnvFile(file);
  assert.strictEqual(parsed.BACKUP_SCHEDULE_PRESET, "weekly");
  assert.strictEqual(parsed.BACKUP_SCHEDULE_TIME, "03:00");
  assert.strictEqual(parsed.BACKUP_SCHEDULE_WEEKDAY, "Sun");
});

test("renderBackupEnv omits the weekday when the preset is not weekly", () => {
  const out = bc.renderBackupEnv(
    { destType: "local", localDir: "/var/backups/x", keepLast: 5,
      schedule: { preset: "daily", timeOfDay: "00:24", weekday: null } }, {});
  assert.match(out, /^BACKUP_SCHEDULE_PRESET=daily$/m);
  assert.doesNotMatch(out, /BACKUP_SCHEDULE_WEEKDAY/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test 2>&1 | grep -A5 "persists the schedule"`
Expected: FAIL — no `BACKUP_SCHEDULE_PRESET` in the output.

- [ ] **Step 3: Implement in `renderBackupEnv`**

Insert after the `KEEP_LAST` line, before the `prev.*` preservation block:

```js
  lines.push(`BACKUP_SCHEDULE_PRESET=${config.schedule.preset}`);
  lines.push(`BACKUP_SCHEDULE_TIME=${config.schedule.timeOfDay}`);
  if (config.schedule.preset === "weekly" && config.schedule.weekday) {
    lines.push(`BACKUP_SCHEDULE_WEEKDAY=${config.schedule.weekday}`);
  }
```

- [ ] **Step 4: Report it back in `refreshStatus`**

Replace the `schedule: { raw: readScheduleDropIn(env.SCHEDULE_DROPIN) }` line in the `cfg` object with:

```js
    schedule: {
      preset: conf.BACKUP_SCHEDULE_PRESET || null,
      timeOfDay: conf.BACKUP_SCHEDULE_TIME || "00:24",
      weekday: conf.BACKUP_SCHEDULE_WEEKDAY || null,
      raw: readScheduleDropIn(env.SCHEDULE_DROPIN),
    },
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green, including the two new tests.

- [ ] **Step 6: Commit**

```bash
git add tools/backup-control.js test/backup-control.test.js
git commit -m "fix(backup): persist the schedule structurally so status can report it

The applied schedule existed only as an OnCalendar string in a systemd drop-in,
so nothing could report preset/timeOfDay/weekday back to the panel. That is the
root cause of both the run-now reschedule and the form never restoring."
```

---

### Task 2: Stop "Back up now" and "Save" from resetting the schedule

Bugs #1 and #2. Three defences: the agent must not rewrite the drop-in for a `run-now`; the router must send the real schedule; the UI must populate the form from status.

**Files:**
- Modify: `tools/backup-control.js:294-297` (`applyRequest`)
- Modify: `admin/router.js:197-218` (`/api/backup-run`)
- Modify: `admin/public/index.html` (`renderBackupStatus`)
- Test: `test/backup-control.test.js`, `test/admin.test.js`

**Interfaces:**
- Consumes: `status.config.schedule.{preset,timeOfDay,weekday}` from Task 1.

- [ ] **Step 1: Write the failing test (agent side)**

Add to `test/backup-control.test.js`:

```js
test("a run-now request does not rewrite the schedule drop-in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bc-"));
  const env = {
    BACKUP_ENV: path.join(dir, "backup.env"),
    BACKUP_REQUEST: path.join(dir, "backup-request.json"),
    BACKUP_STATUS: path.join(dir, "backup-status.json"),
    LAST_RUN_FILE: path.join(dir, "last-run.json"),
    SCHEDULE_DROPIN: path.join(dir, "dropin", "schedule.conf"),
  };
  fs.mkdirSync(path.dirname(env.SCHEDULE_DROPIN), { recursive: true });
  fs.writeFileSync(env.SCHEDULE_DROPIN, "[Timer]\nOnCalendar=\nOnCalendar=Sun *-*-* 03:00:00\n");
  fs.writeFileSync(env.BACKUP_ENV,
    "DEST_TYPE=local\nLOCAL_DIR=/var/backups/featherspress\nKEEP_LAST=14\n" +
    "BACKUP_SCHEDULE_PRESET=weekly\nBACKUP_SCHEDULE_TIME=03:00\nBACKUP_SCHEDULE_WEEKDAY=Sun\n");
  fs.writeFileSync(env.BACKUP_REQUEST, JSON.stringify({
    requestId: 99, action: "run-now",
    destination: { type: "local", localDir: "/var/backups/featherspress" },
    keepLast: 14, schedule: { preset: "daily", timeOfDay: "00:24" },
  }));
  bc.applyRequest(env);
  assert.match(fs.readFileSync(env.SCHEDULE_DROPIN, "utf8"), /Sun \*-\*-\* 03:00:00/,
    "run-now must leave the configured schedule alone");
});
```

Export `applyRequest` from `tools/backup-control.js`'s `module.exports` so the test can call it.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test 2>&1 | grep -A8 "does not rewrite"`
Expected: FAIL — drop-in now reads `*-*-* 00:24:00`.

- [ ] **Step 3: Guard the drop-in write in `applyRequest`**

Wrap the `SCHEDULE_DROPIN` write and the timer restart:

```js
  // "Back up now" must never change WHEN backups run. Only an explicit
  // apply rewrites the timer.
  if (v.config.action === "apply") {
    fs.mkdirSync(path.dirname(env.SCHEDULE_DROPIN), { recursive: true });
    fs.writeFileSync(
      env.SCHEDULE_DROPIN,
      `[Timer]\nOnCalendar=\nOnCalendar=${buildOnCalendar(v.config.schedule)}\n`
    );
    try {
      execFileSync("systemctl", ["daemon-reload"]);
      execFileSync("systemctl", ["restart", "featherspress-backup.timer"]);
    } catch {}
  }
```

- [ ] **Step 4: Send the real schedule from the router**

In `admin/router.js`, replace the `schedule:` field of the `/api/backup-run` request body with:

```js
    schedule:
      cur.schedule && cur.schedule.preset
        ? {
            preset: cur.schedule.preset,
            timeOfDay: cur.schedule.timeOfDay || "00:24",
            weekday: cur.schedule.weekday || null,
          }
        : { preset: "daily", timeOfDay: "00:24", weekday: null },
```

- [ ] **Step 5: Populate the form from status in the UI**

In `admin/public/index.html`, inside `renderBackupStatus`, after the `keepLast` line:

```js
    var sch = c.schedule || {};
    if (sch.preset) {
      el('bk-preset').value = sch.preset;
      if (sch.timeOfDay) el('bk-time').value = sch.timeOfDay;
      if (sch.weekday) el('bk-weekday').value = sch.weekday;
    }
```

Also add the schedule to the status line so it is visible at a glance — after the `artifactCount` push:

```js
    if (sch.preset) {
      parts.push('schedule: ' + sch.preset + (sch.preset === 'hourly' ? '' :
        ' ' + (sch.weekday ? sch.weekday + ' ' : '') + (sch.timeOfDay || '')));
    }
```

- [ ] **Step 6: Port the reproduction into the suite**

Copy the working reproduction from this session into `test/backup-schedule-preserve.test.js` (it drives `/api/backup-run` over HTTP against a seeded status file and asserts the resulting request still describes `Sun *-*-* 03:00:00`). Model the login/bootstrap on `test/admin.test.js`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: green, with the previously-failing reproduction now passing.

- [ ] **Step 8: Commit**

```bash
git add tools/backup-control.js admin/router.js admin/public/index.html test/
git commit -m "fix(backup): stop Back up now and Save from resetting the schedule

Back up now sent a hardcoded daily 00:24 because status carried no structured
schedule, and the agent rewrote the timer drop-in for every valid request. The
panel also never repopulated preset/time/weekday, so a plain Save reverted a
weekly schedule to the form default. Reproduced, now covered by a test."
```

---

### Task 3: Refresh status on the safety timer, so `nextRun` is never stale

Bug #3. `applyRequest` returns early when there is no request file, so `backup-status.json` is only ever written from inside `backup.sh` — while the backup service is active and systemd reports no next elapse. Verified: a standalone `status` run returns the value correctly.

**Files:**
- Modify: `tools/backup-control.js` (`applyRequest`)
- Test: `test/backup-control.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("apply refreshes status even when there is no pending request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bc-norq-"));
  const env = {
    BACKUP_ENV: path.join(dir, "backup.env"),
    BACKUP_REQUEST: path.join(dir, "nope.json"),      // deliberately absent
    BACKUP_STATUS: path.join(dir, "backup-status.json"),
    LAST_RUN_FILE: path.join(dir, "last-run.json"),
    SCHEDULE_DROPIN: path.join(dir, "schedule.conf"),
  };
  fs.writeFileSync(env.BACKUP_ENV, "DEST_TYPE=local\nLOCAL_DIR=/var/backups/x\nKEEP_LAST=7\n");
  bc.applyRequest(env);
  const status = JSON.parse(fs.readFileSync(env.BACKUP_STATUS, "utf8"));
  assert.strictEqual(status.config.keepLast, 7);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test 2>&1 | grep -A6 "no pending request"`
Expected: FAIL — `ENOENT`, the status file was never written.

- [ ] **Step 3: Implement**

In `applyRequest`, change the early return:

```js
  let request;
  try {
    request = readRequestNoFollow(env.BACKUP_REQUEST);
  } catch {
    // No/invalid/symlinked request: nothing to apply — but still refresh, or
    // the panel's nextRun/artifactCount only ever update during a backup run
    // (when systemd reports no next elapse at all).
    refreshStatus(env);
    return;
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add tools/backup-control.js test/backup-control.test.js
git commit -m "fix(backup): refresh status on the safety timer, not only during a run

backup-status.json was only ever written from inside backup.sh, i.e. while the
backup service was active and systemd reports no next elapse — so nextRun was
permanently null on both production boxes, and artifactCount/availableRemotes
only updated after a backup ran."
```

---

### Task 4: Hardening batch (bugs #4, #5, #6, #8, #9)

Five small, independent fixes. One commit, because none of them warrants its own review gate and they share a theme.

**Files:**
- Modify: `admin/router.js:74-79` (cookie), `admin/router.js:178-182` (`writeBackupRequest`)
- Modify: `deploy/backup.sh:25-29` (lock)
- Modify: `deploy/update.sh:17` (`FP_USER`)
- Modify: `src/search.js:82` (dead ternary)
- Test: `test/admin.test.js`

- [ ] **Step 1: Write the failing test for the cookie**

```js
test("the session cookie declares SameSite", async () => {
  const res = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, code: RECOVERY2 }),
  });
  const set = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).join(";");
  assert.match(set, /SameSite=Strict/i);
});
```

Seed a second recovery code (`RECOVERY2`) in that file's auth-config so this test does not consume the one the other tests use.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test 2>&1 | grep -A5 "declares SameSite"`
Expected: FAIL — no `SameSite` in the `Set-Cookie` header.

- [ ] **Step 3: Apply all five fixes**

`admin/router.js`, session cookie — add to the `cookie` object:

```js
      // Every state-changing endpoint is a JSON POST with no CSRF token, so do
      // not leave cross-site protection resting on the browser's Lax default.
      sameSite: "strict",
```

`admin/router.js`, `writeBackupRequest` — chmod explicitly, as `writeAuthConfigAtomic` already does:

```js
function writeBackupRequest(obj) {
  const tmp = config.BACKUP_REQUEST_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // mode is ignored when the tmp file already exists
  fs.renameSync(tmp, config.BACKUP_REQUEST_FILE);
}
```

`deploy/backup.sh` — distinguish "cannot lock" from "already running":

```bash
if ! exec 9>"/run/featherspress-backup.lock"; then
  echo "[backup] refusing: cannot open the lock file /run/featherspress-backup.lock" >&2
  exit 1
fi
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  echo "[backup] another backup is already running; skipping this run" >&2
  exit 0
fi
```

`deploy/update.sh` — default `FP_USER` to the repo owner so they cannot drift. Move the assignment below the `REPO_OWNER` computation and change it to:

```bash
# Default to whoever actually owns the code dir: everything else runs as
# REPO_OWNER, and a divergent FP_USER makes the chown below fail (or hand the
# repo to the wrong user) on any box whose app user is not "featherspress".
FP_USER="${FP_USER:-$REPO_OWNER}"
```

`src/search.js:82` — replace the dead ternary with `term`:

```js
      excerpt: excerptFor(excerptSource, term),
```

- [ ] **Step 4: Verify the shell scripts still parse**

Run: `bash -n deploy/backup.sh && bash -n deploy/update.sh && echo "syntax OK"`
Expected: `syntax OK`

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add admin/router.js deploy/backup.sh deploy/update.sh src/search.js test/admin.test.js
git commit -m "harden: SameSite cookie, request chmod, lock fail-closed, FP_USER default

- admin session cookie now declares SameSite=Strict rather than relying on the
  browser default, ahead of adding a destructive import endpoint
- writeBackupRequest chmods after write (mode is ignored on an existing tmp)
- backup.sh no longer reports 'already running' and exits 0 when it simply
  could not open the lock file
- update.sh defaults FP_USER to the actual repo owner, which is what every other
  operation uses
- drop a dead ternary in search.js"
```

---

### Task 5: Give `update.sh` a rollback trap (bug #7)

`npm ci` failure is handled explicitly, but `chown -R` and `systemctl restart` are not: `set -e` aborts and `rollback()` never runs, leaving new code with old deps and no restart. Dormant only because `AUTO_APPLY=0` on both boxes.

**Files:**
- Modify: `deploy/update.sh:136-149`

- [ ] **Step 1: Install the trap immediately after the merge point**

After the `git_as merge --ff-only "origin/$REPO_REF"` line, before the `npm ci`:

```bash
# From here on the code dir has MOVED FORWARD. Any failure below must restore
# the rollback point rather than leave a half-applied update behind: `set -e`
# would otherwise abort straight past rollback() on a failed chown or restart.
trap 'echo "[update] step failed — rolling back" >&2; rollback; exit 1' ERR
```

- [ ] **Step 2: Clear the trap on the success path**

Immediately before the final `write_status` on the success path (after the health check passes):

```bash
trap - ERR
```

- [ ] **Step 3: Verify syntax**

Run: `bash -n deploy/update.sh && echo "syntax OK"`
Expected: `syntax OK`

- [ ] **Step 4: Prove the trap fires**

Run this harness, which stubs the failing step:

```bash
cd /tmp && rm -rf uptest && mkdir uptest && cd uptest
cat > fake.sh <<'SH'
set -euo pipefail
CURRENT=abc1234
rollback() { echo "ROLLBACK RAN"; }
git_as() { :; }
echo "merged"
trap 'echo "[update] step failed — rolling back" >&2; rollback; exit 1' ERR
false            # stand-in for a failing chown/restart
echo "SHOULD NOT REACH HERE"
SH
bash fake.sh; echo "exit=$?"
```

Expected: prints `merged`, then `ROLLBACK RAN`, then `exit=1` — and never `SHOULD NOT REACH HERE`.

- [ ] **Step 5: Commit**

```bash
git add deploy/update.sh
git commit -m "fix(update): roll back on any failure after the merge, not just npm ci

chown -R and systemctl restart sat outside the explicit failure handling, so
set -e aborted straight past rollback() and left the box on new code with old
deps and no restart. On blog, whose app user is blogadmin, a missing FP_USER
made exactly that chown fail."
```

---

### Task 6: `--sections` in the export engine

**Files:**
- Modify: `tools/site-package.js` (`exportPackage`, `parseFlags`, `main`)
- Test: `test/site-package.test.js`

**Interfaces:**
- Produces: `SECTIONS = ["content","media","site","settings","credentials"]` (exported).
- Produces: `sectionsForProfile(profile)` → array. `site` → `["content","media","site"]`; `full` → all five.
- Produces: `exportPackage(opts)` honours `opts.sections` (defaults to all five when absent, preserving current behaviour).

- [ ] **Step 1: Write the failing tests**

```js
test("sectionsForProfile maps the two profile names", () => {
  assert.deepStrictEqual(sp.sectionsForProfile("site"), ["content", "media", "site"]);
  assert.deepStrictEqual(sp.sectionsForProfile("full"),
    ["content", "media", "site", "settings", "credentials"]);
});

test("export honours a sections subset", () => {
  const out = path.join(tmp, "subset.tar.gz");
  sp.exportPackage({ ...paths, profile: "full", sections: ["content"], outFile: out });
  const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
  assert.match(listing, /content\//);
  assert.doesNotMatch(listing, /media\//);
  assert.doesNotMatch(listing, /auth-config\.json/);
});

test("export with no sections option still packs everything (back-compat)", () => {
  const out = path.join(tmp, "all.tar.gz");
  sp.exportPackage({ ...paths, profile: "full", outFile: out });
  const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
  assert.match(listing, /content\//);
  assert.match(listing, /media\//);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test 2>&1 | grep -A6 "sections subset"`
Expected: FAIL — `sectionsForProfile is not a function`.

- [ ] **Step 3: Implement**

At the top of `tools/site-package.js`:

```js
// The five sections are the shared unit of export, selective import, and the
// scheduled backup's scope. site.json travels WITH the skin and favicon: the
// manifest names the skin, so splitting them permits a restored manifest
// pointing at a skin that is not there — which kills the service at boot.
const SECTIONS = ["content", "media", "site", "settings", "credentials"];

function sectionsForProfile(profile) {
  return profile === "full" ? [...SECTIONS] : ["content", "media", "site"];
}
```

In `exportPackage`, immediately after destructuring `opts`:

```js
  const want = new Set(opts.sections || SECTIONS);
```

Then gate each staging block: `manifestPath`/`skin`/`faviconDir` behind `want.has("site")`, `contentDir` behind `want.has("content")`, `mediaDir` behind `want.has("media")`, and the `auth-config.json` copy behind `want.has("credentials")` (keeping the existing `profile === "full"` condition alongside it).

Add to `parseFlags`: `else if (a === "--sections") flags.sections = argv[++i];`

In `main`'s export branch, resolve the section list and validate it:

```js
    const sections = flags.sections
      ? flags.sections.split(",").map((s) => s.trim()).filter(Boolean)
      : sectionsForProfile(profile);
    for (const s of sections) {
      if (!SECTIONS.includes(s)) throw new Error(`unknown section: ${s}`);
    }
    exportPackage({ ...paths, profile, sections, outFile });
```

Export `SECTIONS` and `sectionsForProfile` from `module.exports`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add tools/site-package.js test/site-package.test.js
git commit -m "feat(export): add --sections to the export engine

Five sections become the shared unit of export, selective import, and the
scheduled backup's scope. --profile stays as sugar over them, and omitting
sections entirely preserves the existing pack-everything behaviour."
```

---

### Task 7: Put `settings` in the artifact

`settings.json` is built from `backup-status.json` (the app's existing read-only view of root config), so the app needs no new privilege. Root additionally reads `update.conf` so `autoApply`/`repoRef` can travel.

**Files:**
- Modify: `tools/backup-control.js` (`buildStatus`, `refreshStatus`, `envFromProcess`)
- Modify: `deploy/featherspress-backup-control.service` (add `UPDATE_CONF`)
- Modify: `tools/site-package.js` (`exportPackage` writes `settings.json`)
- Test: `test/backup-control.test.js`, `test/site-package.test.js`

**Interfaces:**
- Produces: `backup-status.json` gains `update: { autoApply: bool, repoRef: string }` and `config.ageRecipient` (public key — safe).
- Produces: `exportPackage` writes `settings.json` when `sections` includes `settings` and `opts.settings` is provided.

- [ ] **Step 1: Write the failing test**

```js
test("buildStatus carries the update config and the age recipient", () => {
  const s = bc.buildStatus({
    writtenAt: "2026-07-25T00:00:00Z",
    config: { destType: "local", keepLast: 14 },
    ageRecipient: "age1abc",
    update: { autoApply: false, repoRef: "main" },
  });
  assert.strictEqual(s.ageRecipient, "age1abc");
  assert.deepStrictEqual(s.update, { autoApply: false, repoRef: "main" });
});

test("export writes settings.json when the section is requested", () => {
  const out = path.join(tmp, "with-settings.tar.gz");
  sp.exportPackage({
    ...paths, profile: "full", sections: ["content", "settings"], outFile: out,
    settings: { schemaVersion: 1, backup: { keepLast: 9 }, update: { autoApply: false } },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-unpack-"));
  execFileSync("tar", ["-xzf", out, "-C", dir]);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.strictEqual(parsed.backup.keepLast, 9);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test 2>&1 | grep -A6 "settings.json when the section"`
Expected: FAIL — no `settings.json` in the archive.

- [ ] **Step 3: Implement the status side**

`buildStatus` — add two fields:

```js
    ageRecipient: i.ageRecipient ?? null,
    update: i.update ?? null,
```

`envFromProcess` — add:

```js
    UPDATE_CONF: process.env.UPDATE_CONF || "/etc/featherspress/update.conf",
```

`refreshStatus` — read it and pass both through:

```js
  const upd = parseEnvFile(env.UPDATE_CONF);
```

then in the `buildStatus({...})` call add:

```js
    ageRecipient: conf.AGE_RECIPIENT || null,
    update: { autoApply: upd.AUTO_APPLY === "1", repoRef: upd.REPO_REF || "main" },
```

Add `Environment=UPDATE_CONF=/etc/featherspress/update.conf` to `deploy/featherspress-backup-control.service`.

- [ ] **Step 4: Implement the export side**

In `exportPackage`, alongside the other staging blocks:

```js
    if (want.has("settings") && opts.settings) {
      fs.writeFileSync(
        path.join(stage, "settings.json"),
        JSON.stringify(opts.settings, null, 2) + "\n"
      );
    }
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add tools/backup-control.js tools/site-package.js deploy/featherspress-backup-control.service test/
git commit -m "feat(export): carry portable settings in the artifact

settings.json is built from backup-status.json, which is already the app's
read-only view of root config, so the app gains no privilege. Root now also
reads update.conf so autoApply/repoRef can travel. Box-specific facts (paths,
users, NODE_BIN, SESSION_SECRET) are absent by construction."
```

---

### Task 8: age encryption helper + the export endpoint

**Files:**
- Create: `admin/archive.js`
- Modify: `admin/router.js`
- Test: `test/archive.test.js`

**Interfaces:**
- Produces: `encryptToRecipient(inFile, outFile, recipient)` → void; throws on failure.
- Produces: `decryptWithIdentity(inFile, outFile, identityText)` → void; pipes the identity to `age -d -i /dev/stdin` so it never reaches disk. Throws `Error("could not decrypt")` on a wrong key.
- Produces: `buildSettings(status)` → the `settings.json` object from a parsed `backup-status.json`.
- Produces: `GET /admin/api/export?sections=a,b&encrypt=1` streams a `.tar.gz` (or `.tar.gz.age`).

- [ ] **Step 1: Write the failing test**

```js
const archive = require("../admin/archive");

test("age round-trip with a piped identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-age-"));
  execFileSync("age-keygen", ["-o", path.join(dir, "key.txt")], { stdio: "pipe" });
  const identity = fs.readFileSync(path.join(dir, "key.txt"), "utf8");
  const recipient = identity.match(/public key: (age1\w+)/)[1];
  fs.writeFileSync(path.join(dir, "plain.txt"), "the site");
  archive.encryptToRecipient(path.join(dir, "plain.txt"), path.join(dir, "c.age"), recipient);
  archive.decryptWithIdentity(path.join(dir, "c.age"), path.join(dir, "out.txt"), identity);
  assert.strictEqual(fs.readFileSync(path.join(dir, "out.txt"), "utf8"), "the site");
});

test("decrypting with the wrong identity throws", () => {
  /* generate a second key, expect assert.throws(..., /could not decrypt/) */
});

test("buildSettings pulls the portable fields out of status", () => {
  const s = archive.buildSettings({
    config: { destType: "local", localDir: "/var/backups/featherspress", keepLast: 14,
              schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" },
              sections: ["content"] },
    ageRecipient: "age1abc",
    update: { autoApply: false, repoRef: "main" },
  });
  assert.strictEqual(s.schemaVersion, 1);
  assert.strictEqual(s.backup.keepLast, 14);
  assert.strictEqual(s.backup.schedule.weekday, "Sun");
  assert.strictEqual(s.backup.ageRecipient, "age1abc");
  assert.strictEqual(s.update.autoApply, false);
  assert.strictEqual(s.backup.localDir, "/var/backups/featherspress");
});
```

Skip the two age tests when `age`/`age-keygen` are absent, so the suite still runs on a dev box without them:

```js
const HAVE_AGE = (() => { try { execFileSync("age", ["--version"], { stdio: "pipe" }); return true; } catch { return false; } })();
test("age round-trip with a piped identity", { skip: !HAVE_AGE }, () => { /* … */ });
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test 2>&1 | grep -A5 "age round-trip"`
Expected: FAIL — `Cannot find module '../admin/archive'`.

- [ ] **Step 3: Implement `admin/archive.js`**

```js
"use strict";

// Artifact helpers for the /admin export + restore path: age encryption, and
// turning the root-written backup-status.json into a portable settings.json.
//
// Encryption is KEY-BASED in both directions. `age -p` cannot be used: it opens
// /dev/tty unconditionally and 1.1.1 has no --passphrase-file, so a web app
// cannot drive it. Decryption pipes the identity to `age -d -i /dev/stdin`, so
// the operator's private key is never written to disk.

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function encryptToRecipient(inFile, outFile, recipient) {
  if (!recipient) throw new Error("no age recipient configured");
  execFileSync("age", ["-r", recipient, "-o", outFile, inFile], { stdio: "pipe" });
  // age writes 0644; an artifact carrying credentials must not sit world-readable.
  fs.chmodSync(outFile, 0o600);
}

function decryptWithIdentity(inFile, outFile, identityText) {
  try {
    execFileSync("age", ["-d", "-i", "/dev/stdin", "-o", outFile, inFile], {
      input: identityText,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Never echo age's stderr: it is attacker-influenced and adds nothing.
    throw new Error("could not decrypt");
  }
  fs.chmodSync(outFile, 0o600);
}

// The portable half of the box's configuration. Box-specific facts (paths,
// users, NODE_BIN, SESSION_SECRET) are absent by construction — this only ever
// reads fields the root agent already publishes.
function buildSettings(status) {
  const c = (status && status.config) || {};
  const sch = c.schedule || {};
  return {
    schemaVersion: 1,
    backup: {
      destType: c.destType || "local",
      localDir: c.localDir || null,
      remote: c.remote || null,
      remotePath: c.remotePath || null,
      keepLast: typeof c.keepLast === "number" ? c.keepLast : 14,
      schedule: {
        preset: sch.preset || "daily",
        timeOfDay: sch.timeOfDay || "00:24",
        weekday: sch.weekday || null,
      },
      sections: Array.isArray(c.sections) ? c.sections : null,
      ageRecipient: (status && status.ageRecipient) || null,
    },
    update: {
      autoApply: !!(status && status.update && status.update.autoApply),
      repoRef: (status && status.update && status.update.repoRef) || "main",
    },
  };
}

module.exports = { encryptToRecipient, decryptWithIdentity, buildSettings };
```

- [ ] **Step 4: Add the export endpoint to `admin/router.js`**

```js
const os = require("os");
const { exportPackage, resolvePackagePaths, SECTIONS } = require("../tools/site-package");
const archive = require("./archive");

router.get("/api/export", (req, res) => {
  const requested = String(req.query.sections || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sections = requested.length ? requested : ["content", "media", "site"];
  for (const s of sections) {
    if (!SECTIONS.includes(s)) return res.status(400).json({ error: "unknown section" });
  }

  let status = null;
  try {
    status = JSON.parse(fs.readFileSync(config.BACKUP_STATUS_FILE, "utf8"));
  } catch {}

  const wantsSecrets = sections.includes("credentials");
  const recipient = status && status.ageRecipient;
  // An archive carrying the password hash + TOTP secret must never leave the
  // box in plaintext. Refuse rather than silently downgrade.
  if (wantsSecrets && !recipient) {
    return res.status(409).json({
      error: "This archive contains your credentials, so it must be encrypted. " +
             "Set up encryption first (Scheduled backup → Set up encryption).",
    });
  }

  // 0700 dir: the staged artifact may carry credentials.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "fp-uiexport-"));
  fs.chmodSync(stage, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  let file = path.join(stage, `featherspress-${stamp}.tar.gz`);
  try {
    const manifestObj = manifest.load();
    const paths = resolvePackagePaths(config, manifestObj);
    exportPackage({
      ...paths,
      profile: wantsSecrets ? "full" : "site",
      sections,
      settings: sections.includes("settings") ? archive.buildSettings(status) : null,
      outFile: file,
    });
    if (wantsSecrets || req.query.encrypt === "1") {
      if (!recipient) throw new Error("no age recipient configured");
      archive.encryptToRecipient(file, file + ".age", recipient);
      fs.rmSync(file, { force: true });
      file = file + ".age";
    }
    res.download(file, path.basename(file), () => {
      fs.rmSync(stage, { recursive: true, force: true });
    });
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    res.status(500).json({ error: "Export failed: " + e.message });
  }
});
```

- [ ] **Step 5: Add an endpoint test**

In `test/admin.test.js`: `GET /admin/api/export?sections=content` returns 200 with `content-type` `application/gzip` (or `application/octet-stream`) and a non-empty body; `?sections=bogus` returns 400; `?sections=credentials` on a box with no recipient returns 409.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add admin/archive.js admin/router.js test/
git commit -m "feat(export): /admin export endpoint with age encryption

Key-based encryption both ways (age -p needs a TTY and cannot be driven from a
web app). A credentials-bearing export is refused outright when the box has no
age recipient, rather than silently written in plaintext."
```

---

### Task 9: The "Backup & Restore" tab (export UI + scope checkboxes)

**Files:**
- Modify: `admin/public/index.html`

- [ ] **Step 1: Rename the tab**

Change the tab label from `Backups` to `Backup & Restore` (`index.html:188`). Leave `data-tab="backups"` and the `view-backups` id alone — renaming those would touch the JS for no benefit.

- [ ] **Step 2: Add the backup-scope checkboxes to the Scheduled backup block**

After the "Keep last" row:

```html
      <label>What to back up</label>
      <div id="bk-scope" style="margin:4px 0 14px;">
        <label style="font-weight:400;"><input type="checkbox" class="bk-sec" value="content" checked> Content</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="bk-sec" value="media" checked> Media</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="bk-sec" value="site" checked> Site &amp; skin</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="bk-sec" value="settings" checked> Settings</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="bk-sec" value="credentials" checked> Credentials</label>
      </div>
      <div id="bk-scope-warn" hidden class="hint" style="margin-bottom:14px;"></div>
```

- [ ] **Step 3: Warn when the scope cannot restore the site**

```js
  function syncScopeWarning() {
    var picked = [].slice.call(document.querySelectorAll('.bk-sec:checked')).map(function (c) { return c.value; });
    var missing = ['content', 'credentials'].filter(function (s) { return picked.indexOf(s) === -1; });
    var w = el('bk-scope-warn');
    if (missing.length) {
      w.hidden = false;
      w.textContent = 'Heads up: without ' + missing.join(' and ') +
        ', this scheduled backup will NOT be able to fully restore your site.';
    } else { w.hidden = true; }
  }
  document.querySelectorAll('.bk-sec').forEach(function (c) { c.addEventListener('change', syncScopeWarning); });
```

Call `syncScopeWarning()` from `renderBackupStatus`, and populate the boxes from `c.sections` when present. Add `sections` to the object `currentBackupRequest()` returns.

- [ ] **Step 4: Add the Export block**

```html
      <hr style="margin:22px 0;">
      <h3>Export</h3>
      <div style="margin:4px 0 14px;">
        <label style="font-weight:400;"><input type="radio" name="ex-preset" value="migrate" checked> Migrate this site <span class="hint">(everything, encrypted)</span></label><br>
        <label style="font-weight:400;"><input type="radio" name="ex-preset" value="portable"> Portable site <span class="hint">(no secrets)</span></label><br>
        <label style="font-weight:400;"><input type="radio" name="ex-preset" value="custom"> Custom…</label>
      </div>
      <div id="ex-custom" hidden style="margin:4px 0 14px;">
        <label style="font-weight:400;"><input type="checkbox" class="ex-sec" value="content" checked> Content</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="ex-sec" value="media" checked> Media</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="ex-sec" value="site" checked> Site &amp; skin</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="ex-sec" value="settings"> Settings</label>
        <label style="font-weight:400; margin-left:14px;"><input type="checkbox" class="ex-sec" value="credentials"> Credentials</label>
      </div>
      <div id="ex-note" class="hint" style="margin-bottom:10px;"></div>
      <div class="actions"><button id="ex-download">Download archive</button></div>
```

- [ ] **Step 5: Wire the download**

```js
  function exportSections() {
    var preset = (document.querySelector('input[name=ex-preset]:checked') || {}).value || 'migrate';
    if (preset === 'migrate') return ['content', 'media', 'site', 'settings', 'credentials'];
    if (preset === 'portable') return ['content', 'media', 'site'];
    return [].slice.call(document.querySelectorAll('.ex-sec:checked')).map(function (c) { return c.value; });
  }
  function syncExportNote() {
    el('ex-custom').hidden = (document.querySelector('input[name=ex-preset]:checked') || {}).value !== 'custom';
    var secs = exportSections();
    var secrets = secs.indexOf('credentials') !== -1;
    var haveKey = bkLastStatus && bkLastStatus.encrypted;
    el('ex-note').textContent = !secrets
      ? 'No credentials in this archive — safe to keep anywhere.'
      : (haveKey
          ? 'Contains your password hash and 2FA secret. It will be encrypted with your age key — you need that key to restore it.'
          : 'This archive contains your credentials, so it must be encrypted. Set up encryption first.');
    el('ex-download').disabled = secs.length === 0 || (secrets && !haveKey);
  }
  document.querySelectorAll('input[name=ex-preset], .ex-sec').forEach(function (c) {
    c.addEventListener('change', syncExportNote);
  });
  el('ex-download') && el('ex-download').addEventListener('click', function () {
    window.location = '/admin/api/export?sections=' + encodeURIComponent(exportSections().join(','));
  });
```

Call `syncExportNote()` at the end of `renderBackupStatus` so it reflects whether a key exists.

- [ ] **Step 6: Verify in a real browser**

Boot locally against a scratch data dir, log in, open the tab, and take a Playwright screenshot. Per this project's established practice, HTTP 200 checks are not sufficient — a screenshot has caught rendering bugs here before. Confirm: the schedule round-trips (set weekly Sun 03:00, reload, still shows weekly Sun 03:00), the scope warning appears when Content is unticked, and Download produces a file.

- [ ] **Step 7: Commit**

```bash
git add admin/public/index.html
git commit -m "feat(admin): Backup & Restore tab with export and backup scope

Scheduled backup, export and (next) restore share one screen and one engine —
Back up now and Download archive differ only in where the artifact goes. The
schedule now round-trips into the form, which is what made Save silently reset
it."
```

---

### Task 10: Wire `BACKUP_SECTIONS` through the agent and `backup.sh`

**Files:**
- Modify: `tools/backup-control.js` (`validateRequest`, `renderBackupEnv`, `refreshStatus`)
- Modify: `deploy/backup.sh`, `deploy/backup.env.example`
- Test: `test/backup-control.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("accepts a valid sections list", () => {
  const r = bc.validateRequest({ ...base, sections: ["content", "media"] }, CTX);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.config.sections, ["content", "media"]);
});

test("rejects an unknown section", () => {
  const r = bc.validateRequest({ ...base, sections: ["content", "etc"] }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /section/);
});

test("defaults to all sections when none are given", () => {
  const r = bc.validateRequest(base, CTX);
  assert.deepStrictEqual(r.config.sections,
    ["content", "media", "site", "settings", "credentials"]);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test 2>&1 | grep -A6 "unknown section"`
Expected: FAIL — `sections` is ignored, so the "rejects" test does not reject.

- [ ] **Step 3: Validate in `validateRequest`**

Before the `return { ok: true, ... }`:

```js
  const ALL_SECTIONS = ["content", "media", "site", "settings", "credentials"];
  let sections = ALL_SECTIONS;
  if (req.sections !== undefined) {
    if (!Array.isArray(req.sections) || req.sections.length === 0) return fail("bad sections");
    for (const s of req.sections) {
      if (typeof s !== "string" || !ALL_SECTIONS.includes(s)) return fail("unknown section");
    }
    sections = [...new Set(req.sections)];
  }
```

and add `sections,` to the returned `config`.

- [ ] **Step 4: Persist and report it**

`renderBackupEnv` — add `lines.push(\`BACKUP_SECTIONS=${config.sections.join(",")}\`);`

`refreshStatus` — add to `cfg`:

```js
    sections: conf.BACKUP_SECTIONS ? conf.BACKUP_SECTIONS.split(",") : null,
```

- [ ] **Step 5: Consume it in `backup.sh`**

After the `KEEP_LAST` validation:

```bash
# Which sections the scheduled backup captures (set from /admin). Empty = all.
BACKUP_SECTIONS="${BACKUP_SECTIONS:-}"
SECTION_ARGS=()
if [ -n "$BACKUP_SECTIONS" ]; then
  SECTION_ARGS=(--sections "$BACKUP_SECTIONS")
fi
```

and change the export call to:

```bash
"$NODE_BIN" "$ENGINE_DIR/tools/site-package.js" export --profile full "${SECTION_ARGS[@]}" --out "$ARTIFACT"
```

Document `BACKUP_SECTIONS` in `deploy/backup.env.example`.

- [ ] **Step 6: Verify syntax and run the suite**

Run: `bash -n deploy/backup.sh && npm test`
Expected: `syntax OK` and a green suite.

- [ ] **Step 7: Commit**

```bash
git add tools/backup-control.js deploy/backup.sh deploy/backup.env.example test/
git commit -m "feat(backup): make the scheduled backup's scope configurable from /admin

Closes the long-standing 'different sets of what to backup' question with the
concrete use case: choosing what the NIGHTLY captures. The panel warns when a
scope omits content or credentials, since such a backup cannot fully restore."
```

---

### Task 11: `--tar` for the WordPress converter

**Files:**
- Modify: `converter/wp_to_package.py`
- Test: `converter/test_convert.py`

- [ ] **Step 1: Add the flag**

```python
    ap.add_argument("--tar", action="store_true",
                    help="also write <out>.tar.gz, ready to upload in /admin → Restore")
```

- [ ] **Step 2: Emit the tarball**

At the end of `main()`, after `write_manifest`:

```python
    if args.tar:
        import tarfile
        tgz = Path(str(args.out).rstrip("/") + ".tar.gz")
        # Members are stored relative to the package root, exactly as
        # site-package.js's `tar -czf out -C stage .` does, so the engine's
        # importer sees the identical layout.
        with tarfile.open(tgz, "w:gz") as tf:
            for item in sorted(args.out.rglob("*")):
                tf.add(item, arcname=str(item.relative_to(args.out)))
        print(f"uploadable archive: {tgz}")
```

- [ ] **Step 3: Prove the loop closes**

Run the converter against the existing test fixture with `--tar`, then import the resulting tarball with the Node engine into a scratch data dir:

```bash
cd converter && python3 -m pytest test_convert.py -q
# then, from the repo root, against a scratch dir:
CONTENT_DIR=/tmp/fpx/content MEDIA_DIR=/tmp/fpx/media \
  node tools/site-package.js import /tmp/converted-package.tar.gz --force --allow-engine-dir
```

Expected: `imported package from …`, and `/tmp/fpx/content/posts` contains the converted posts.

- [ ] **Step 4: Commit**

```bash
git add converter/wp_to_package.py converter/test_convert.py
git commit -m "feat(converter): --tar emits an uploadable archive

The converter already wrote a Site Package directory; this makes its output
directly uploadable in /admin → Restore, closing the format loop between the
WordPress converter, the backup system, and the restore path."
```

---

### Task 12: Ship Pass 1 to production

**No new code.** Rehearse, then deploy. Read `docs/DEPLOY.md` first.

- [ ] **Step 1: Full suite + rehearsal on test-feathers**

Run `npm test` (all green), then deploy the branch to `root@77.68.32.182` and exercise: schedule round-trip, Back up now (confirm the schedule is *unchanged* afterwards — this is the bug being fixed), `nextRun` non-null within 2 minutes, and an export download of each preset.

- [ ] **Step 2: Merge to main and push**

```bash
git checkout main && git merge --ff-only feat/admin-migration-export-import && git push origin main
```

- [ ] **Step 3: Deploy to gvm**

On `root@77.68.66.109`: pull as the repo owner, `npm ci --omit=dev`, restart, then `systemctl restart featherspress-backup-control.timer`. Node is `/opt/node/bin/node`.

- [ ] **Step 4: Deploy to blog**

Same on `root@82.165.221.229`, but Node is `/usr/bin/node` and the service user is `blogadmin`. **Do not overwrite blog's `featherspress.service`.** Preserve `OLD_UPLOADS_DIR`.

- [ ] **Step 5: Verify both boxes**

For each: `/` renders (screenshot, not just a 200), `/admin` loads, the Backups panel shows a real `nextRun` and the correct schedule, an export downloads, and `systemctl list-timers` still shows the backup timer at its original time.

- [ ] **Step 6: Confirm the nightly backup still runs**

Trigger `systemctl start featherspress-backup.service` on gvm and confirm a new artifact appears and `backup-status.json` reports `ok: true` — and that the schedule did not move.

---

## Pass 2 — Restore (test-feathers first; production only once proven)

### Task 13: `sections` in `importPackage`

**Files:**
- Modify: `tools/site-package.js` (`importPackage`, `parseFlags`, `main`)
- Test: `test/site-package.test.js`

**Interfaces:**
- Produces: `importPackage(opts)` honours `opts.sections`; omitting it restores every section the package carries (current behaviour).

- [ ] **Step 1: Write the failing test**

```js
test("import restores only the requested sections", () => {
  // Build a package with content + media, import with sections:["content"],
  // and assert the media dir is untouched (a sentinel file survives).
  fs.writeFileSync(path.join(mediaDir, "sentinel.txt"), "keep me");
  sp.importPackage({ src: pkgDir, ...paths, sections: ["content"], force: true });
  assert.ok(fs.existsSync(path.join(mediaDir, "sentinel.txt")),
    "media must be untouched when only content was requested");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test 2>&1 | grep -A6 "only the requested sections"`
Expected: FAIL — the sentinel is gone; `replaceDir` wiped media.

- [ ] **Step 3: Implement**

Add `sections` to the destructured `opts`, then:

```js
  const want = new Set(sections || SECTIONS);
```

Gate each replace: `site.json` + skin + favicon behind `want.has("site")`, content behind `want.has("content")`, media behind `want.has("media")`, `auth-config.json` behind `want.has("credentials")` (alongside the existing `restoreAuth` flag), and `settings.json` behind `want.has("settings")`.

**Critical:** the "package missing site.json / content/" validation currently runs unconditionally. Make each check conditional on the matching section being requested, or a content-only restore of a settings-only archive throws.

Add `--sections` to `parseFlags` (shared with export) and pass it through in `main`'s import branch.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add tools/site-package.js test/site-package.test.js
git commit -m "feat(import): selective restore by section"
```

---

### Task 14: Streaming upload + staging

**Files:**
- Modify: `admin/router.js`, `config.js`
- Test: `test/admin.test.js`

**Interfaces:**
- Produces: `config.IMPORT_STAGING_DIR` (defaults beside `content/`), `config.MAX_IMPORT_BYTES` (default 2 GB).
- Produces: `POST /admin/api/import-upload` → `{ stagedName }`.

- [ ] **Step 1: Add the config**

```js
config.IMPORT_STAGING_DIR = env("IMPORT_STAGING_DIR", path.join(config.CONTENT_DIR, "..", "import-staging"));
config.MAX_IMPORT_BYTES = parseInt(env("MAX_IMPORT_BYTES", String(2 * 1024 * 1024 * 1024)), 10);
```

- [ ] **Step 2: Add a disk-space guard and the streaming upload**

Use a *separate* multer instance with `diskStorage` into `IMPORT_STAGING_DIR` (0700), filename randomised via `crypto.randomBytes(16).toString("hex") + ".tar.gz"`. Do not touch the existing 25 MB media `upload`. Before accepting, check `fs.statfsSync(config.IMPORT_STAGING_DIR)` has at least `3 ×` the declared `content-length` free (artifact + unpack + pre-restore snapshot); return 507 with a plain message if not.

- [ ] **Step 3: Test**

Upload a small tarball; assert 200, a file in the staging dir at 0600, and that a 400 comes back for a non-tar upload. Assert the staging dir is 0700.

- [ ] **Step 4: Commit**

```bash
git add admin/router.js config.js test/admin.test.js
git commit -m "feat(import): stream uploads to disk with a free-space guard"
```

---

### Task 15: "Set up encryption" (age keygen through the root agent)

Implements spec Section 4b. **Show once, never store the private half.**

**Files:**
- Modify: `tools/backup-control.js` (`validateRequest`, `applyRequest`)
- Modify: `admin/router.js`, `admin/public/index.html`
- Test: `test/backup-control.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("keygen is refused when a recipient already exists", () => {
  const r = bc.validateRequest({ requestId: 9, action: "keygen" },
    { ...CTX, ageRecipientSet: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already/);
});

test("keygen is accepted on a box with no recipient", () => {
  const r = bc.validateRequest({ requestId: 9, action: "keygen" },
    { ...CTX, ageRecipientSet: false });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.config.action, "keygen");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test 2>&1 | grep -A5 "keygen is refused"`
Expected: FAIL — `action must be apply or run-now`.

- [ ] **Step 3: Implement**

Extend the action check to allow `keygen`, and short-circuit its validation (it needs no destination/keepLast/schedule):

```js
  if (req.action === "keygen") {
    if (ctx.ageRecipientSet) return fail("encryption is already set up on this box");
    return { ok: true, config: { action: "keygen" } };
  }
```

In `applyRequest`, handle it before the normal apply path: run `age-keygen`, extract the `public key:` line into `AGE_RECIPIENT` in `backup.env` (preserving everything else), and write the private half to `<data dir>/age-key-once.txt` at 0600 owned by the app user (`fs.chownSync` to the data root's uid/gid), then refresh status.

- [ ] **Step 4: One-shot read in the app**

`POST /admin/api/backup-keygen` writes the request; `GET /admin/api/age-key-once` reads that file, **unlinks it immediately**, and returns the key as text. If the file is absent, 404. Never log it.

- [ ] **Step 5: UI**

A "Set up encryption" button in the Scheduled backup block, shown only when `!status.encrypted`. On success, display the key in a `<pre>` with a Download button and the warning: *"This is the ONLY copy of your backup key. Save it now — without it, encrypted backups cannot be restored."* Do not re-fetch it on reload.

- [ ] **Step 6: Run the suite and commit**

```bash
git add tools/backup-control.js admin/ test/
git commit -m "feat(backup): generate the age key from /admin, shown once

Root generates it, keeps only the public half in backup.env, and hands the
private half to the app through a 0600 one-shot file the app unlinks on read.
Refused outright when a recipient already exists — silently rotating the key
would orphan every existing encrypted backup."
```

---

### Task 16: The restore request + root-side restore with rollback

The riskiest task. Spec Section 3, steps 1–9, including finding #10's health check.

**Files:**
- Modify: `tools/backup-control.js` (new `restore` command)
- Modify: `admin/router.js`, `config.js`
- Modify: `deploy/featherspress-backup-control.path` / `.service`
- Test: `test/backup-control.test.js`

**Interfaces:**
- Produces: `config.RESTORE_REQUEST_FILE` (beside `content/`).
- Produces: `validateRestoreRequest(req, ctx)` → `{ok, config}|{ok:false, error}`; staged path must resolve inside the staging dir, sections must be known, `requestId` must advance.
- Produces: `backup-status.json` gains `restore: { state, at, sections, error }` where `state` ∈ `idle|restoring|restarting|done|rolled-back|failed`.

- [ ] **Step 1: Write the failing validation tests**

```js
test("a restore request naming a path outside the staging dir is refused", () => {
  const r = bc.validateRestoreRequest(
    { requestId: 5, stagedName: "../../etc/passwd", sections: ["content"] },
    { appliedRestoreId: 0, stagingDir: "/var/lib/featherspress/import-staging" });
  assert.strictEqual(r.ok, false);
});

test("a restore request with an unknown section is refused", () => {
  const r = bc.validateRestoreRequest(
    { requestId: 5, stagedName: "abc.tar.gz", sections: ["etc"] },
    { appliedRestoreId: 0, stagingDir: "/var/lib/featherspress/import-staging" });
  assert.strictEqual(r.ok, false);
});

test("a well-formed restore request is accepted", () => {
  const r = bc.validateRestoreRequest(
    { requestId: 5, stagedName: "abc.tar.gz", sections: ["content", "media"] },
    { appliedRestoreId: 0, stagingDir: "/var/lib/featherspress/import-staging" });
  assert.ok(r.ok, r.error);
});
```

`stagedName` is a **bare filename**, never a path — reject anything containing `/`, `\`, or `..`, mirroring the skin-name whitelist that already exists in `importPackage`.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test 2>&1 | grep -A5 "outside the staging dir"`
Expected: FAIL — `validateRestoreRequest is not a function`.

- [ ] **Step 3: Implement the validator, then the restore runner**

The runner, in order — each step must be its own function so the sequence reads as the spec does:

1. Snapshot current data: `exportPackage({...paths, profile:"full", outFile: <0700 tmp>})`.
2. `importPackage({ src: staged, ...paths, sections, force: true, restoreAuth: sections.includes("credentials") })`.
3. If `sections` includes `settings`, read `settings.json` from the package, map it onto a config object, and run it through the **existing** `validateRequest`. Apply what validates; collect the names of fields that did not (e.g. an rclone remote this box lacks) and report them. Never abort the restore over them.
4. `reownAfterRootRestore(paths)`.
5. `systemctl restart featherspress`.
6. Health check, borrowed from `update.sh`: poll `http://127.0.0.1:$PORT/healthz` **and** `/` for up to 20s. `/healthz` alone returns 200 on a wiped site.
7. On failure: `importPackage` the snapshot back, restart again, set `restore.state = "rolled-back"`, and record the reason.
8. Delete the staged artifact and the request file.
9. Write status at every transition so the UI can follow.

- [ ] **Step 4: Wire the systemd trigger**

Add `PathModified=/var/lib/featherspress/restore-request.json` to the `.path` unit (a `.path` unit supports several). Point the service at a small dispatcher that runs `apply` then `restore`, so one unit still serves both.

- [ ] **Step 5: Prove rollback on real hardware**

On `test-feathers`, restore a deliberately-broken package (a `site.json` that is invalid JSON, and separately one naming a skin the box lacks). Both must end `rolled-back`, and **the site must still be serving** afterwards. This is the test that justifies the whole task.

- [ ] **Step 6: Commit**

```bash
git add tools/backup-control.js admin/router.js config.js deploy/ test/
git commit -m "feat(restore): root-side restore with health check and rollback

Restore runs through the same request/validate/status protocol as backup, and
borrows update.sh's discipline: a restore that leaves the service unable to
render rolls back to the pre-restore snapshot. manifest.load() rethrows on a
malformed site.json and the manifest loads at module scope, so without this a
bad archive takes the site down."
```

---

### Task 17: Restore UI

**Files:**
- Modify: `admin/public/index.html`

- [ ] **Step 1: Add the Restore block**

File picker, an age-key textarea shown when the chosen file ends `.age`, the five section checkboxes, and a Restore button that is disabled until a file is chosen.

- [ ] **Step 2: Typed confirmation**

Before POSTing, require the operator to type the site title (from `site.json`) into a confirm field. Copy: *"Restore replaces the selected parts of this site. Content not in the archive will be deleted. Type `<title>` to confirm."*

- [ ] **Step 3: Credentials warning**

When `credentials` is ticked, show, in bold, before the button: *"This will replace your password and 2FA. You will be signed out, and must sign back in with the password and authenticator from the site this archive came from."*

- [ ] **Step 4: Progress**

Poll `backup-status.json` and surface `restore.state` (`restoring → restarting → done`). On `rolled-back`, show the recorded reason and state plainly that the site was left as it was. Handle the expected disconnect during restart without reporting it as an error.

- [ ] **Step 5: Screenshot-verify and commit**

```bash
git add admin/public/index.html
git commit -m "feat(admin): Restore UI with typed confirmation and progress"
```

---

### Task 18: The fresh-VPS migration drill

The acceptance test for the whole feature. **On `test-feathers` only.**

- [ ] **Step 1: Wipe test-feathers back to bare**

Remove `/opt/featherspress`, `/var/lib/featherspress`, `/etc/featherspress`, and the systemd units. Start from `docs/DEPLOY.md` step 0.

- [ ] **Step 2: Take a migration archive from gvm**

From gvm's `/admin`: Export → "Migrate this site" → download. This exercises the real production export path.

- [ ] **Step 3: Install clean, then restore**

Follow DEPLOY.md to a working empty site, run `setup.js`, log in, upload the archive with gvm's age key from the attic, tick all five sections, Restore.

- [ ] **Step 4: Verify like a migration, not a smoke test**

- `/` renders gvm's content — **screenshot**, not a 200.
- Log in with **gvm's** password and 2FA (they replaced the ones `setup.js` made).
- The Backups panel shows gvm's schedule, retention and destination.
- `systemctl list-timers` shows the restored `OnCalendar`.
- Post counts match, and media loads (spot-check the hero image).

- [ ] **Step 5: Record the verdict**

Write `plans/migration-drill-verdict-2026-07-25.md` (gitignored) with what worked, what did not, and anything surprising. Update the spec if reality differed from the design.

---

### Task 19: Ship Pass 2 to production

Only after Task 18 passes end to end.

- [ ] **Step 1: Merge and push**
- [ ] **Step 2: Deploy to gvm, then blog** (per-box Node/user differences as in Task 12)
- [ ] **Step 3: Verify both sites render and the panels load — do NOT exercise restore on production**
- [ ] **Step 4: Update `docs/DEPLOY.md` and `docs/BACKUP-IMPORT-EXPORT.md`** with the migrate-from-archive flow and the new `/admin` restore path
- [ ] **Step 5: Update memory** — the backup-admin-ui and next-todo memories both describe a world where import/export is CLI-only

---

## Self-review notes

- **Spec coverage:** Sections 1–10 all map to tasks (1: T6/T13; 2: T6/T8/T9; 3: T16; 4: T8; 4b: T15; 5: T10; 6: T9/T17; 7: T14; 8: T11; 9: T18/T19; 10: T1–T5).
- **Ordering:** T1 must precede T2 and T7 (both consume the structured schedule). T6 must precede T8. T13 must precede T16.
- **Known risk:** T16 is the one task that can break a live site. It is gated behind T18's drill and never exercised on production.
- **Deliberately deferred:** rclone credential migration, `SESSION_SECRET` migration, Apache/systemd unit templating — all listed out of scope in the spec.
