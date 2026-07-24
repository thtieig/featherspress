# Backup admin UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Let a signed-in `/admin` user see and control scheduled backups (status, destination, retention, schedule, run-now) without the web app gaining any privilege.

**Architecture:** The app writes an untrusted `backup-request.json` into the data dir. A root Node CLI (`tools/backup-control.js`), triggered by a systemd `.path` unit (+ safety timer), validates it against a whitelist, writes `/etc/featherspress/backup.env` + a timer drop-in, and refreshes `backup-status.json`, which the UI polls. Mirrors the existing `update-status.json` pattern.

**Tech Stack:** Node (CommonJS, `node --test`), Express 5, systemd, bash (`backup.sh`), age, rclone.

## Global Constraints

- Node `>=20`; CommonJS; no new npm deps (pure JS only).
- The app process is unprivileged; only root writes `/etc` and touches systemd.
- Root never trusts the request file: open `O_NOFOLLOW`, size-cap ≤64 KB, whole-request reject, error strings from a fixed enum (never echo input).
- Retention is count-only (`KEEP_LAST`, 1–365). Schedule presets: `hourly|daily|twice-daily|weekly`; root builds `OnCalendar=` itself.
- rclone remotes are selected by name from `rclone listremotes`; never arbitrary hosts. Off-box requires `AGE_RECIPIENT` set.
- Status file `backup-status.json` is `0644`, contains no secrets (remote names + a public-key boolean only).
- Tests colocate in `test/`; follow existing `node:test` style. New admin endpoints sit behind the existing session-auth gate.

---

## File structure

- Create `tools/backup-control.js` — pure `validateRequest`, `buildOnCalendar`, `buildStatus` (unit-tested) + `main()` IO (apply/status subcommands, root-only side effects).
- Create `deploy/featherspress-backup-control.service`, `.path`, `.timer`.
- Modify `deploy/backup.sh` — `flock`, write `last-run.json`, call the status writer.
- Modify `deploy/backup.env.example` — document schedule drop-in ownership.
- Modify `admin/router.js` — `GET /api/backup-status`, `POST /api/backup-config`, `POST /api/backup-run`.
- Modify `admin/public/index.html` — Backups panel + polling JS.
- Create `test/backup-control.test.js`, extend `test/admin.test.js`.

---

### Task 1: Pure validator + OnCalendar builder

**Files:**
- Create: `tools/backup-control.js`
- Test: `test/backup-control.test.js`

**Interfaces:**
- Produces: `validateRequest(request, ctx) -> {ok:true, config} | {ok:false, error}` where `ctx = {availableRemotes:string[], ageRecipientSet:boolean, appliedRequestId:number}`; `buildOnCalendar(schedule) -> string`. `config` shape: `{destType, localDir, remote, remotePath, keepLast, schedule:{preset,timeOfDay,weekday}, action}`. `error` is one of a fixed set of strings.

- [ ] **Step 1: Write failing tests**

