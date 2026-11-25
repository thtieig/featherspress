# Deploying Featherspress

> **This is one example way to self-host**: Apache + systemd on a Debian box.
> The engine is just a Node process on localhost, so any reverse proxy and any
> process manager work too. Adapt as you like.

Every site on a server is a **named instance**, even when there is only one.
Each instance has its own code checkout, data, config, port, system user and
systemd units, so several sites can share one server without touching each
other. The only shared pieces are the Node runtime in `/opt/node` and Apache.
Adding a site is: pick a name, a port and a domain, run one script.

## The layout

For an instance called `<name>`:

```
/opt/node                              Node runtime, shared by every site
/opt/featherspress/<name>/             the site's own git checkout (code only)
/var/lib/featherspress/<name>/         its DATA, treat it like a database:
    site.json  content/  media/  skins/  favicon/
    auth-config.json                   password hash + 2FA secret
    *-status.json, *-request.json      how /admin talks to the root agents
/etc/featherspress/<name>/
    featherspress.env                  PORT, SESSION_SECRET, SITE_PACKAGE
    backup.env                         backup destination, retention, key
    update.conf                        AUTO_APPLY, REPO_REF
/var/backups/featherspress/<name>/     nightly backups, always kept here; root
                                       writes them, the site may read them
                                       (the /admin backups list)
user fp-<name>                         runs the site; owns its code and data
featherspress@<name>.service           the site
featherspress-backup@<name>.timer      nightly backup
featherspress-update@<name>.timer      nightly update check
featherspress-{backup,update}-control@<name>.{path,timer}
                                       the root agents behind /admin's
                                       Backup, Restore and Apply now buttons
/etc/apache2/sites-available/featherspress-<name>.conf
```

The unit files in `deploy/` are systemd templates (`featherspress@.service`
and friends); `%i` is the instance name.

## 1. Packages

```sh
sudo apt update
sudo apt install -y git curl ca-certificates xz-utils openssl sudo apache2 age
```

`git` is needed for updates, `age` for encrypted backups. For off-box backups
you will also want rclone (see [BACKUP-IMPORT-EXPORT.md](BACKUP-IMPORT-EXPORT.md)).

## 2. Node (once per server)

Get a copy of the repo anywhere, and install Node from it:

```sh
sudo git clone https://github.com/thtieig/featherspress.git /root/featherspress
sudo /root/featherspress/tools/install-node.sh /opt/node
```

It installs the newest release of the major version in `.nvmrc`, checked
against nodejs.org's checksums. Run it again later to move to a newer release,
then `sudo systemctl restart 'featherspress@*'`.

## 3. Add a site

```sh
sudo /root/featherspress/deploy/add-instance.sh blog blog.example.org 8801
sudo apache2ctl configtest && sudo systemctl reload apache2
```

Name, domain, port: the name is lowercase letters, digits and dashes (24 at
most); give every site its own port. Two optional extra arguments pick the
repo and the branch (default: this repo, `main`).

The script creates the user, the directories, a fresh clone with its
dependencies, the three config files (with a new random `SESSION_SECRET`), and
the Apache vhost, then starts the site and all its timers. It refuses a port or
domain another instance already uses. Running it again is safe: it keeps the
existing checkout, config and login. `RELOAD_APACHE=1` makes it reload Apache
for you.

## 4. Admin login, or restore

A new site needs a login (password + 2FA):

```sh
sudo -u fp-blog env SITE_PACKAGE=/var/lib/featherspress/blog \
  /opt/node/bin/node /opt/featherspress/blog/setup.js
```

Scan the QR code with an authenticator app and **save the recovery codes**:
they are shown once. `setup.js` reads the password from stdin, so a script can
pipe it in; capture the output then, because it holds the 2FA key.

