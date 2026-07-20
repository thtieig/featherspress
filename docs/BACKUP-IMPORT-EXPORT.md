# Backups, import & export

Featherspress has **one portable artifact — the Site Package — and one code path**
that produces and consumes it. Export, backup, import, and the WordPress
converter all speak it, so the whole thing round-trips:

```
WP backup ─(converter)─▶ Site Package (dir) ─┐
                                             ├─▶ import ─▶ live site ─▶ export ─▶ Site Package (.tar.gz)
backup restore ◀─ Site Package (+auth) ◀─────┘                                        │
                                              a backup is just an export saved off-box
```

## What a Site Package contains

The package *is* your data-dir layout:

```
site.json            your manifest (identity, skin, nav, home mode)
content/posts|pages/  Markdown with front matter
media/…               uploads
skins/<name>/         your active CUSTOM skin (bundled skins ship with the engine)
favicon/              your per-site icons
auth-config.json      credentials/2FA — ONLY in the "full" profile
```

## Two profiles

| Profile | Includes | Use it for |
|---------|----------|------------|
| `site` (default) | everything **except** `auth-config.json` | a portable, shareable, movable copy of the blog |
| `full` | `site` + `auth-config.json` (password hash + TOTP secret) | disaster recovery / backups |

There are deliberately no finer "sections" — the only meaningful split on a
single-author blog is *with or without credentials*. The engine code is **not**
part of the package (recover it from git), and `featherspress.env` is disposable.

## Export

```sh
cd /opt/featherspress
# Always pass --out a writable path: the app user can't write the (read-only)
# code dir, which is the default location.
sudo -u featherspress npm run export -- --out /tmp/site.tar.gz
sudo -u featherspress npm run export -- --profile full --out /tmp/site-full.tar.gz
```

## Import (also: restore, and migrate a whole site)

`import` accepts **either a directory** (e.g. raw converter output) **or a
`.tar.gz`**. It extracts to a staging area, rejects any path that would escape
the data dir, takes a **pre-restore safety backup** of your current data first,
then replaces.

```sh
sudo -u featherspress npm run import -- /path/to/package            # refuses if data exists…
sudo -u featherspress npm run import -- /path/to/package --force    # …unless you mean it
sudo -u featherspress npm run import -- /path/to/backup.tar.gz --force --restore-auth
```

- **Replace semantics:** the site is made to look like the package (stale posts
  not in the package are removed). Optional sections (skin, favicon, auth) are
  only touched when the package carries them.
- **`--restore-auth`** is required to overwrite `auth-config.json` — a routine
  content import can never clobber your working 2FA.
- After a content change the running site hot-reloads; after an import, restart
  the service if you changed the skin/manifest: `sudo systemctl restart featherspress`.

## Scheduled off-box backups

`deploy/backup.sh` (run by `featherspress-backup.timer` as root) exports the
`full` profile, optionally encrypts it, ships it, and prunes to keep-last-N.

```sh
sudo cp /opt/featherspress/deploy/backup.env.example /etc/featherspress/backup.env
sudo nano /etc/featherspress/backup.env          # DEST_TYPE, destination, KEEP_LAST, AGE_RECIPIENT
sudo cp /opt/featherspress/deploy/featherspress-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now featherspress-backup.timer
sudo systemctl start featherspress-backup.service    # run one now to test
```

### Destinations
- `local` — a local/mounted path. Same trust boundary as the box, so encryption
  is optional.
- `rclone` — any [rclone](https://rclone.org) remote: **S3**, **Dropbox**, or
  **SFTP over ssh**. Configure once with `rclone config`. Encryption is
  **mandatory** here.

### Encryption (age)
Backups carry `auth-config.json` (your TOTP secret in cleartext + password
hash), so any off-box copy **must** be encrypted. We use [age](https://age-encryption.org):

```sh
age-keygen -o key.txt          # prints the public key; KEEP key.txt OFF the box
# put the public key in backup.env as AGE_RECIPIENT=age1...
```

Restore an encrypted artifact:

```sh
age -d -i key.txt featherspress-full-<ts>.tar.gz.age > restore.tar.gz
sudo -u featherspress npm run import -- restore.tar.gz --force --restore-auth
```

### Retention
`KEEP_LAST` (default 14) newest backups are kept at the destination; older ones
are pruned automatically.

## Failure notifications

The systemd units declare `OnFailure=status-email@%n.service` — a silent backup
failure means no backup when you need one. Point that at your own notifier
(email/ntfy/…), or replace it with whatever you already use for systemd alerts.

## If your media ever gets large

Full-tar-every-run + keep-last-N is ideal while media is small (the common case).
If `media/` ever grows past a few GB, switch the media portion to `rclone sync`
(dedup) and tar only `content/ + site.json + skin + favicon (+ auth)`. Until
then, keep it simple.