```javascript
// test/backup-control.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const bc = require("../tools/backup-control");

const CTX = { availableRemotes: ["mys3", "bbz"], ageRecipientSet: true, appliedRequestId: 3 };
const base = {
  requestId: 4, action: "apply", destination: { type: "local", localDir: "/var/backups/featherspress" },
  keepLast: 14, schedule: { preset: "daily", timeOfDay: "00:24", weekday: null },
};

test("accepts a well-formed local request", () => {
  const r = bc.validateRequest(base, CTX);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.config.destType, "local");
  assert.strictEqual(r.config.keepLast, 14);
});

test("rejects a stale requestId", () => {
  assert.strictEqual(bc.validateRequest({ ...base, requestId: 3 }, CTX).ok, false);
});

test("rejects localDir outside /var/backups", () => {
  const r = bc.validateRequest({ ...base, destination: { type: "local", localDir: "/etc/cron.d" } }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /localDir/);
});

test("rejects localDir traversal", () => {
  assert.strictEqual(bc.validateRequest({ ...base, destination: { type: "local", localDir: "/var/backups/../etc" } }, CTX).ok, false);
});

test("rejects an unknown rclone remote", () => {
  const r = bc.validateRequest({ ...base, destination: { type: "rclone", remote: "evil", remotePath: "b" } }, CTX);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /remote/);
});

test("accepts a known rclone remote", () => {
  const r = bc.validateRequest({ ...base, destination: { type: "rclone", remote: "mys3", remotePath: "fp" } }, CTX);
  assert.ok(r.ok, r.error);
});

test("rejects rclone when no age recipient set", () => {
  const r = bc.validateRequest({ ...base, destination: { type: "rclone", remote: "mys3", remotePath: "fp" } }, { ...CTX, ageRecipientSet: false });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /encrypt/i);
});

test("rejects remotePath traversal", () => {
  assert.strictEqual(bc.validateRequest({ ...base, destination: { type: "rclone", remote: "mys3", remotePath: "../x" } }, CTX).ok, false);
});

test("rejects keepLast out of range", () => {
  assert.strictEqual(bc.validateRequest({ ...base, keepLast: 0 }, CTX).ok, false);
  assert.strictEqual(bc.validateRequest({ ...base, keepLast: 999 }, CTX).ok, false);
  assert.strictEqual(bc.validateRequest({ ...base, keepLast: 2.5 }, CTX).ok, false);
});

test("rejects unknown schedule preset", () => {
  assert.strictEqual(bc.validateRequest({ ...base, schedule: { preset: "yearly", timeOfDay: "00:00" } }, CTX).ok, false);
});

test("rejects bad timeOfDay", () => {
  assert.strictEqual(bc.validateRequest({ ...base, schedule: { preset: "daily", timeOfDay: "24:99" } }, CTX).ok, false);
});

test("weekly requires a weekday", () => {
  assert.strictEqual(bc.validateRequest({ ...base, schedule: { preset: "weekly", timeOfDay: "03:00", weekday: null } }, CTX).ok, false);
  assert.ok(bc.validateRequest({ ...base, schedule: { preset: "weekly", timeOfDay: "03:00", weekday: "Sun" } }, CTX).ok);
});

test("buildOnCalendar maps presets", () => {
  assert.strictEqual(bc.buildOnCalendar({ preset: "daily", timeOfDay: "00:24" }), "*-*-* 00:24:00");
  assert.strictEqual(bc.buildOnCalendar({ preset: "hourly" }), "*-*-* *:00:00");
  assert.strictEqual(bc.buildOnCalendar({ preset: "twice-daily", timeOfDay: "06:30" }), "*-*-* 06,18:30:00");
  assert.strictEqual(bc.buildOnCalendar({ preset: "weekly", timeOfDay: "03:00", weekday: "Sun" }), "Sun *-*-* 03:00:00");
});

test("action must be apply or run-now", () => {
  assert.strictEqual(bc.validateRequest({ ...base, action: "rm" }, CTX).ok, false);
});
```

- [ ] **Step 2: Run — expect fail** — `node --test test/backup-control.test.js` → module not found.

- [ ] **Step 3: Implement the pure functions**

