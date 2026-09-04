# Design: /admin "Updates" section (force-check + auto-apply toggle)

Date: 2026-09-04
Status: approved (design), not yet implemented
Builds on the existing update-check/apply machinery (`deploy/update.sh`,
`tools/update-control.js`, the "Apply now" banner button) shipped in
`d04425e`/`61ca5b8`/`fc4f32a`.

## Goal

Give the operator two things from `/admin`, without SSH:

1. **Force a check now**, instead of waiting for the nightly 03:30 timer.
2. **See and toggle `AUTO_APPLY`** (currently an SSH-only edit of
   `/etc/featherspress/update.conf`).

Both need root, so both go through the same optional agent that already backs
"Apply now" (`tools/update-control.js` + the `featherspress-update-control.*`
systemd units, installed per `docs/DEPLOY.md`'s "Apply from the GUI"
section). No new agent, no new systemd units — this only adds two more
request `action`s to the one that exists.

## Explicitly out of scope

- No live polling/spinner. `deploy/update.sh` never restarts the service for
  a check (only for an actual apply), so a check finishes in a couple of
  seconds behind the request — but we still don't build a polling UI for it.
  The click disables the button, waits a few seconds, then calls the
  existing `checkUpdateStatus()` fetch once. That is the entire UX for
  "check now."
- No second source of truth for `AUTO_APPLY`. One file
  (`/etc/featherspress/update.conf`) stays authoritative, read by
  `update.sh` exactly as today. The GUI toggle edits that file's
  `AUTO_APPLY=` line directly, in place. (Considered and rejected: a
  separate override file the agent writes instead of touching
  `update.conf`. Rejected as an unnecessary second concept for a single
  boolean — see conversation.)
- No confirmation dialog, no new warning copy beyond a one-line caption.
  `update.conf.example`'s existing comment already documents the risk of
  `AUTO_APPLY=1`; that's enough context for an operator running their own
  box.

## Part A — data: `deploy/update.sh`

`write_status()` (deploy/update.sh:99-110) already runs on every check,
scheduled or forced, and already sources `update.conf` (so `$AUTO_APPLY` is
in scope). Add three fields to the JSON it writes:

- `currentCommitDate` — `git log -1 --format=%cI "$CURRENT"` (empty string on
  failure, same defensive style as `read_version()`).
- `availableCommitDate` — same, for `$AVAILABLE`.
- `autoApply` — `true`/`false`, the literal `$AUTO_APPLY` value already
  loaded.

These are the only new pieces of information the UI needs; nothing else
about `update.sh`'s control flow changes.

## Part B — data: `tools/update-control.js`

Two new `action` values alongside the existing `"apply"`
(`validateRequest`, tools/update-control.js):

- **`"check"`** — run `deploy/update.sh` as today, but WITHOUT forcing
  `AUTO_APPLY=1`. Real semantics, same as the nightly timer, just on demand.
  Note this means if the box's real `AUTO_APPLY` is already `1`, a "check"
  can still result in an actual apply + restart — that's existing
  `update.sh` behavior, not new, and is called out in the button's caption
  (Part D) rather than special-cased in code.
- **`"set-auto-apply"`** — request carries `{requestId, action:
  "set-auto-apply", enabled: true|false}`. Validate `enabled` is strictly
  boolean (reject anything else, same "fixed, non-echoing error string"
  style as the rest of `validateRequest`). On a valid request: read
  `update.conf`, replace the `AUTO_APPLY=` line via a single-line regex
  (`/^AUTO_APPLY=.*$/m`) if present, else append `AUTO_APPLY=<0 or 1>\n`;
  write via the same tmp-file-in-same-dir + `chmod 600` + rename idiom
  `writeAuthConfigAtomic` uses (src/auth-config.js), preserving
  `update.conf`'s existing `root:root` ownership. No change to any other
  line in the file.

Both new actions get the same requestId freshness check the existing
`"apply"` action uses (`req.requestId > ctx.appliedRequestId`) and the same
heartbeat-on-every-trigger behavior that already updates `agentSeenAt` —
that plumbing (admin/router.js's `agentSeenAt` gating) is reused untouched.

## Part C — API: `admin/router.js`

Two new routes next to the existing `/api/update-apply`
(admin/router.js:208-212), same shape:

```js
router.post("/api/update-check", updateApplyLimiter, (req, res) => {
  const requestId = nextUpdateRequestId();
  writeUpdateRequest({ requestId, action: "check" });
  res.json({ requestId });
});

router.post("/api/update-auto-apply", updateApplyLimiter, (req, res) => {
  if (typeof req.body.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  const requestId = nextUpdateRequestId();
  writeUpdateRequest({ requestId, action: "set-auto-apply", enabled: req.body.enabled });
  res.json({ requestId });
});
```

Reuses `nextUpdateRequestId()`, `writeUpdateRequest()`, and
`updateApplyLimiter` as-is. `GET /api/update-status` needs no change beyond
already round-tripping whatever `update.sh` puts in the status file — the
three new fields from Part A flow straight through to the client with no
additional merge logic (the `autoApply` field lives in
`UPDATE_STATUS_FILE`, written by `update.sh`, not in the
`UPDATE_APPLY_STATUS_FILE` merge block, since it's set on every check, not
only on an apply).

## Part D — UI: `admin/public/index.html`

- New tab after "Backup & Restore" (admin/public/index.html:197):
  `<div class="tab" data-tab="updates">Updates</div>`.
- New `<section id="view-updates" hidden>`, same structural pattern as
  `#view-backups`: a status line, then controls.
  - Status line: current commit (short hash) + its date, available commit +
    its date when `available`, and "checked at" time.
  - "Check for updates" button. Caption underneath: "May also apply and
    restart the server if auto-updates is on below." Disabled while a
    request is in flight; re-enabled after the delayed refresh (below).
  - Auto-apply checkbox, label "Automatically apply updates overnight",
    reflecting `status.autoApply`. On change: `POST
    /api/update-auto-apply`, then the same delayed refresh.
  - Both controls follow the existing `agentSeenAt` gate: if the agent's
    never checked in, show the existing install hint
    ("Install the update-control agent... — see DEPLOY.md") in place of the
    controls, exactly like the current banner does for "Apply now".
- JS: both the check button and the checkbox's change handler do the same
  thing on response — `disabled = true`, then
  `setTimeout(checkUpdateStatus, 4000)` (reusing the existing function
  verbatim, no new fetch/polling logic), which also re-enables the
  controls as a side effect of re-rendering the section from fresh status.
  No new global state beyond what `checkUpdateStatus()` already tracks.
- The existing top-of-page `#update-banner` + "Apply now" button are
  unchanged — this section is a second, persistent place to see/act on the
  same status, not a replacement.

## Part E — docs: `docs/DEPLOY.md`

Extend the existing "### Apply from the GUI" section (docs/DEPLOY.md:353)
to mention the two new controls live in the same place and need the same
agent install — no new install steps, no new section heading needed.

## Testing

- `tools/update-control.js`'s pure `validateRequest` is already unit
  tested (per its header comment) — add cases for `"check"` and
  `"set-auto-apply"` (valid, missing `value`, non-boolean `value`, stale
  `requestId`) alongside the existing `"apply"` cases.
- The `update.conf` line-replace is small enough to unit test directly:
  given file contents with/without an existing `AUTO_APPLY=` line, assert
  the rewritten contents.
- The actual `update.sh`/systemd/IO side stays exercised on the test VPS
  only, same disclaimer the file's header comment already states for the
  existing `"apply"` path.
