# Deploying Featherspress

> **This is one example way to self-host**, using a common **Apache + systemd**
> stack on a single Linux box. Nothing here is required: the engine is just a
> Node process listening on localhost, so any reverse proxy (nginx, Caddy,
> Traefik), any process manager, and any host (a container, a PaaS, your laptop)
> work just as well. Adapt the paths, user, and proxy to your setup.

Featherspress is a single Node process that renders the blog on request (no
build step) and also serves `/admin`. In production it sits behind a reverse
proxy (Apache examples below) that serves `/media` straight off disk and proxies
everything else to the engine on localhost.

This is a **clean, isolated** setup: an unpacked Node runtime under `/opt/node`
(no distro Node packages), a dedicated non-root service user, and
content + media + secrets in a data dir **outside** the code. Nothing compiles
(all deps are pure JS), so there is no `build-essential` / `node-gyp` step.

## Layout on the server

```
/opt/node                     Node LTS runtime (symlink to the unpacked tarball)
/opt/featherspress            Engine CODE only (a git checkout; updatable)
/var/lib/featherspress/       DATA (treat like a database, and back it up):
    content/  posts/*.md, pages/*.md
    media/    uploaded images/attachments (served at /media/)
    site.json your site's manifest (identity, skin, nav, home mode)
    skins/    your per-site custom skin(s), if any
    favicon/  your per-site icons, if any
    auth-config.json          password hash + TOTP secret + recovery hashes
    update-status.json        written by the update timer; read by the admin UI
/etc/featherspress/featherspress.env       runtime config (paths, port, secret)
/etc/systemd/system/featherspress.service
```

## Requirements

- A reverse proxy. For Apache: `mod_proxy`, `mod_proxy_http`, `mod_headers`,
  `mod_rewrite`, `mod_ssl`.