```javascript
// tools/backup-control.js
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PRESETS = ["hourly", "daily", "twice-daily", "weekly"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LOCAL_ROOT = "/var/backups";

function fail(error) { return { ok: false, error }; }

function validTimeOfDay(t) {
  if (typeof t !== "string" || !/^\d{2}:\d{2}$/.test(t)) return false;
  const [h, m] = t.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function buildOnCalendar(schedule) {
  const t = schedule.timeOfDay || "00:00";
  const [h, m] = t.split(":");
  switch (schedule.preset) {
    case "hourly": return `*-*-* *:00:00`;
    case "daily": return `*-*-* ${h}:${m}:00`;
    case "twice-daily": {
      const h2 = String((Number(h) + 12) % 24).padStart(2, "0");
      const [a, b] = [h, h2].sort();
      return `*-*-* ${a},${b}:${m}:00`;
    }
    case "weekly": return `${schedule.weekday} *-*-* ${h}:${m}:00`;
    default: throw new Error("bad preset");
  }
}

function validateRequest(req, ctx) {
  if (!req || typeof req !== "object") return fail("malformed request");
  if (!Number.isInteger(req.requestId) || req.requestId <= ctx.appliedRequestId) return fail("stale or invalid requestId");
  if (req.action !== "apply" && req.action !== "run-now") return fail("action must be apply or run-now");

  const d = req.destination || {};
  let localDir = null, remote = null, remotePath = null;
  if (d.type === "local") {
    if (typeof d.localDir !== "string" || !path.isAbsolute(d.localDir)) return fail("localDir must be absolute");
    const norm = path.normalize(d.localDir);
    const rel = path.relative(LOCAL_ROOT, norm);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return fail("localDir must be under /var/backups");
    localDir = norm;
  } else if (d.type === "rclone") {
    if (!ctx.ageRecipientSet) return fail("off-box needs encryption: set AGE_RECIPIENT first");
    if (!ctx.availableRemotes.includes(d.remote)) return fail("unknown remote");
    if (typeof d.remotePath !== "string" || !/^[A-Za-z0-9._/-]+$/.test(d.remotePath) || d.remotePath.split("/").includes("..") || d.remotePath.startsWith("/")) return fail("bad remotePath");
    remote = d.remote; remotePath = d.remotePath;
  } else return fail("destination.type must be local or rclone");

  if (!Number.isInteger(req.keepLast) || req.keepLast < 1 || req.keepLast > 365) return fail("keepLast must be 1-365");

  const s = req.schedule || {};
  if (!PRESETS.includes(s.preset)) return fail("unknown schedule preset");
  if (s.preset !== "hourly" && !validTimeOfDay(s.timeOfDay)) return fail("bad timeOfDay");
  if (s.preset === "weekly" && !WEEKDAYS.includes(s.weekday)) return fail("weekly needs a weekday");

  return { ok: true, config: {
    destType: d.type, localDir, remote, remotePath, keepLast: req.keepLast,
    schedule: { preset: s.preset, timeOfDay: s.timeOfDay || "00:00", weekday: s.weekday || null },
    action: req.action,
  }};
}

module.exports = { validateRequest, buildOnCalendar };
```

- [ ] **Step 4: Run — expect pass** — `node --test test/backup-control.test.js`.
- [ ] **Step 5: Commit** — `git add tools/backup-control.js test/backup-control.test.js && git commit -m "feat(backup-ui): request validator + OnCalendar builder"`

---

### Task 2: Status assembler

**Files:**
- Modify: `tools/backup-control.js`
- Test: `test/backup-control.test.js`

**Interfaces:**
- Produces: `buildStatus(inputs) -> object` where `inputs = {appliedRequestId, lastRequestOk, lastRequestError, config, encrypted, availableRemotes, lastRun, nextRun, artifactCount, writtenAt}`. Output includes `schemaVersion:1` and exactly those fields (nulls where absent).

- [ ] **Step 1: Failing test** (append to `test/backup-control.test.js`)

```javascript
test("buildStatus produces the documented shape with no secrets", () => {
  const s = bc.buildStatus({
    appliedRequestId: 7, lastRequestOk: true, lastRequestError: null,
    config: { destType: "local", localDir: "/var/backups/featherspress", remote: null, remotePath: null, keepLast: 14, schedule: { preset: "daily", timeOfDay: "00:24", weekday: null } },
    encrypted: true, availableRemotes: ["mys3"], lastRun: { at: "t", ok: true, error: null, artifactBytes: 5 },
    nextRun: "2026-07-25T00:24:00Z", artifactCount: 3, writtenAt: "now",
  });
  assert.strictEqual(s.schemaVersion, 1);
  assert.strictEqual(s.appliedRequestId, 7);
  assert.deepStrictEqual(s.availableRemotes, ["mys3"]);
  assert.strictEqual(JSON.stringify(s).includes("AGE-SECRET"), false);
  assert.strictEqual(s.config.keepLast, 14);
});
```

