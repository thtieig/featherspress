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

## Running the tool on a server

Two things bite every hand-run of `export`/`import` on a box built per
[DEPLOY.md](DEPLOY.md), so they are folded into every command below:

1. **`npm` is not on `sudo`'s PATH** (Node lives under `/opt/node`), so
   `sudo -u featherspress npm run …` fails with `sudo: npm: command not found`.
   Call the script with the absolute node path instead.
2. **The tool needs your deployment's config.** With no env it falls back to the
   bundled `example-site/` inside the code dir — and since the app user owns that
   dir, an import *succeeds* there, clobbering git-tracked files and leaving your
   real site untouched. Pass `--env-file` so it resolves the same paths the
   service uses. (`import` now refuses outright if it notices it is about to
   write into the engine dir, but pass the flag and don't rely on the guard.)

```sh
FP="sudo -u featherspress /opt/node/bin/node /opt/featherspress/tools/site-package.js"
ENVF="--env-file /etc/featherspress/featherspress.env"
```

`import` prints the resolved content/media/skin/favicon/auth paths before it
touches anything — **read them** and confirm they are your data dir.

## Export

```sh
# Always pass --out a writable path: the app user can't write the (read-only)
# code dir, which is the default location.
$FP export $ENVF --out /tmp/site.tar.gz
$FP export $ENVF --profile full --out /tmp/site-full.tar.gz
```

## Import (also: restore, and migrate a whole site)

`import` accepts **either a directory** (e.g. raw converter output) **or a
`.tar.gz`**. It extracts to a staging area, rejects any path that would escape
the data dir, takes a **pre-restore safety backup** of your current data first,
then replaces.

```sh
$FP import $ENVF /path/to/package            # refuses if data exists…
$FP import $ENVF /path/to/package --force    # …unless you mean it
$FP import $ENVF /path/to/backup.tar.gz --force --restore-auth
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

  Install rclone from the official script, not the distro package — Debian 12
  ships 1.60, too old for some remotes and for `rclone serve s3` if you want to
  test against a local endpoint. The installer needs an unzip tool, which a
  minimal cloud image does not have:

  ```sh
  sudo apt install -y unzip
  curl https://rclone.org/install.sh | sudo bash
  rclone version          # want >= 1.65
  ```

  Remember that rclone's config belongs to the user that runs the backup — the
  timer runs as **root**, so configure the remote as root (`sudo rclone config`)
  or the timer will not find it.

  For an **SFTP** remote, set `known_hosts_file` as well. Without it rclone
  prints `No host key validation is being performed` and ships your backups to
  whatever answers on that address:

  ```sh
  ssh-keyscan -H backuphost >> /root/.ssh/known_hosts
  sudo rclone config update myremote known_hosts_file /root/.ssh/known_hosts
  ```

### Encryption (age)
Backups carry `auth-config.json` (your TOTP secret in cleartext + password
hash), so any off-box copy **must** be encrypted. We use [age](https://age-encryption.org):

```sh
age-keygen -o key.txt          # prints the public key; KEEP key.txt OFF the box
# put the public key in backup.env as AGE_RECIPIENT=age1...
```

### Restoring an encrypted artifact — the full drill

The private key is deliberately **not on the box**, so decrypt where the key is
(your laptop), then move the plaintext tarball over. `age` is a single static
binary; if the recovery machine doesn't have it, grab it from
<https://github.com/FiloSottile/age/releases> — an artifact written by age 1.1
decrypts fine with 1.2.

```sh
# 1. on the machine that holds key.txt:
age -d -i key.txt featherspress-full-<ts>.tar.gz.age > restore.tar.gz
scp restore.tar.gz root@yourbox:/tmp/

# 2. on the box:
sudo chown featherspress:featherspress /tmp/restore.tar.gz
FP="sudo -u featherspress /opt/node/bin/node /opt/featherspress/tools/site-package.js"
$FP import --env-file /etc/featherspress/featherspress.env \
   /tmp/restore.tar.gz --force --restore-auth
#    ^ check the "restoring into:" paths it prints before it proceeds

# 3. the service caches the manifest, skin and post index at boot:
sudo systemctl restart featherspress
sudo rm -f /tmp/restore.tar.gz          # it contains your credentials
```

**Verify the restore, don't assume it.** A wiped site still answers `/healthz`
with `featherspress ok` and still returns `200` on `/` (an empty blog with the
default skin), so neither of those proves anything. Check real content:

```sh
curl -s localhost:8787/ | grep -o '<title>[^<]*</title>'   # your title, not the fallback
curl -so /dev/null -w '%{http_code}\n' localhost:8787/<a-known-post-slug>/
sudo ls /var/lib/featherspress/content/posts | wc -l       # the count you expect
sudo stat -c '%a %U:%G' /var/lib/featherspress/auth-config.json   # 600 featherspress
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