- A TLS certificate for your domain (e.g. Let's Encrypt / certbot).
- No system Node needed, since you install your own under `/opt`.

## 0. Packages

A minimal cloud image has none of these. `git` is not optional: the update
timer needs a real checkout, not an unpacked tarball.

```sh
sudo apt update
sudo apt install -y git curl ca-certificates xz-utils apache2
# only if you will use the backup timer (see BACKUP-IMPORT-EXPORT.md):
sudo apt install -y age            # and rclone, for off-box destinations
```

## 1. Service user + directories

```sh
sudo useradd --system --home /var/lib/featherspress --shell /usr/sbin/nologin featherspress
sudo mkdir -p /opt/featherspress /var/lib/featherspress/content /var/lib/featherspress/media /etc/featherspress
sudo chown -R featherspress:featherspress /var/lib/featherspress
# Step 3 clones into /opt/featherspress AS the featherspress user, so that dir
# has to be writable by it — otherwise the clone dies on ".git: Permission denied".
sudo chown featherspress:featherspress /opt/featherspress
```

## 2. Isolated Node runtime

Pick the current LTS from <https://nodejs.org/dist/>:

```sh
NODE_VER=v24.18.0            # check the site for the latest LTS
cd /tmp
curl -fsSLO https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz
sudo tar -xJf node-$NODE_VER-linux-x64.tar.xz -C /opt
sudo ln -sfn /opt/node-$NODE_VER-linux-x64 /opt/node
/opt/node/bin/node -v
```

To upgrade Node later: unpack a new tarball, re-point the `/opt/node` symlink.

## 3. Ship the engine code (a git checkout)

Deploy the code as a **git clone** (this is what lets the update timer in
"Updates" below fast-forward it). Content/media/auth are gitignored, so the
checkout never collides with your data in `/var/lib/featherspress`.

```sh
sudo -u featherspress git clone https://github.com/you/featherspress.git /opt/featherspress
cd /opt/featherspress
sudo -u featherspress env PATH=/opt/node/bin:$PATH npm ci --omit=dev
sudo chown -R featherspress:featherspress /opt/featherspress
```

(`npm`'s shebang is `#!/usr/bin/env node`, so it needs `/opt/node/bin` on `PATH`
to find `node` — calling `node` directly, as elsewhere in this doc, doesn't
have this problem since there's no shebang involved.)

**Migrating an existing `git archive` install** (a code dir with no `.git`):
clone fresh alongside it, verify, then swap — and **pin the currently-deployed
commit first** so you don't silently jump to the tip of `main`:

```sh
DEPLOYED=<the commit sha you last shipped>     # from your release notes / CI
sudo -u featherspress git clone https://github.com/you/featherspress.git /opt/featherspress.new
cd /opt/featherspress.new
sudo -u featherspress git reset --hard "$DEPLOYED"    # match what's live, don't leap ahead
sudo -u featherspress env PATH=/opt/node/bin:$PATH npm ci --omit=dev
sudo chown -R featherspress:featherspress /opt/featherspress.new
# verify it boots (temp port), then swap and restart once:
sudo mv /opt/featherspress /opt/featherspress.old && sudo mv /opt/featherspress.new /opt/featherspress
sudo systemctl restart featherspress
```

## 4. Runtime config

```sh
sudo cp /opt/featherspress/deploy/featherspress.env.example /etc/featherspress/featherspress.env
sudo nano /etc/featherspress/featherspress.env
#   - set a real SESSION_SECRET:  openssl rand -hex 32
#   - confirm PORT (default 8787) matches the ProxyPass in the vhost
#   - set SITE_URL to your real origin (http://… if you are not terminating TLS here)
sudo chown root:featherspress /etc/featherspress/featherspress.env
sudo chmod 640 /etc/featherspress/featherspress.env
```

> **Quote any value containing a space** (`SITE_TITLE="My Blog"`). systemd reads
> this file literally, but `backup.sh` and `update.sh` `source` it with a shell,
> which would read a bare `SITE_TITLE=My Blog` as the assignment `SITE_TITLE=My`
> followed by the command `Blog` — and abort before doing any work.

## 5. Put your content in place

Your **Site Package** is the content. The engine ships the tool that installs
one — use it rather than copying directories by hand, so the package is
validated (renderable skin, no path escapes) and your icons and custom skin land
where the runtime looks for them:

```sh
cd /opt/featherspress
sudo -u featherspress env $(grep -E '^(CONTENT_DIR|MEDIA_DIR|AUTH_CONFIG|FAVICON_DIR)=' \
  /etc/featherspress/featherspress.env | xargs) \
  /opt/node/bin/node tools/site-package.js import /path/to/package --force
sudo chown -R featherspress:featherspress /var/lib/featherspress
```

`import` takes either a directory (raw converter output) or a `.tar.gz`. Coming
from WordPress? Build a package first; see
[MIGRATING-FROM-WORDPRESS.md](MIGRATING-FROM-WORDPRESS.md). The alternative is
to point `SITE_PACKAGE=/path/to/package` at a package and skip the data dir
entirely. Full details in [BACKUP-IMPORT-EXPORT.md](BACKUP-IMPORT-EXPORT.md).

If your package carries a `favicon/`, keep `FAVICON_DIR` set (step 4): `import`
writes the icons into the data dir, but the engine only *serves* them when
pointed there — otherwise you silently get the bundled placeholder icons.

`site.json` carries the site identity (title, tagline, nav, which skin, home
mode, `postsPath`). Set it once here; it is not edited from the admin UI.

## 6. Password + 2FA

```sh
cd /opt/featherspress
sudo -i                                            # the env file is root-readable only
set -a; . /etc/featherspress/featherspress.env; set +a
sudo -u featherspress --preserve-env=AUTH_CONFIG /opt/node/bin/node setup.js
```

Scan the QR with an authenticator app and **save the recovery codes** (shown
once). Enroll a second device too if you can.

`setup.js` reads the password from stdin, so an unattended build can pipe it —
but everything you must keep (TOTP secret, recovery codes) is only ever printed
to the terminal, so capture that output:

```sh
printf '%s\n' "$ADMIN_PASSWORD" | sudo -u featherspress \
  --preserve-env=AUTH_CONFIG /opt/node/bin/node setup.js | tee /root/setup-output.txt
```

`auth-config.json` holds your password hash and your **TOTP secret in
cleartext**. Check it is not group/world-readable, and tighten it if it is:

```sh
sudo chmod 600 /var/lib/featherspress/auth-config.json
```

## 7. Start the service (still private, on 127.0.0.1)

```sh
sudo cp /opt/featherspress/deploy/featherspress.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now featherspress
sudo systemctl status featherspress          # "active (running)"
```

It binds to `127.0.0.1:8787` only, so it is not yet reachable from the internet.

## 8. Verify before exposing it (via localhost)

```sh
for p in /healthz / /posts/ /favicon.ico; do
  curl -s -o /dev/null -w "%{http_code}  $p\n" http://127.0.0.1:8787$p
done
curl -s "http://127.0.0.1:8787/search?q=hello" | head -c 120; echo
```

All should be `200` (search returns JSON — `[]` is a fine answer if nothing
matches). Also fetch one real post and one real tag page from your own content,
not just the index pages: a missing custom skin or a bad `site.json` shows up
there first. Fix anything here before exposing the box.

## 9. Put a reverse proxy in front (Apache example)

The `deploy/apache/` vhosts are templates: replace `example.com`, point the
cert paths at your certificate, and merge any custom directives your existing
vhost has (logging, headers, IP rules).

**Terminating TLS on this box** (the usual case) — the `:80` vhost redirects to
`:443`, and the `-le-ssl` vhost does the proxying:

```sh
sudo a2enmod proxy proxy_http headers rewrite
sudo cp /opt/featherspress/deploy/apache/featherspress.conf        /etc/apache2/sites-available/
sudo cp /opt/featherspress/deploy/apache/featherspress-le-ssl.conf /etc/apache2/sites-available/
sudo a2ensite featherspress featherspress-le-ssl
sudo apache2ctl configtest        # "Syntax OK"
sudo systemctl reload apache2
```

**TLS terminated in front of you** (Cloudflare, a load balancer, a tunnel), or a
box that has no certificate yet — use the plain-HTTP vhost instead, which
carries the same proxy and `/media` config on `:80`:

```sh
sudo a2enmod proxy proxy_http headers rewrite
sudo cp /opt/featherspress/deploy/apache/featherspress-http.conf /etc/apache2/sites-available/
sudo a2dissite 000-default
sudo a2ensite featherspress-http
sudo apache2ctl configtest && sudo systemctl reload apache2
```

Then verify live: the home page, a real post, a tag page, `/posts/`, an image
under `/media/`, and `/admin` (sign in, create a test draft, preview, publish,
delete it). A `Cache-Control: public, max-age=…` header on a `/media` file
confirms Apache served it off disk instead of proxying it to Node.

## Day-to-day

Write at `https://your-domain/admin`. Saving publishes instantly (the engine
writes the `.md` and refreshes its in-memory list, with no build). Drafts save
privately and preview at `/admin/preview/…`; publish when ready.

**Backups / import / export:** `/var/lib/featherspress` is your data (plain
Markdown + files, no database). The engine ships a one-artifact backup +
import/export toolchain — a **Site Package** (`site.json` + `content/` + `media/`
+ your skin + favicon [+ credentials]) that `export`, `import`, and `backup` all
speak. See **[BACKUP-IMPORT-EXPORT.md](BACKUP-IMPORT-EXPORT.md)** for the full
guide; the short version:

```sh
# On a server, call the tool by absolute path (npm is not on sudo's PATH) and
# always pass --env-file, so it resolves YOUR data dir and not the bundled
# example-site inside the code dir:
FP="sudo -u featherspress /opt/node/bin/node /opt/featherspress/tools/site-package.js"
ENVF="--env-file /etc/featherspress/featherspress.env"

# one-off portable export (no credentials) — a shareable/movable Site Package:
$FP export $ENVF --out /tmp/site.tar.gz

# scheduled off-box backups (full, incl. credentials, age-encrypted to cloud):
sudo apt install -y age
sudo cp deploy/backup.env.example /etc/featherspress/backup.env   # then edit
sudo cp deploy/featherspress-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now featherspress-backup.timer
sudo systemctl start featherspress-backup.service     # run one now and check it

# restore (or migrate a whole site) from any artifact:
$FP import $ENVF /path/to/backup.tar.gz --force --restore-auth
sudo systemctl restart featherspress
```

The engine code itself is *not* backed up — it's recoverable from git.
`/etc/featherspress/featherspress.env` is disposable too (losing it just forces
everyone to re-log-in; regenerate `SESSION_SECRET`).

## Updates

A root systemd timer checks the git remote and writes `update-status.json` into
the data dir; the admin UI shows an "update available" banner. By default it
only notifies — you apply on your terms; set `AUTO_APPLY=1` for hands-off apply
(pull → reinstall → restart → health-check → auto-rollback on failure).

```sh
sudo cp deploy/update.conf.example /etc/featherspress/update.conf   # AUTO_APPLY=0 by default
sudo cp deploy/featherspress-update.{service,timer} /etc/systemd/system/
sudo systemctl enable --now featherspress-update.timer

# apply an update by hand (the default, notify-only workflow):
sudo /opt/featherspress/deploy/update.sh   # with AUTO_APPLY=1 to actually apply
```

Applying happens as root (the app can't write its own code dir or restart
itself — by design). `AUTO_APPLY=1` trades that safety step for convenience:
a compromised upstream commit would auto-run within a timer tick, so opt in
per box, knowingly.

## 2FA recovery

- Lost device but have a recovery code: use it in place of the 6-digit code
  (works once). Re-run `setup.js` to mint a fresh set when low.
- Lost everything: SSH in and re-run step 6 (`node setup.js`), then
  `sudo systemctl restart featherspress`. This rotates password + TOTP +
  recovery codes. SSH is the root of trust for this single-user tool.

## Media uploads

Uploaded via `/admin` to `/var/lib/featherspress/media/<YYYY>/<MM>/`, served at
`/media/`. Capped at 25 MB and validated by content, not extension. SVG is
rejected (it can carry scripts).