- [ ] **Step 2: Run — expect fail** (`buildStatus is not a function`).
- [ ] **Step 3: Implement**

```javascript
// add to tools/backup-control.js, above module.exports
function buildStatus(i) {
  return {
    schemaVersion: 1,
    writtenAt: i.writtenAt,
    appliedRequestId: i.appliedRequestId ?? 0,
    lastRequestOk: i.lastRequestOk ?? null,
    lastRequestError: i.lastRequestError ?? null,
    config: i.config ?? null,
    encrypted: !!i.encrypted,
    availableRemotes: i.availableRemotes ?? [],
    lastRun: i.lastRun ?? null,
    nextRun: i.nextRun ?? null,
    artifactCount: i.artifactCount ?? 0,
  };
}
// add buildStatus to module.exports
```

- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(backup-ui): status assembler"`

---

### Task 3: Root agent main() — apply + status subcommands

**Files:**
- Modify: `tools/backup-control.js`
- Test: `test/backup-control.test.js` (parsing helpers only; full IO tested e2e on VPS)

**Interfaces:**
- Produces: CLI `node tools/backup-control.js apply` and `node tools/backup-control.js status`. Reads `BACKUP_ENV`, `BACKUP_REQUEST`, `BACKUP_STATUS`, `LAST_RUN_FILE` from env (paths). Consumes `validateRequest`, `buildOnCalendar`, `buildStatus`.
- Produces: `readRequestNoFollow(path) -> object` (throws on symlink/oversize), `renderBackupEnv(config, prev) -> string`.

- [ ] **Step 1: Failing tests** (append)

```javascript
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

test("readRequestNoFollow refuses a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  fs.writeFileSync(path.join(dir, "real"), "{}");
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "req"));
  assert.throws(() => bc.readRequestNoFollow(path.join(dir, "req")), /symlink|ELOOP|NOFOLLOW/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderBackupEnv writes the validated config and preserves NODE_BIN/AGE_RECIPIENT", () => {
  const env = bc.renderBackupEnv(
    { destType: "rclone", remote: "mys3", remotePath: "fp", keepLast: 9, localDir: null },
    { NODE_BIN: "/usr/bin/node", AGE_RECIPIENT: "age1xxx", ENGINE_DIR: "/opt/featherspress" }
  );
  assert.match(env, /DEST_TYPE=rclone/);
  assert.match(env, /RCLONE_REMOTE=mys3:fp/);
  assert.match(env, /KEEP_LAST=9/);
  assert.match(env, /NODE_BIN=\/usr\/bin\/node/);
  assert.match(env, /AGE_RECIPIENT=age1xxx/);
});
```

- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** (append to `tools/backup-control.js`)

