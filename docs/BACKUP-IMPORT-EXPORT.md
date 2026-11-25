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
notify.json           email alert settings, SMTP password included — travels
                      with auth-config.json (see "Email alerts" below)
engine.json           which engine made it: {"commit": "3dc6ab2", "version": "0.1.0"}
```

`engine.json` is information only. A restore shows it next to the engine the
site runs now and never refuses because they differ; older packages without
it restore as before.

## Two profiles

| Profile | Includes | Use it for |
|---------|----------|------------|
| `site` (default) | everything **except** `auth-config.json` | a portable, shareable, movable copy of the blog |
| `full` | `site` + `auth-config.json` (password hash + TOTP secret) and `notify.json` (email alert settings) | disaster recovery / backups |

There are deliberately no finer "sections" — the only meaningful split on a
single-author blog is *with or without credentials*. The engine code is **not**
part of the package (recover it from git), and `featherspress.env` is disposable.

## Running the tool on a server

Two things bite every hand-run of `export`/`import` on a box built per
[DEPLOY.md](DEPLOY.md), so they are folded into every command below. The
examples use a site (instance) called `blog`; use your own site's name.

1. **`npm` is not on `sudo`'s PATH** (Node lives under `/opt/node`), so
   `sudo -u fp-blog npm run …` fails with `sudo: npm: command not found`.
   Call the script with the absolute node path instead.
2. **The tool needs your deployment's config.** With no env it falls back to the
   bundled `example-site/` inside the code dir — and since the app user owns that
   dir, an import *succeeds* there, clobbering git-tracked files and leaving your
   real site untouched. Pass `--env-file` so it resolves the same paths the
   service uses. (`import` now refuses outright if it notices it is about to
   write into the engine dir, but pass the flag and don't rely on the guard.)

```sh
FP="sudo -u fp-blog /opt/node/bin/node /opt/featherspress/blog/tools/site-package.js"
ENVF="--env-file /etc/featherspress/blog/featherspress.env"
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
- **A pre-restore snapshot is written to `/tmp`** (`featherspress-prerestore-*.tar.gz`)
  before anything is replaced. It is a `full` export — your credentials — created
  `0600`, but it is **not cleaned up automatically** and `/tmp` usually survives
  until reboot. After a successful restore, delete it (or move it somewhere you
  actually keep backups):
  ```sh
  sudo ls -l /tmp/featherspress-prerestore-*.tar.gz
  sudo rm -f /tmp/featherspress-prerestore-*.tar.gz
  ```
- **`--restore-auth`** is required to overwrite `auth-config.json` — a routine
  content import can never clobber your working 2FA.
- After a content change the running site hot-reloads; after an import, restart
  the service if you changed the skin/manifest: `sudo systemctl restart featherspress@blog`.

## Scheduled backups

