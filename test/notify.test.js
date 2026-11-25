"use strict";

// tools/notify.js, the one failure-email sender, and the root-side scripts
// that call it. A tiny SMTP sink runs in this process, so every "email" here
// is a real SMTP conversation; the scripts run as child processes (async, so
// the sink can answer them).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const NOTIFY = path.join(ROOT, "tools", "notify.js");
const notify = require("../tools/notify");

// ---- an SMTP sink ------------------------------------------------------------
// Speaks just enough SMTP for nodemailer: EHLO, AUTH (always accepted), MAIL,
// RCPT, DATA. No STARTTLS, so "STARTTLS required" is a real failure against it.
function smtpSink() {
  const messages = [];
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    let inData = false;
    let msg = { from: null, to: [], auth: null, data: "" };
    sock.write("220 sink ESMTP\r\n");
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(msg);
            msg = { from: null, to: [], auth: null, data: "" };
            sock.write("250 queued\r\n");
          } else msg.data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd === "HELO") sock.write("250 sink\r\n");
        else if (cmd === "AUTH") {
          msg.auth = Buffer.from(line.split(" ")[2] || "", "base64").toString("utf8").split("\0").slice(1);
          sock.write("235 ok\r\n");
        } else if (cmd === "MAIL") {
          msg.from = line;
          sock.write("250 ok\r\n");
        } else if (cmd === "RCPT") {
          msg.to.push(line);
          sock.write("250 ok\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          sock.write("354 go on\r\n");
        } else if (cmd === "STAR") sock.write("502 no TLS here\r\n");
        else if (cmd === "QUIT") sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, messages, close: () => server.close() }));
  });
}

// The message as a reader sees it: folded headers unfolded, quoted-printable
// soft breaks and escapes undone.
function readable(data) {
  const cut = data.indexOf("\n\n");
  const head = data.slice(0, cut).replace(/\n[ \t]+/g, " ");
  const body = data.slice(cut).replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return head + body;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fp-notify-"));
}

function smtpConfig(port, over = {}) {
  return {
    to: "owner@example.com",
    from: "alerts@example.com",
    method: "smtp",
    smtp: { host: "127.0.0.1", port, security: "none", user: "", pass: "", ...over },
  };
}

function writeConfig(dir, cfg) {
  const p = path.join(dir, "notify.json");
  fs.writeFileSync(p, JSON.stringify(cfg), { mode: 0o600 });
  return p;
}