```javascript
const os = require("node:os");
const { execFileSync } = require("node:child_process");

function readRequestNoFollow(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (st.size > 64 * 1024) throw new Error("request too large");
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return JSON.parse(buf.toString("utf8"));
  } finally { fs.closeSync(fd); }
}

function renderBackupEnv(config, prev) {
  const lines = ["# Managed by tools/backup-control.js — edits may be overwritten by /admin.", `DEST_TYPE=${config.destType}`];
  if (config.destType === "local") lines.push(`LOCAL_DIR=${config.localDir}`);
  else lines.push(`RCLONE_REMOTE=${config.remote}:${config.remotePath}`);
  lines.push(`KEEP_LAST=${config.keepLast}`);
  if (prev.AGE_RECIPIENT) lines.push(`AGE_RECIPIENT=${prev.AGE_RECIPIENT}`);
  if (prev.NODE_BIN) lines.push(`NODE_BIN=${prev.NODE_BIN}`);
  if (prev.ENGINE_DIR) lines.push(`ENGINE_DIR=${prev.ENGINE_DIR}`);
  return lines.join("\n") + "\n";
}

// parse KEY=VALUE env file into an object (values may be quoted)
function parseEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function listRemotes() {
  try { return execFileSync("rclone", ["listremotes"], { encoding: "utf8" }).split("\n").map((s) => s.replace(/:$/, "").trim()).filter(Boolean); }
  catch { return []; }
}

function writeStatusFile(statusPath, obj) {
  const tmp = statusPath + ".tmp";
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, statusPath);
}

function nextRunUTC(timer) {
  try {
    const out = execFileSync("systemctl", ["show", timer, "-p", "NextElapseUSecRealtime", "--value"], { encoding: "utf8" }).trim();
    // systemd gives a localized date; fall back to list-timers ISO if parse fails
    const iso = execFileSync("bash", ["-lc", `systemctl show ${timer} -p NextElapseUSecRealtime --value`], { encoding: "utf8" }).trim();
    return iso || null;
  } catch { return null; }
}

function refreshStatus(env) {
  const conf = parseEnvFile(env.BACKUP_ENV);
  const remotes = listRemotes();
  let lastRun = null;
  try { lastRun = JSON.parse(fs.readFileSync(env.LAST_RUN_FILE, "utf8")); } catch {}
  let artifactCount = 0;
  if (conf.DEST_TYPE === "local" && conf.LOCAL_DIR) {
    try { artifactCount = fs.readdirSync(conf.LOCAL_DIR).filter((f) => f.startsWith("featherspress-full-")).length; } catch {}
  }
  const cfg = {
    destType: conf.DEST_TYPE || "local",
    localDir: conf.LOCAL_DIR || null,
    remote: conf.RCLONE_REMOTE ? conf.RCLONE_REMOTE.split(":")[0] : null,
    remotePath: conf.RCLONE_REMOTE ? conf.RCLONE_REMOTE.split(":").slice(1).join(":") : null,
    keepLast: Number(conf.KEEP_LAST || 14),
    schedule: readScheduleDropIn(env.SCHEDULE_DROPIN),
  };
  const status = buildStatus({
    appliedRequestId: env._appliedRequestId ?? readAppliedId(env.BACKUP_STATUS),
    lastRequestOk: env._lastOk ?? null, lastRequestError: env._lastErr ?? null,
    config: cfg, encrypted: !!conf.AGE_RECIPIENT, availableRemotes: remotes,
    lastRun, nextRun: nextRunUTC("featherspress-backup.timer"),
    artifactCount, writtenAt: new Date().toISOString(),
  });
  writeStatusFile(env.BACKUP_STATUS, status);
}

function readAppliedId(statusPath) { try { return JSON.parse(fs.readFileSync(statusPath, "utf8")).appliedRequestId || 0; } catch { return 0; } }
function readScheduleDropIn(p) {
  try { const m = fs.readFileSync(p, "utf8").match(/OnCalendar=(.+)/); return { raw: m ? m[1].trim() : null }; } catch { return { raw: null }; }
}

if (require.main === module) {
  const cmd = process.argv[2];
  const env = {
    BACKUP_ENV: process.env.BACKUP_ENV || "/etc/featherspress/backup.env",
    BACKUP_REQUEST: process.env.BACKUP_REQUEST || "/var/lib/featherspress/backup-request.json",
    BACKUP_STATUS: process.env.BACKUP_STATUS || "/var/lib/featherspress/backup-status.json",
    LAST_RUN_FILE: process.env.LAST_RUN_FILE || "/var/lib/featherspress/backup-last-run.json",
    SCHEDULE_DROPIN: process.env.SCHEDULE_DROPIN || "/etc/systemd/system/featherspress-backup.timer.d/schedule.conf",
  };
  try {
    if (cmd === "status") { refreshStatus(env); }
    else if (cmd === "apply") { applyRequest(env); }
    else { process.stderr.write("usage: backup-control.js <apply|status>\n"); process.exit(2); }
  } catch (e) { process.stderr.write(`backup-control: ${e.message}\n`); process.exit(1); }
}

module.exports = { validateRequest, buildOnCalendar, buildStatus, readRequestNoFollow, renderBackupEnv, parseEnvFile };
```