`deploy/backup.sh` (run as root by each site's `featherspress-backup@<name>.timer`)
exports the `full` profile, encrypts it when a key is set, keeps it on this
server, optionally uploads a copy off the box, and prunes to keep-last-N.
`deploy/add-instance.sh` sets this up: nightly at 00:20, keeping 14. The
settings live in `/etc/featherspress/<name>/backup.env`, which
**/admin → Backup & Restore** manages for you.

Backups are named `featherspress-full-<UTC time>-<engine commit>.tar.gz`, plus
`.age` when encrypted (older ones have no commit in the name).

```sh
systemctl list-timers 'featherspress-backup@*'
sudo systemctl start featherspress-backup@blog.service    # run one now to test
journalctl -u featherspress-backup@blog.service -n 20
```

### Where backups go

- **On this server, always**: `/var/backups/featherspress/<name>` (or a folder
  inside it; the root agent refuses anything else, so one site can never write
  into, or prune, another's). This copy is what the **backups list** in /admin
  shows and restores from. The folder is `0750 root:fp-<name>` and each backup
  `0640`: root writes and prunes, the site can only read its own, and
  `/var/backups/featherspress` (`0711`) lets no site list the others. The site
  can already read the live login a backup carries, so this exposes nothing
  new. An unencrypted backup is still your password hash and 2FA secret in a
  file: set up encryption anyway.
- **Plus an off-box copy** (`DEST_TYPE=rclone`, "This server + an off-box
  copy" in /admin): the same file is also uploaded to an
  [rclone](https://rclone.org) remote, as the safety copy for a lost server.
  Encryption is **mandatory** for it. The site's name is added to the remote
  path you give, so several sites can share one bucket or folder:
  `garage:fp-backups/featherspress` becomes
  `garage:fp-backups/featherspress/blog`. `KEEP_LAST` applies on both sides.
  If the upload fails (wrong credentials, host down) the run is marked failed
  in /admin ("the off-box copy failed; this backup is kept on this server
  only"); the local copy is still made. A dead host takes a few minutes to
  give up (rclone retries); a refused login fails at once.

### Setting up an off-box copy

The timer runs as **root**, so set up the rclone remote as root; it then
appears in /admin's Remote list. Debian's `rclone` package (1.60 on Debian 13)
works for S3 and SFTP; use the [official installer](https://rclone.org/install/)
if you need a newer backend.

```sh
sudo apt install -y rclone
```

**S3** (AWS, Backblaze B2, Wasabi, a self-hosted Garage...): a bucket and an
access key that may write and delete in it, then:

```sh
sudo rclone config create offsite s3 provider=Other \
  endpoint=https://s3.example.com region=us-east-1 \
  access_key_id=AKIA... secret_access_key=...
sudo rclone lsd offsite:                 # lists your buckets: the key works
```

(Use `provider=AWS` and leave out `endpoint` for Amazon itself.) In /admin pick
**This server + an off-box copy**, remote `offsite`, path
`my-bucket/featherspress`, and **Save**.

**SFTP** (any server you can ssh to): give root a key that logs in as a
backup user there, and pin the host key, or rclone uploads to whatever answers
on that address:

```sh
sudo ssh-keygen -t ed25519 -N '' -f /root/.ssh/fp_backup
# add /root/.ssh/fp_backup.pub to ~backup/.ssh/authorized_keys on backuphost
sudo sh -c 'ssh-keyscan backuphost > /root/.ssh/fp_backup_known_hosts'
sudo rclone config create backuphost sftp host=backuphost user=backup \
  key_file=/root/.ssh/fp_backup known_hosts_file=/root/.ssh/fp_backup_known_hosts
sudo rclone mkdir backuphost:featherspress
```

In /admin pick remote `backuphost`, path `featherspress` (relative to the
backup user's home). Then press **Back up now** and check the result line, or:

```sh
sudo rclone ls offsite:my-bucket/featherspress/blog
```

### Encryption (age)
Backups carry `auth-config.json` (your TOTP secret in cleartext + password
hash), so any off-box copy **must** be encrypted. We use [age](https://age-encryption.org):

The easy way is **`/admin` → Backup & Restore → Set up encryption**. The server
generates the key, keeps only the public half in `backup.env`, and shows you the
private half **once** — save it, off the box. It is refused if a key already
exists: rotating it would orphan every encrypted backup you already have.

By hand instead:

```sh
age-keygen -o key.txt          # prints the public key; KEEP key.txt OFF the box
# put the public key in backup.env as AGE_RECIPIENT=age1...
```

### Restoring an encrypted artifact by hand

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
sudo chown fp-blog:fp-blog /tmp/restore.tar.gz
FP="sudo -u fp-blog /opt/node/bin/node /opt/featherspress/blog/tools/site-package.js"
$FP import --env-file /etc/featherspress/blog/featherspress.env \
   /tmp/restore.tar.gz --force --restore-auth
#    ^ check the "restoring into:" paths it prints before it proceeds

# 3. the service caches the manifest, skin and post index at boot:
sudo systemctl restart featherspress@blog
sudo rm -f /tmp/restore.tar.gz          # it contains your credentials
```

**Verify the restore, don't assume it.** A wiped site still answers `/healthz`
with `featherspress ok` and still returns `200` on `/` (an empty blog with the
default skin), so neither of those proves anything. Check real content:

```sh
PORT=8801   # this site's port, from /etc/featherspress/blog/featherspress.env
curl -s localhost:$PORT/ | grep -o '<title>[^<]*</title>'   # your title, not the fallback
curl -so /dev/null -w '%{http_code}\n' localhost:$PORT/<a-known-post-slug>/
sudo ls /var/lib/featherspress/blog/content/posts | wc -l       # the count you expect
sudo stat -c '%a %U:%G' /var/lib/featherspress/blog/auth-config.json   # 600 fp-blog:fp-blog
```

### Retention
`KEEP_LAST` (default 14) newest backups are kept on this server and, with an
off-box copy, in the site's remote folder; older ones are pruned automatically.

## Email alerts

**/admin → Email alerts** sends you an email when something fails, so a
broken backup is not discovered on the day you need it. Nothing is sent while
all is well, and nothing at all until you set it up.

### What sends an email

One email per failure, from the site that failed:

| What failed | Subject (`[featherspress <name>] … on <server>`) |
|---|---|
| a nightly or "Back up now" backup | Backup failed |
| the off-box copy (the local backup was still made) | Backup failed, "kept on this server only" |
| the nightly update check | Update check failed |
| Apply now, or an automatic apply | Update failed / Update failed and was rolled back / … and the site did not come back |
| a restore | Restore failed / Restore failed and was rolled back |

The body says what failed and when, the last lines the job logged, and the
site's /admin address (from `url` in `site.json`).

### Setting it up

Fill in where alerts go and how to send them, then press **Send test email**:
it saves, sends one straight away, and shows either success or the mail
server's own error. The password is never shown again; the field says one is
saved, and leaving it empty keeps it. **Turn off alerts** removes the settings.

- **An email account (SMTP)** works everywhere, including a server with no
  mail software. For **Gmail**: mail server `smtp.gmail.com`, port `587`,
  security **STARTTLS**, your Gmail address as username, and a Google **app
  password** as the password (Google Account → Security → 2-Step Verification
  → App passwords; it needs 2-Step Verification on). Your normal Gmail
  password will not work. Other providers: their SMTP server, usually port 587
  with STARTTLS or 465 with SSL/TLS. "None" is only for a mail server on the
  same machine; it sends the password unencrypted.
- **This server's own mail (sendmail)** is offered only when
  `/usr/sbin/sendmail` exists (postfix, exim, msmtp-mta, ...), and uses
  whatever that is set up to do. Its test email is sent by the root backup
  agent rather than the site itself: postfix and exim need privileges the
  site's sandbox does not give it.

The settings live in `/var/lib/featherspress/<name>/notify.json` (0600, the
site user's). A **full** backup carries them in its Credentials section, so a
restore that includes Credentials brings alerts back; older backups without
them restore as before and leave the current settings alone.

### How it works

`tools/notify.js` is the one sender. The app uses it for the test email; the
root jobs (`deploy/backup.sh`, `deploy/update.sh`, the restore agent) pipe the
details into it when they fail:

```sh
echo "what went wrong" | sudo /opt/node/bin/node /opt/featherspress/blog/tools/notify.js --subject "Backup failed"
```

It reads only that site's own `notify.json` (never through a symlink, every
field checked), gives up after 20 seconds, and always exits 0: an alert that
cannot be sent is logged in the job's journal (`[notify] could not send ...`)
and the failure is recorded exactly as before. Check what it did with:

```sh
journalctl -u 'featherspress-backup@blog' -u 'featherspress-update@blog' --since -7d | grep notify
```

### Without email

Everything above also shows in /admin, and in systemd:

```sh
systemctl is-failed 'featherspress-backup@*'
systemctl list-timers 'featherspress-backup@*'
journalctl -u 'featherspress-backup@*' --since -7d | grep -iE 'refus|error'
```

If you already have a systemd notifier, `OnFailure=` still works alongside
(the unit files ship with it commented out, because systemd silently ignores
one naming a unit that is not installed). Add it with a drop-in so
re-installing the templates keeps it:

```sh
for u in featherspress-backup@ featherspress-update@; do
  sudo mkdir -p /etc/systemd/system/$u.service.d
  printf '[Unit]\nOnFailure=status-email@%%n.service\n' |
    sudo tee /etc/systemd/system/$u.service.d/notify.conf
done
sudo systemctl daemon-reload
```

## If your media ever gets large

Full-tar-every-run + keep-last-N is ideal while media is small (the common case).
If `media/` ever grows past a few GB, switch the media portion to `rclone sync`
(dedup) and tar only `content/ + site.json + skin + favicon (+ auth)`. Until
then, keep it simple.

## Restoring from /admin (the usual way)

You do not need SSH for a normal restore.

### A backup on this server

**Backup & Restore → Backups on this server** lists this site's backups,
newest first: when, size, the engine that took it, encrypted or not.

- **Download** saves the file exactly as stored (still encrypted if it was).
- **Restore** picks it for the Restore form below: paste your age private key
  if it is encrypted, tick the sections, type `RESTORE`. If another engine
  version took the backup the form says so; that is fine, it restores the same.

### An archive from elsewhere

1. **Export** an archive from the old site ("Migrate this site" = everything),
   or fetch an off-box copy: `sudo rclone copy offsite:my-bucket/featherspress/blog/<file> .`
2. On the new box, add the site and create a login (steps 3 and 4 of
   [DEPLOY.md](DEPLOY.md)), then sign in to `/admin`.
3. **Restore**: choose the file, paste your age private key if it is `.age`,
   tick the sections to bring back, type `RESTORE` to confirm.

### What happens

The app never restores anything itself. A backup from the list is named in the
request by its bare file name; the root agent checks it matches the backup
naming pattern and is a regular file in this site's own backup folder, and
never deletes it. An encrypted backup, or an upload, is decrypted by the app
into a staging folder first (the key is piped to `age`, never written to disk
or put in the request): root has no key. The
ROOT agent snapshots your current site, restores the requested sections, applies
any `settings.json` through the same whitelist the backup panel uses, restarts
the service, and checks that `/healthz` AND the home page both respond. **If the
restored site does not come up, the snapshot is put back automatically.**

Two things to expect:

- The restart **signs you out** — sessions live in memory. That is normal.
- If you restore **Credentials**, your password and 2FA become the ones from the
  site the archive came from. Sign back in with *those*.

Selective restore is available from the CLI too:

    $FP import $ENVF <artifact> --force --sections content,media

Omitting `--sections` restores everything the archive carries, as before. The
step-by-step checklist for rebuilding a whole site on a new server is
[Rebuild a site from a backup](DEPLOY.md#rebuild-a-site-from-a-backup).

### Choosing what the scheduled backup captures

The **What to back up** checkboxes set `BACKUP_SECTIONS` in `backup.env`. A scope
that omits `content` or `credentials` cannot fully restore the site, and those
artifacts still count against `KEEP_LAST` — so a narrow scope will prune complete
backups out. The panel warns about both.