Moving an existing site here instead? Create a login anyway (you need one to
reach `/admin`), then follow [Rebuild a site from a backup](#rebuild-a-site-from-a-backup).

## 5. HTTPS

```sh
sudo a2enmod ssl proxy proxy_http headers rewrite
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d blog.example.org
```

certbot copies the site's vhost into an HTTPS one and makes the plain one
redirect. Nothing else to edit: the vhost tells the engine which scheme the
browser used.

**Behind Cloudflare:** use SSL mode *Full (strict)* with the certificate above.
If certbot's check fails while the DNS record is proxied (orange cloud), set it
to *DNS only* for the first run, then switch the proxy back on. If you use
*Flexible* instead (Cloudflare talks plain HTTP to this box), change
`X-Forwarded-Proto` in the vhost to `"https"`.

## 6. Check it

```sh
curl -s http://127.0.0.1:8801/ | grep -o '<title>[^<]*</title>'                    # the site itself
curl -s -H 'Host: blog.example.org' http://127.0.0.1/ | grep -o '<title>[^<]*</title>'  # through Apache
systemctl list-units 'featherspress*@blog*'
```

Then in a browser: the home page, a post, an image under `/media/`, and
`/admin` (sign in, save a draft, delete it).

## Backups

Each site backs itself up every night at 00:20 to
`/var/backups/featherspress/<name>`, keeping 14. **/admin → Backup & Restore**
lists those backups (Download, or Restore one) and sets the time, retention and
whether a copy also goes off the box through rclone (S3, SFTP, ...). The local
copy is always kept: it is what the list restores from; the off-box copy is
for a lost server. Each site's off-box copies go into its own folder under the
remote path you give (`.../featherspress/<name>`), so sites sharing a remote
never prune each other's. Press **Set up encryption** there too, and keep the
private key it shows you somewhere off the server. Details, including S3 and
SFTP examples: [BACKUP-IMPORT-EXPORT.md](BACKUP-IMPORT-EXPORT.md).

```sh
systemctl list-timers 'featherspress-backup@*'
sudo systemctl start featherspress-backup@blog.service      # one now
sudo ls -l /var/backups/featherspress/blog
```

### Upgrading a server set up before the backups list

Older installs made the backup folders root-only, so /admin says it cannot
read them. Open each site's folder to its own user (or re-run `add-instance.sh`
with the site's name, domain and port, which does the same):

```sh
sudo chmod 711 /var/backups/featherspress
sudo chgrp fp-blog /var/backups/featherspress/blog
sudo chmod 750 /var/backups/featherspress/blog
```

Backups already there become readable at the next backup run. If an off-box
path already ended in the site's name (`s3:bucket/featherspress/blog`), set it
to the base (`s3:bucket/featherspress`): the name is now added for you.

## Updates

Each site checks for engine updates every night and only tells you: `/admin`
shows "update available" with an **Apply now** button. Apply now pulls the new
code into that site's checkout, reinstalls dependencies, restarts that site,
checks it renders, and rolls back if it does not. Other sites are not touched;
each one updates on its own.

By hand, the same thing:

```sh
sudo env AUTO_APPLY=1 /opt/featherspress/blog/deploy/update.sh
```

Set `AUTO_APPLY=1` in `/etc/featherspress/<name>/update.conf` to apply updates
automatically, and `REPO_REF` to follow another branch. Automatic is
convenient, but a bad upstream commit then runs within a day, so choose it per
site, knowingly.

The systemd templates in `/etc/systemd/system` are shared by all sites. If an
update changes `deploy/featherspress*@.*`, copy them in again:

```sh
sudo install -m 644 /opt/featherspress/blog/deploy/featherspress*@.* /etc/systemd/system/
sudo systemctl daemon-reload
```

## Rebuild a site from a backup

The checklist for a dead server, or for moving a site to a new one. You need
the backup (`featherspress-full-*.tar.gz.age`) and its age private key. With an
off-box copy, fetch the newest one from any machine with that rclone remote:
`rclone copy offsite:my-bucket/featherspress/blog/<file> .`
(`rclone ls offsite:my-bucket/featherspress/blog` lists them). To go back to
an earlier state on a server that still works, you need none of this: pick
the backup in **Backups on this server** and press Restore.

1. **New server:** Debian, with the packages from step 1.
2. **Node:** step 2.
3. **Add the site:** step 3, with the same name and domain (any free port).
4. **Temporary login:** step 4's `setup.js`, so you can reach `/admin`.
5. **Restore:** sign in to `/admin`. Before DNS points here, reach the new
   server by adding `<new-ip> blog.example.org` to your computer's hosts
   file. **Backup & Restore → Restore**: choose the
   `.age` file, paste the age private key, tick every section, type `RESTORE`.
   The site restarts and signs you out; sign back in with the **old** site's
   password and 2FA. Its backup schedule, retention and encryption key come
   back too.

   Without `/admin`, one command does the same (decrypt on the machine that
   holds the key, copy `restore.tar.gz` to the server first):

   ```sh
   sudo /opt/node/bin/node /opt/featherspress/blog/tools/site-package.js import \
     --env-file /etc/featherspress/blog/featherspress.env /root/restore.tar.gz \
     --force --restore-auth && sudo systemctl restart featherspress@blog
   ```

   Then delete `/root/restore.tar.gz` and the `/tmp/featherspress-prerestore-*`
   snapshot: both hold your credentials. This route does not bring the backup
   settings back; set them in `/admin`.
6. **HTTPS:** if you saved the old server's `/etc/letsencrypt`, copy it back
   and run `sudo certbot install --apache --cert-name blog.example.org`.
   Otherwise run step 5 for a new certificate (after DNS points here).
7. **DNS:** point the domain at the new server.
8. **Confirm the next nightly backup:** `systemctl list-timers
   'featherspress-backup@blog*'` shows it scheduled, and the next morning
   `/admin → Backup & Restore` shows a successful last run (or
   `sudo ls /var/backups/featherspress/blog`).

## Account recovery

- **Forgot the password, still have 2FA:**
  ```sh
  sudo -u fp-blog env SITE_PACKAGE=/var/lib/featherspress/blog \
    /opt/node/bin/node /opt/featherspress/blog/setup.js --password-only
  sudo systemctl restart featherspress@blog
  ```
  The restart matters: sessions live in memory, so it also signs out any
  session using the old password.
- **Lost the 2FA device, have a recovery code:** use it instead of the 6-digit
  code (each works once). Re-run `setup.js` for a fresh set.
- **Lost everything:** re-run step 4's `setup.js` (new password, 2FA and
  recovery codes), then restart the site. SSH is the root of trust.

## Remove a site

```sh
sudo /root/featherspress/deploy/remove-instance.sh blog
sudo systemctl reload apache2
```

It stops the site's units and removes its code, config and vhost. Its data,
backups and `fp-blog` user stay until you delete them yourself.

## Good to know

- **Media** uploaded in `/admin` lands in `/var/lib/featherspress/<name>/media/`
  and Apache serves it straight from disk. Uploads are capped at 25 MB and
  checked by content; SVG is refused (it can carry scripts).
- **The code is not backed up**: it comes back from git. `featherspress.env`
  is not precious either: a new `SESSION_SECRET` only signs everyone out.
- **Failure alerts** are not set up by default; see "Failure notifications" in
  [BACKUP-IMPORT-EXPORT.md](BACKUP-IMPORT-EXPORT.md).