- [ ] **Step 4: Implement `applyRequest`** (append inside the file, before `if (require.main`)

```javascript
function applyRequest(env) {
  let request;
  try { request = readRequestNoFollow(env.BACKUP_REQUEST); }
  catch (e) { return; } // no/invalid request file: nothing to do
  const conf = parseEnvFile(env.BACKUP_ENV);
  const ctx = { availableRemotes: listRemotes(), ageRecipientSet: !!conf.AGE_RECIPIENT, appliedRequestId: readAppliedId(env.BACKUP_STATUS) };
  const v = validateRequest(request, ctx);
  if (!v.ok) { env._appliedRequestId = request.requestId; env._lastOk = false; env._lastErr = v.error; refreshStatus(env); return; }
  // write backup.env (root:root 0600)
  fs.writeFileSync(env.BACKUP_ENV, renderBackupEnv(v.config, conf), { mode: 0o600 });
  fs.chmodSync(env.BACKUP_ENV, 0o600);
  // write schedule drop-in + reload
  fs.mkdirSync(path.dirname(env.SCHEDULE_DROPIN), { recursive: true });
  fs.writeFileSync(env.SCHEDULE_DROPIN, `[Timer]\nOnCalendar=\nOnCalendar=${buildOnCalendar(v.config.schedule)}\n`);
  execFileSync("systemctl", ["daemon-reload"]);
  execFileSync("systemctl", ["restart", "featherspress-backup.timer"]);
  if (v.config.action === "run-now") { try { execFileSync("systemctl", ["start", "--no-block", "featherspress-backup.service"]); } catch {} }
  env._appliedRequestId = request.requestId; env._lastOk = true; env._lastErr = null;
  refreshStatus(env);
}
```

- [ ] **Step 5: Run pure tests — expect pass** — `node --test test/backup-control.test.js`.
- [ ] **Step 6: Commit** — `git commit -am "feat(backup-ui): root agent apply/status"`

---

### Task 4: systemd units + backup.sh integration

**Files:**
- Create: `deploy/featherspress-backup-control.service`, `.path`, `.timer`
- Modify: `deploy/backup.sh` (flock + last-run.json + status refresh)

- [ ] **Step 1: Create the units**