// Run a command with stdin, async, so the sink in this process can answer it.
function runAsync(cmd, args, { input = "", env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000 },
      (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

const cli = (args, opts) => runAsync(process.execPath, [NOTIFY, ...args], opts);

// ---- validating the config -----------------------------------------------------

test("validateConfig accepts an SMTP account and keeps only known fields", () => {
  const v = notify.validateConfig({
    to: "owner@example.com", from: "", method: "smtp", extra: "dropped",
    smtp: { host: "smtp.example.com", port: 587, security: "starttls", user: "alerts@example.com", pass: "PLACEHOLDER-APP-PASSWORD", tls: { x: 1 } },
  }, { sendmailExists: false });
  assert.strictEqual(v.ok, true, v.error);
  assert.deepStrictEqual(v.config, {
    to: "owner@example.com", from: null, method: "smtp",
    smtp: { host: "smtp.example.com", port: 587, security: "starttls", user: "alerts@example.com", pass: "PLACEHOLDER-APP-PASSWORD" },
  });
});

test("validateConfig refuses what it cannot safely hand to a mailer", () => {
  const good = smtpConfig(587);
  const bad = [
    [{ ...good, to: "" }, /address alerts go to/],
    [{ ...good, to: "-oQ/tmp/x@example.com" }, /address alerts go to/],
    [{ ...good, to: "a@b.com, c@d.com" }, /address alerts go to/],
    [{ ...good, from: "not an address" }, /From address/],
    [{ ...good, method: "pigeon" }, /how to send/],
    [{ ...good, smtp: { ...good.smtp, host: "" } }, /mail server/],
    [{ ...good, smtp: { ...good.smtp, host: "evil.com\r\nRCPT" } }, /mail server/],
    [{ ...good, smtp: { ...good.smtp, port: 0 } }, /port/],
    [{ ...good, smtp: { ...good.smtp, port: "587" } }, /port/],
    [{ ...good, smtp: { ...good.smtp, security: "maybe" } }, /security/],
    [{ ...good, smtp: { ...good.smtp, user: "me\nRCPT" } }, /username/],
    [{ ...good, smtp: { ...good.smtp, user: "", pass: "PLACEHOLDER-PASS-3" } }, /username/],
    [null, /settings/],
  ];
  for (const [cfg, re] of bad) {
    const v = notify.validateConfig(cfg, { sendmailExists: true });
    assert.strictEqual(v.ok, false, JSON.stringify(cfg));
    assert.match(v.error, re, JSON.stringify(cfg));
  }
});

test("validateConfig offers sendmail only where /usr/sbin/sendmail exists", () => {
  const cfg = { to: "owner@example.com", method: "sendmail" };
  assert.match(notify.validateConfig(cfg, { sendmailExists: false }).error, /sendmail/);
  const v = notify.validateConfig(cfg, { sendmailExists: true });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.config, { to: "owner@example.com", from: null, method: "sendmail" });
});

test("transportOptions maps the security choice and always sets short timeouts", () => {
  const base = { to: "o@example.com", from: null, method: "smtp" };
  const t = (security, user = "u", pass = "p") =>
    notify.transportOptions({ ...base, smtp: { host: "h.example", port: 25, security, user, pass } }, 20000);
  assert.strictEqual(t("tls").secure, true);
  assert.strictEqual(t("starttls").secure, false);
  assert.strictEqual(t("starttls").requireTLS, true);
  assert.strictEqual(t("none").ignoreTLS, true);
  assert.deepStrictEqual(t("tls").auth, { user: "u", pass: "p" });
  assert.strictEqual(t("none", "", "").auth, undefined, "no username: no login");
  for (const k of ["connectionTimeout", "greetingTimeout", "socketTimeout", "dnsTimeout"]) assert.strictEqual(t("tls")[k], 20000);
  const sm = notify.transportOptions({ ...base, method: "sendmail" }, 20000);
  assert.deepStrictEqual(sm, { sendmail: true, path: "/usr/sbin/sendmail", newline: "unix" });
});

test("message: the subject names the site and the server, the body says when and where to look", () => {
  const m = notify.composeMessage(
    { subject: "Backup failed", text: "the off-box copy failed\n" },
    { instance: "alpha", host: "box1", adminUrl: "https://blog.example.com/admin/", at: new Date("2026-11-25T10:00:00Z") }
  );
  assert.strictEqual(m.subject, "[featherspress alpha] Backup failed on box1");
  assert.match(m.text, /^the off-box copy failed\n/);
  assert.match(m.text, /When: .*25 Nov 2026 10:00:00/);
  assert.match(m.text, /Server: box1/);
  assert.match(m.text, /https:\/\/blog\.example\.com\/admin\//);
  const one = notify.composeMessage({ subject: "x\r\nBcc: evil@example.com", text: "" }, { instance: "a", host: "h" });
  assert.doesNotMatch(one.subject, /[\r\n]/);
});

test("loadConfig: missing is null, a symlink or junk is refused", () => {
  const dir = tmp();
  try {
    assert.strictEqual(notify.loadConfig(path.join(dir, "notify.json")), null);
    const real = writeConfig(dir, smtpConfig(25));
    const link = path.join(dir, "link.json");
    fs.symlinkSync(real, link);
    assert.match(notify.loadConfig(link).error, /cannot be read/);
    fs.writeFileSync(path.join(dir, "junk.json"), "{nope");
    assert.match(notify.loadConfig(path.join(dir, "junk.json")).error, /cannot be read/);
    assert.strictEqual(notify.loadConfig(real).config.smtp.port, 25);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- sending ---------------------------------------------------------------------

test("sendMail delivers over SMTP, logging in when a username is set", async () => {
  const sink = await smtpSink();
  try {
    const cfg = notify.validateConfig(smtpConfig(sink.port, { user: "me", pass: "PLACEHOLDER-PASS-1" })).config;
    await notify.sendMail(cfg, { subject: "Hello", text: "body text" });
    assert.strictEqual(sink.messages.length, 1);
    const [m] = sink.messages;
    assert.deepStrictEqual(m.auth, ["me", "PLACEHOLDER-PASS-1"]);
    assert.match(m.from, /alerts@example\.com/);
    assert.match(m.to[0], /owner@example\.com/);
    assert.match(m.data, /^Subject: Hello$/m);
    assert.match(readable(m.data), /body text/);
  } finally {
    sink.close();
  }
});

test("sendMail reports the server's refusal as an error the test button can show", async () => {
  const sink = await smtpSink();
  try {
    const cfg = notify.validateConfig(smtpConfig(sink.port, { security: "starttls" })).config;
    await assert.rejects(notify.sendMail(cfg, { subject: "x", text: "y" }), /STARTTLS/i);
    assert.strictEqual(sink.messages.length, 0);
  } finally {
    sink.close();
  }
});

test("sendMail gives up on a server that never answers", async () => {
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  try {
    const cfg = notify.validateConfig(smtpConfig(silent.address().port)).config;
    const t0 = Date.now();
    await assert.rejects(notify.sendMail(cfg, { subject: "x", text: "y" }, { timeoutMs: 1000 }), /time|never received/i);
    assert.ok(Date.now() - t0 < 8000, "must not hang");
  } finally {
    silent.close();
  }
});

// ---- the CLI the root scripts call -----------------------------------------

test("CLI: sends one email with the subject, the body from stdin and the admin link", async () => {
  const sink = await smtpSink();
  const dir = tmp();
  try {
    const cfgPath = writeConfig(dir, smtpConfig(sink.port));
    fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify({ url: "https://blog.example.com" }));
    const r = await cli(["--subject", "Backup failed"], {
      input: "The backup failed: the off-box copy failed.\n",
      env: { INSTANCE: "alpha", DATA_DIR: dir, NOTIFY_CONFIG: cfgPath },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(sink.messages.length, 1);
    const text = readable(sink.messages[0].data);
    assert.match(text, new RegExp(`^Subject: \\[featherspress alpha\\] Backup failed on ${os.hostname()}$`, "m"));
    assert.match(text, /the off-box copy failed/);
    assert.match(text, /https:\/\/blog\.example\.com\/admin\//);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: not set up means nothing is sent and the caller carries on", async () => {
  const dir = tmp();
  try {
    const r = await cli(["--subject", "Backup failed"], { input: "x", env: { INSTANCE: "alpha", DATA_DIR: dir, NOTIFY_CONFIG: "" } });
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not set up/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a mail server that refuses still exits 0, and says why in the log", async () => {
  const dir = tmp();
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  closed.close();
  try {
    const cfgPath = writeConfig(dir, smtpConfig(port, { user: "me", pass: "PLACEHOLDER-DO-NOT-LOG" }));
    const r = await cli(["--subject", "Backup failed"], { input: "x", env: { INSTANCE: "alpha", DATA_DIR: dir, NOTIFY_CONFIG: cfgPath } });
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /could not send/);
    assert.match(r.stderr, /ECONNREFUSED/);
    assert.doesNotMatch(r.stderr + r.stdout, /PLACEHOLDER-DO-NOT-LOG/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: an invalid notify.json is logged, not sent, and still exits 0", async () => {
  const dir = tmp();
  try {
    const cfgPath = writeConfig(dir, { to: "-x@example.com", method: "smtp" });
    const r = await cli(["--subject", "Backup failed"], { input: "x", env: { INSTANCE: "alpha", DATA_DIR: dir, NOTIFY_CONFIG: cfgPath } });
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /not valid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- deploy/backup.sh: one email per failed run ----------------------------------

const BACKUP_SH = path.join(ROOT, "deploy", "backup.sh");

// A throwaway site and backup.env, and backup.sh run with its outputs moved
// into the temp dir. Mail goes to the sink when `port` is given.
function backupSite(backupEnv) {
  const dir = tmp();
  const pkg = path.join(dir, "site");
  fs.mkdirSync(path.join(pkg, "content", "posts"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "content", "posts", "hello.md"), "---\ntitle: Hi\n---\nhi\n");
  fs.writeFileSync(path.join(dir, "featherspress.env"), `SITE_PACKAGE=${pkg}\n`);
  fs.writeFileSync(path.join(dir, "backup.env"), backupEnv.join("\n") + "\n");
  return dir;
}

function runBackup(dir, { port, env = {} } = {}) {
  const notifyCfg = port ? writeConfig(dir, smtpConfig(port)) : path.join(dir, "no-notify.json");
  return runAsync("bash", [BACKUP_SH], {
    env: {
      INSTANCE: "alpha",
      DATA_DIR: dir,
      FP_ENV: path.join(dir, "featherspress.env"),
      BACKUP_ENV: path.join(dir, "backup.env"),
      BACKUP_LOCK: path.join(dir, "backup.lock"),
      LAST_RUN_FILE: path.join(dir, "last-run.json"),
      BACKUP_STATUS: path.join(dir, "backup-status.json"),
      SCHEDULE_DROPIN: path.join(dir, "schedule.conf"),
      UPDATE_CONF: path.join(dir, "no-update.conf"),
      BACKUP_ROOT: path.join(dir, "backups"),
      ENGINE_DIR: ROOT,
      NODE_BIN: process.execPath,
      NOTIFY_CONFIG: notifyCfg,
      CONTENT_DIR: "",
      MEDIA_DIR: "",
      SITE_MANIFEST: "",
      ...env,
    },
  });
}

const lastRun = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "last-run.json"), "utf8"));

test("backup.sh: a failed run sends one email saying why", async () => {
  const sink = await smtpSink();
  const dir = backupSite(["DEST_TYPE=local", "KEEP_LAST=0"]);
  try {
    const r = await runBackup(dir, { port: sink.port });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.strictEqual(sink.messages.length, 1, r.stderr);
    const text = readable(sink.messages[0].data);
    assert.match(text, /^Subject: \[featherspress alpha\] Backup failed on /m);
    assert.match(text, /KEEP_LAST must be at least 1/);
    assert.match(text, /\[backup\] refusing/, "the log tail is in the body");
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh: a failed off-box copy sends one email, and the local backup is still made", async () => {
  const sink = await smtpSink();
  const recipient = require("node:child_process")
    .execFileSync("age-keygen", [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .match(/public key:\s*(age1[0-9a-z]+)/)[1];
  const dir = backupSite(["DEST_TYPE=rclone", "RCLONE_REMOTE=offsite:bucket", "KEEP_LAST=2", `AGE_RECIPIENT=${recipient}`]);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "rclone"), '#!/bin/sh\necho "Failed to copy: access denied" >&2\nexit 1\n', { mode: 0o755 });
  try {
    const r = await runBackup(dir, { port: sink.port, env: { PATH: bin + path.delimiter + process.env.PATH } });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(fs.readdirSync(path.join(dir, "backups")).length, 1, "kept on this server");
    assert.strictEqual(sink.messages.length, 1, r.stderr);
    const text = readable(sink.messages[0].data);
    assert.match(text, /off-box copy failed; this backup is kept on this server only/);
    assert.match(text, /access denied/, "rclone's own words are in the log tail");
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh: a good run sends nothing", async () => {
  const sink = await smtpSink();
  const dir = backupSite(["DEST_TYPE=local", "KEEP_LAST=3"]);
  try {
    const r = await runBackup(dir, { port: sink.port });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(sink.messages.length, 0);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh: with alerts not set up, or a mail server that refuses, the failure is recorded the same", async () => {
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const deadPort = closed.address().port;
  closed.close();
  for (const port of [undefined, deadPort]) {
    const dir = backupSite(["DEST_TYPE=local", "KEEP_LAST=0"]);
    try {
      const r = await runBackup(dir, { port });
      assert.strictEqual(r.status, 1);
      assert.strictEqual(lastRun(dir).ok, false);
      assert.match(lastRun(dir).error, /KEEP_LAST/);
      assert.match(r.stderr, port ? /could not send/ : /not set up/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---- deploy/update.sh: one email per failed check, apply or rollback -------------

const UPDATE_SH = path.join(ROOT, "deploy", "update.sh");
const gitq = (cwd, ...args) =>
  require("node:child_process").execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

// origin has two commits; the site's checkout ("engine") sits one behind.
// systemctl and curl are stubbed (curl decides "healthy"), npm too (NPM_FAIL
// makes the install fail, which is how an apply goes wrong here).
function updateSite() {
  const dir = tmp();
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  gitq(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "1.0.0" }));
  gitq(seed, "add", ".");
  gitq(seed, "commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "1.0.1" }));
  gitq(seed, "commit", "-q", "-am", "two");
  gitq(dir, "clone", "-q", "--bare", seed, "origin.git");
  gitq(dir, "clone", "-q", path.join(dir, "origin.git"), "engine");
  gitq(path.join(dir, "engine"), "reset", "-q", "--hard", "HEAD~1");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), '#!/bin/sh\n[ -n "$NPM_FAIL" ] && [ ! -f "$NPM_FAIL" ] && { touch "$NPM_FAIL"; echo "npm ERR! could not resolve" >&2; exit 1; }\nexit 0\n', { mode: 0o755 });
  return dir;
}

function runUpdate(dir, port, env = {}) {
  const base = { ...process.env };
  for (const k of ["AUTO_APPLY", "REPO_REF", "NODE_BIN", "NPM_BIN", "SERVICE", "FP_USER"]) delete base[k];
  fs.writeFileSync(path.join(dir, "update.conf"),
    `AUTO_APPLY=0\nREPO_REF=main\nNODE_BIN=${process.execPath}\nNPM_BIN=${path.join(dir, "bin", "npm")}\n`);
  return runAsync("bash", [UPDATE_SH], {
    env: {
      ...base,
      PATH: path.join(dir, "bin") + path.delimiter + process.env.PATH,
      INSTANCE: "alpha",
      DATA_DIR: dir,
      ENGINE_DIR: path.join(dir, "engine"),
      FP_ENV: path.join(dir, "no-such.env"),
      UPDATE_CONF: path.join(dir, "update.conf"),
      UPDATE_LOCK: path.join(dir, "update.lock"),
      UPDATE_STATUS_FILE: path.join(dir, "update-status.json"),
      NOTIFY_CONFIG: writeConfig(dir, smtpConfig(port)),
      ...env,
    },
  });
}

test("update.sh: an update that fails and is rolled back sends one email saying so", async () => {
  const sink = await smtpSink();
  const dir = updateSite();
  try {
    const r = await runUpdate(dir, sink.port, { AUTO_APPLY: "1", NPM_FAIL: path.join(dir, "npm-failed-once") });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /rolled back and healthy/);
    assert.strictEqual(sink.messages.length, 1, r.stderr);
    const text = readable(sink.messages[0].data);
    assert.match(text, /^Subject: \[featherspress alpha\] Update failed and was rolled back on /m);
    assert.match(text, /put back on the engine it had/);
    assert.match(text, /npm ERR! could not resolve/);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update.sh: an apply refused before it starts sends one email", async () => {
  const sink = await smtpSink();
  const dir = updateSite();
  try {
    fs.writeFileSync(path.join(dir, "engine", "local-edit.txt"), "x");
    const r = await runUpdate(dir, sink.port, { AUTO_APPLY: "1" });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(sink.messages.length, 1, r.stderr);
    const text = readable(sink.messages[0].data);
    assert.match(text, /^Subject: \[featherspress alpha\] Update failed on /m);
    assert.match(text, /uncommitted local changes/);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update.sh: a check that cannot reach the repository sends one email", async () => {
  const sink = await smtpSink();
  const dir = updateSite();
  try {
    fs.rmSync(path.join(dir, "origin.git"), { recursive: true, force: true });
    const r = await runUpdate(dir, sink.port);
    assert.notStrictEqual(r.status, 0);
    assert.strictEqual(sink.messages.length, 1, r.stderr);
    assert.match(readable(sink.messages[0].data), /^Subject: \[featherspress alpha\] Update check failed on /m);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update.sh: a check that finds an update, or a good apply, sends nothing", async () => {
  const sink = await smtpSink();
  const dir = updateSite();
  try {
    const check = await runUpdate(dir, sink.port);
    assert.strictEqual(check.status, 0, check.stderr);
    const apply = await runUpdate(dir, sink.port, { AUTO_APPLY: "1" });
    assert.strictEqual(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /applied and healthy/);
    assert.strictEqual(sink.messages.length, 0);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the restore agent: one email when a restore fails or is rolled back ---------

// The agent run as root runs it: `backup-control.js restore`, every path
// moved into a temp dir, systemctl/curl/sleep stubbed. CURL_FAILS names a file
// holding how many health checks still fail: 10 fails the restored site's
// check and lets the rollback's pass.
function restoreSite() {
  const dir = tmp();
  const live = path.join(dir, "live");
  fs.mkdirSync(path.join(live, "content", "posts"), { recursive: true });
  fs.mkdirSync(path.join(live, "media"), { recursive: true });
  fs.mkdirSync(path.join(live, "import-staging"));
  fs.writeFileSync(path.join(live, "content", "posts", "a.md"), "---\ntitle: A\n---\nA\n");
  fs.writeFileSync(path.join(live, "site.json"), JSON.stringify({ title: "Live", skin: "notepad" }));
  fs.writeFileSync(path.join(dir, "featherspress.env"),
    `CONTENT_DIR=${live}/content\nMEDIA_DIR=${live}/media\nSITE_MANIFEST=${live}/site.json\nAUTH_CONFIG=${live}/auth-config.json\nPORT=1\n`);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"),
    '#!/bin/sh\nn=$(cat "$CURL_FAILS" 2>/dev/null || echo 0)\n[ "$n" -gt 0 ] && { echo $((n - 1)) > "$CURL_FAILS"; exit 22; }\nexit 0\n',
    { mode: 0o755 });
  return { dir, live };
}

function runRestore({ dir, live }, port, request, env = {}) {
  fs.writeFileSync(path.join(live, "restore-request.json"), JSON.stringify(request), { mode: 0o600 });
  return runAsync(process.execPath, [path.join(ROOT, "tools", "backup-control.js"), "restore"], {
    env: {
      PATH: path.join(dir, "bin") + path.delimiter + process.env.PATH,
      TMPDIR: dir,
      INSTANCE: "alpha",
      DATA_DIR: live,
      BACKUP_ROOT: path.join(dir, "backups"),
      BACKUP_ENV: path.join(dir, "backup.env"),
      FP_ENV: path.join(dir, "featherspress.env"),
      SCHEDULE_DROPIN: path.join(dir, "schedule.conf"),
      UPDATE_CONF: path.join(dir, "update.conf"),
      NOTIFY_CONFIG: writeConfig(dir, smtpConfig(port)),
      ...env,
    },
  });
}

const restoreOutcome = (live) => JSON.parse(fs.readFileSync(path.join(live, "backup-status.json"), "utf8")).restore;

test("restore: a restore that fails sends one email with the reason", async () => {
  const sink = await smtpSink();
  const site = restoreSite();
  try {
    const r = await runRestore(site, sink.port, { requestId: 5, stagedName: "gone.tar.gz", sections: ["content"] });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(restoreOutcome(site.live).state, "failed");
    assert.strictEqual(sink.messages.length, 1, r.stderr);
    const text = readable(sink.messages[0].data);
    assert.match(text, /^Subject: \[featherspress alpha\] Restore failed on /m);
    assert.match(text, /staged archive not found/);
  } finally {
    sink.close();
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
});

test("restore: a restore that is rolled back sends one email saying the old site was put back", async () => {
  const sink = await smtpSink();
  const site = restoreSite();
  try {
    const src = path.join(site.dir, "src");
    fs.mkdirSync(path.join(src, "content", "posts"), { recursive: true });
    fs.writeFileSync(path.join(src, "content", "posts", "b.md"), "---\ntitle: B\n---\nB\n");
    fs.writeFileSync(path.join(src, "site.json"), JSON.stringify({ title: "Other", skin: "notepad" }));
    require("../tools/site-package").exportPackage({
      contentDir: path.join(src, "content"), manifestPath: path.join(src, "site.json"),
      profile: "site", sections: ["content", "site"], outFile: path.join(site.live, "import-staging", "up.tar.gz"),
    });
    const fails = path.join(site.dir, "curl-fails");
    fs.writeFileSync(fails, "10");
    const r = await runRestore(site, sink.port, { requestId: 6, stagedName: "up.tar.gz", sections: ["content", "site"] },
      { CURL_FAILS: fails });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(restoreOutcome(site.live).state, "rolled-back");
    assert.strictEqual(sink.messages.length, 1, r.stderr);
    const text = readable(sink.messages[0].data);
    assert.match(text, /^Subject: \[featherspress alpha\] Restore failed and was rolled back on /m);
    assert.match(text, /previous site was put back/);
    assert.match(text, /content, site/);
  } finally {
    sink.close();
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
});

// ---- the test email for this server's own mail, sent by root -------------------

test("CLI --report prints whether it was sent, for the agent to pass on", async () => {
  const sink = await smtpSink();
  const dir = tmp();
  try {
    const cfgPath = writeConfig(dir, smtpConfig(sink.port));
    const ok = await cli(["--subject", "x", "--report"], { input: "y", env: { INSTANCE: "alpha", DATA_DIR: dir, NOTIFY_CONFIG: cfgPath } });
    assert.deepStrictEqual(JSON.parse(ok.stdout.trim().split("\n").pop()), { sent: true });
    sink.close();
    const bad = await cli(["--subject", "x", "--report"], { input: "y", env: { INSTANCE: "alpha", DATA_DIR: dir, NOTIFY_CONFIG: cfgPath } });
    assert.strictEqual(bad.status, 0);
    const r = JSON.parse(bad.stdout.trim().split("\n").pop());
    assert.strictEqual(r.sent, false);
    assert.match(r.error, /ECONNREFUSED/);
    const none = await cli(["--subject", "x", "--report"], { input: "y", env: { INSTANCE: "alpha", DATA_DIR: dir, NOTIFY_CONFIG: path.join(dir, "none.json") } });
    assert.match(JSON.parse(none.stdout.trim().split("\n").pop()).error, /not set up/);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup-control apply: a test-email request sends the test as root and records the outcome", async () => {
  const sink = await smtpSink();
  const dir = tmp();
  try {
    const status = path.join(dir, "backup-status.json");
    const run = (requestId) => {
      fs.writeFileSync(path.join(dir, "backup-request.json"), JSON.stringify({ requestId, action: "test-email" }), { mode: 0o600 });
      return runAsync(process.execPath, [path.join(ROOT, "tools", "backup-control.js"), "apply"], {
        env: {
          INSTANCE: "alpha", DATA_DIR: dir, BACKUP_ROOT: path.join(dir, "backups"),
          BACKUP_ENV: path.join(dir, "backup.env"), SCHEDULE_DROPIN: path.join(dir, "schedule.conf"),
          UPDATE_CONF: path.join(dir, "update.conf"), NOTIFY_CONFIG: writeConfig(dir, smtpConfig(sink.port)),
          PATH: process.env.PATH,
        },
      });
    };
    let r = await run(7);
    assert.strictEqual(r.status, 0, r.stderr);
    let st = JSON.parse(fs.readFileSync(status, "utf8"));
    assert.strictEqual(st.appliedRequestId, 7);
    assert.strictEqual(st.lastRequestOk, true, st.lastRequestError);
    assert.strictEqual(sink.messages.length, 1);
    assert.match(readable(sink.messages[0].data), /^Subject: \[featherspress alpha\] Email alerts work on /m);
    assert.strictEqual(fs.existsSync(path.join(dir, "backup-request.json")), false, "consumed");

    sink.close();
    r = await run(8);
    st = JSON.parse(fs.readFileSync(status, "utf8"));
    assert.strictEqual(st.lastRequestOk, false);
    assert.match(st.lastRequestError, /ECONNREFUSED/);
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