`deploy/featherspress-backup-control.service`:
```ini
[Unit]
Description=Featherspress backup control agent (validates /admin requests as root)
[Service]
Type=oneshot
ExecStart=/opt/node/bin/node /opt/featherspress/tools/backup-control.js apply
Environment=BACKUP_ENV=/etc/featherspress/backup.env
```
`deploy/featherspress-backup-control.path`:
```ini
[Unit]
Description=Watch the Featherspress backup request file
[Path]
PathModified=/var/lib/featherspress/backup-request.json
Unit=featherspress-backup-control.service
[Install]
WantedBy=multi-user.target
```
`deploy/featherspress-backup-control.timer`:
```ini
[Unit]
Description=Safety net for the Featherspress backup control agent
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Unit=featherspress-backup-control.service
[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Modify `deploy/backup.sh`** — wrap the run in `flock`, write `last-run.json`, refresh status. Add near the top after `set -euo pipefail`:

```bash
# Serialize with any concurrent run (timer vs the /admin "back up now" button).
LOCK="/run/featherspress-backup.lock"
exec 9>"$LOCK" || true
if ! flock -n 9; then echo "[backup] another backup is running; skipping" >&2; exit 0; fi
LAST_RUN_FILE="${LAST_RUN_FILE:-/var/lib/featherspress/backup-last-run.json}"
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"
record_run() {
  local ok="$1" err="$2" bytes="${3:-0}"
  printf '{"at":"%s","ok":%s,"error":%s,"artifactBytes":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$err" "$bytes" > "$LAST_RUN_FILE" 2>/dev/null || true
  "$NODE_BIN" /opt/featherspress/tools/backup-control.js status 2>/dev/null || true
}
trap 'record_run false "\"backup failed\"" 0' ERR
```
At the very end (replace the final `echo "[backup] done."`):
```bash
record_run true null "$(stat -c%s "$LOCAL_DIR/$BASENAME" 2>/dev/null || echo 0)"
echo "[backup] done."
```

- [ ] **Step 3: Syntax check** — `bash -n deploy/backup.sh` → no output.
- [ ] **Step 4: Commit** — `git add deploy/ && git commit -m "feat(backup-ui): control units + backup.sh flock/status hooks"`

---

### Task 5: Admin API endpoints

**Files:**
- Modify: `admin/router.js`
- Modify: `config.js` (add `BACKUP_STATUS_FILE`, `BACKUP_REQUEST_FILE` beside the data dir)
- Test: `test/admin.test.js`

**Interfaces:**
- Produces: `GET /admin/api/backup-status` → the status JSON (or `{configured:false}`); `POST /admin/api/backup-config` body `{destination,keepLast,schedule}` → `{requestId}`; `POST /admin/api/backup-run` → `{requestId}`. Both POSTs write `backup-request.json` atomically with `requestId = prevStatus.appliedRequestId + <pending>`.

- [ ] **Step 1: config paths** — in `config.js` after `UPDATE_STATUS_FILE`:

```javascript
config.BACKUP_STATUS_FILE = env("BACKUP_STATUS_FILE", path.join(config.CONTENT_DIR, "..", "backup-status.json"));
config.BACKUP_REQUEST_FILE = env("BACKUP_REQUEST_FILE", path.join(config.CONTENT_DIR, "..", "backup-request.json"));
```

- [ ] **Step 2: Failing tests** (append to `test/admin.test.js`, after login runs so `cookie` is set)

```javascript
test("backup-status: unconfigured returns configured:false", async () => {
  const res = await api("GET", "/admin/api/backup-status");
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.strictEqual(j.configured, false);
});

test("backup-config writes a request with an incrementing id", async () => {
  const res = await api("POST", "/admin/api/backup-config", {
    destination: { type: "local", localDir: "/var/backups/featherspress" },
    keepLast: 7, schedule: { preset: "daily", timeOfDay: "01:00" },
  });
  assert.strictEqual(res.status, 200, await res.text());
  const j = await res.json();
  assert.ok(Number.isInteger(j.requestId));
  const reqFile = require("../config").BACKUP_REQUEST_FILE;
  const written = JSON.parse(require("fs").readFileSync(reqFile, "utf8"));
  assert.strictEqual(written.action, "apply");
  assert.strictEqual(written.keepLast, 7);
});

test("backup-run writes a run-now request", async () => {
  const res = await api("POST", "/admin/api/backup-run", {});
  const j = await res.json();
  assert.strictEqual(res.status, 200);
  const written = JSON.parse(require("fs").readFileSync(require("../config").BACKUP_REQUEST_FILE, "utf8"));
  assert.strictEqual(written.action, "run-now");
});

test("backup endpoints require auth", async () => {
  const res = await fetch(base + "/admin/api/backup-status");
  assert.strictEqual(res.status, 401);
});
```

- [ ] **Step 3: Run — expect fail.**
- [ ] **Step 4: Implement** — in `admin/router.js`, after the `/api/update-status` route:

```javascript
// ---- backups (status read + request write; root agent applies) -----------
router.get("/api/backup-status", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(config.BACKUP_STATUS_FILE, "utf8"))); }
  catch (e) { if (e.code === "ENOENT") return res.json({ configured: false }); res.status(500).json({ error: "status unreadable" }); }
});

function nextRequestId() {
  try { return (JSON.parse(fs.readFileSync(config.BACKUP_STATUS_FILE, "utf8")).appliedRequestId || 0) + 1 + Math.floor(Math.random() * 1000); }
  catch { return Date.now(); }
}
function writeRequest(obj) {
  const tmp = config.BACKUP_REQUEST_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, config.BACKUP_REQUEST_FILE);
}
router.post("/api/backup-config", express.json(), (req, res) => {
  const b = req.body || {};
  const requestId = nextRequestId();
  writeRequest({ requestId, action: "apply", destination: b.destination, keepLast: b.keepLast, schedule: b.schedule });
  res.json({ requestId });
});
router.post("/api/backup-run", express.json(), (req, res) => {
  const requestId = nextRequestId();
  // run-now keeps current config: read it back from status if present
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(config.BACKUP_STATUS_FILE, "utf8")).config || {}; } catch {}
  writeRequest({ requestId, action: "run-now",
    destination: cur.destType === "rclone" ? { type: "rclone", remote: cur.remote, remotePath: cur.remotePath } : { type: "local", localDir: cur.localDir || "/var/backups/featherspress" },
    keepLast: cur.keepLast || 14, schedule: cur.schedule || { preset: "daily", timeOfDay: "00:24" } });
  res.json({ requestId });
});
```

- [ ] **Step 5: Run — expect pass** — `node --test test/admin.test.js`.
- [ ] **Step 6: Commit** — `git commit -am "feat(backup-ui): admin API for backup status/config/run"`

---

### Task 6: Admin UI panel

**Files:**
- Modify: `admin/public/index.html`

- [ ] **Step 1:** Add a "Backups" section markup + JS that: GETs `/admin/api/backup-status`; renders configured/unconfigured; shows destination (local/off-box radio; off-box disabled with a note if `availableRemotes` empty; encryption note if `!encrypted`); keep-last input; schedule preset + time; `Save changes` → POST `/admin/api/backup-config` then poll status until `appliedRequestId >= requestId`, show applied/error; `Back up now` → POST `/admin/api/backup-run` then poll for a new `lastRun.at`. Reuse the page's existing fetch/el helpers and styling classes.

- [ ] **Step 2: Manual smoke** — `node -e "require('./server')"` loads without error; visual check deferred to the VPS rehearsal (screenshot).
- [ ] **Step 3: Commit** — `git commit -am "feat(backup-ui): Backups panel in /admin"`

---

### Task 7: Full suite + branch hygiene

- [ ] **Step 1:** `npm test` → all pass.
- [ ] **Step 2:** `git commit` any stragglers; branch: `feat/backup-admin-ui` off `main`, pushed.

---

## Deployment (executed after the VPS rehearsal passes — see spec "Deployment")

Not TDD tasks; a runbook. Rehearse the entire feature on `77.68.32.182` first (install units, drive the UI, run the adversarial validator cases, confirm a real rclone upload + retention + schedule change + run-now). Then:

- **gvm (77.68.66.109):** raw `tar` backup → archive→clone migration pinned at current commit → fast-forward to `main` → `npm ci` → fix env quoting → `chmod 600 auth-config.json` → install backup + control units + default `backup.env` (defaults) + `update.conf` → restart → verify site + admin login with existing 2FA + Backups panel.
- **blog (82.165.221.229):** first import blog's attic package on the VPS and verify `/here-my-pages/` renders. Then on prod: raw `tar` backup → archive→clone migration → `main` → `npm ci` (`/usr/bin/npm`) → `chmod 600 auth-config.json` (env already fine) → install units with per-box `backup.env` (`NODE_BIN=/usr/bin/node`) + `update.conf` (`FP_USER=blogadmin`) → restart → verify site (`/here-my-pages/`, welcome page, 209 posts), admin login with preserved 2FA, Backups panel. **Never run setup.js/import against the live data dir.**

## Self-review notes

- Spec coverage: status/destination/retention/schedule/run-now (T5/T6), validator whitelist + hardening (T1/T3), single status writer under flock (T3/T4), progressive disclosure (T6), bootstrap default env (deploy), per-box deploy (deploy). Covered.
- The `nextRunUTC` helper is best-effort (systemd's value formatting varies); the UI treats a null `nextRun` as "unknown", so a parse miss degrades gracefully rather than breaking.
