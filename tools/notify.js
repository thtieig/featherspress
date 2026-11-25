"use strict";

// notify: the one sender of failure emails.
//
// The owner sets it up in /admin → Email alerts, which writes notify.json
// (0600, the site user's) into the site's data dir. Two ways to send:
//   smtp      a mail account: host, port, STARTTLS or SSL/TLS, login, From
//   sendmail  this server's own mail, only where /usr/sbin/sendmail exists
//
// Used two ways:
//   - as a library by the app, for the "Send test email" button;
//   - as a CLI by the root scripts and agents when something has failed
//     (deploy/backup.sh, deploy/update.sh, the restore in backup-control.js):
//
//       echo "what went wrong" | node tools/notify.js --subject "Backup failed"
//
//   --report adds one JSON line on stdout, {"sent":true} or {"sent":false,
//   "error":"..."}, for the root agent that sends the "this server's mail"
//   test email on the app's behalf (the site's sandbox keeps postfix and exim
//   from taking mail from it).
//
// The CLI never gets in the way of the failure it reports: not set up means
// nothing is sent, and any trouble sending is logged and it still exits 0.
//
// Root reads notify.json, which the app can write, so it is read without
// following a symlink and validated field by field, and only those fields
// reach nodemailer: never a path, a header, an attachment or a transport
// option from the file. The sendmail binary is fixed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { instance, readRequestNoFollow, parseEnvFile } = require("./agent-lib");

const SENDMAIL = "/usr/sbin/sendmail";
const TIMEOUT_MS = 20000;
const SECURITY = ["starttls", "tls", "none"];
const MAX_BODY = 32 * 1024;

// One plain address, nothing a mailer or sendmail's argv could read as more:
// no display name, no list, no leading dash.
const EMAIL_RE = /^[A-Za-z0-9._%+'=-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function validEmail(s) {
  return typeof s === "string" && s.length <= 254 && !s.startsWith("-") && EMAIL_RE.test(s);
}

function bad(error) {
  return { ok: false, error };
}

function sendmailExists() {
  try {
    return fs.statSync(SENDMAIL).isFile();
  } catch {
    return false;
  }
}

// Validate a config (from /admin, or read back from notify.json). Returns
// {ok:true, config} holding only the known fields, or {ok:false, error} with
// a fixed message the panel can show and root can log: never the input.
function validateConfig(c, opts = {}) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return bad("The email alert settings are not readable.");
  if (!validEmail(c.to)) return bad("Enter one email address alerts go to, like you@example.com.");
  let from = null;
  if (c.from !== undefined && c.from !== null && c.from !== "") {
    if (!validEmail(c.from)) return bad("The From address must be a plain email address, like alerts@example.com.");
    from = c.from;
  }
  if (c.method === "sendmail") {
    const exists = opts.sendmailExists !== undefined ? opts.sendmailExists : sendmailExists();
    if (!exists) return bad("This server has no mail software (/usr/sbin/sendmail), so use an SMTP server.");
    return { ok: true, config: { to: c.to, from, method: "sendmail" } };
  }
  if (c.method !== "smtp") return bad("Choose how to send: an SMTP server, or this server's mail.");
  const s = c.smtp && typeof c.smtp === "object" ? c.smtp : {};
  if (typeof s.host !== "string" || !HOST_RE.test(s.host)) return bad("Enter the mail server's name, like smtp.gmail.com.");
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return bad("The port must be a number from 1 to 65535.");
  if (!SECURITY.includes(s.security)) return bad("Choose the connection security: STARTTLS, SSL/TLS or none.");
  const user = s.user === undefined || s.user === null ? "" : s.user;
  const pass = s.pass === undefined || s.pass === null ? "" : s.pass;
  if (typeof user !== "string" || user.length > 256 || CONTROL_RE.test(user)) return bad("The username is not valid.");
  if (typeof pass !== "string" || pass.length > 1024 || CONTROL_RE.test(pass)) return bad("The password is not valid.");
  if (pass && !user) return bad("A password needs a username to go with it.");
  return { ok: true, config: { to: c.to, from, method: "smtp", smtp: { host: s.host, port: s.port, security: s.security, user, pass } } };
}

// nodemailer's transport options, built only from validated fields.
function transportOptions(cfg, timeoutMs = TIMEOUT_MS) {
  if (cfg.method === "sendmail") return { sendmail: true, path: SENDMAIL, newline: "unix" };
  const s = cfg.smtp;
  const o = {
    host: s.host,
    port: s.port,
    secure: s.security === "tls",
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    dnsTimeout: timeoutMs,
  };
  if (s.security === "starttls") o.requireTLS = true;
  if (s.security === "none") o.ignoreTLS = true;
  if (s.user) o.auth = { user: s.user, pass: s.pass };
  return o;
}

// Who the mail is from: the configured From, else the SMTP login when it is an
// address (Gmail and most providers insist on that), else this server.
function fromAddress(cfg) {
  if (cfg.from) return cfg.from;
  if (cfg.smtp && validEmail(cfg.smtp.user)) return cfg.smtp.user;
  const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
  return `featherspress@${host.includes(".") ? host : host + ".localdomain"}`;
}

function oneLine(s, max) {
  return String(s || "").replace(/[\r\n\t]+/g, " ").replace(CONTROL_RE, "").trim().slice(0, max);
}

// Subject "[featherspress <name>] <what> on <host>", and the body: what went
// wrong, then when, where, and the /admin link.
function composeMessage({ subject, text }, { instance: name, host, adminUrl, at } = {}) {
  host = oneLine(host || os.hostname(), 100);
  const when = (at || new Date()).toUTCString();
  let body = String(text || "").replace(/\r\n/g, "\n");
  if (body.length > MAX_BODY) body = "…" + body.slice(-MAX_BODY);
  body = body.replace(/\s+$/, "");
  const lines = [body, "", `When: ${when}`, `Server: ${host}`, `Site: ${oneLine(name, 40) || "?"}`];
  if (adminUrl) lines.push(`Admin: ${adminUrl}`);
  lines.push("", "--", "Sent by Featherspress. Change or turn off these emails in /admin, Email alerts.");
  return { subject: `[featherspress ${oneLine(name, 40) || "?"}] ${oneLine(subject, 150)} on ${host}`, text: lines.join("\n") + "\n" };
}

// The "Send test email" message, wherever it is sent from.
const TEST_MESSAGE = {
  subject: "Email alerts work",
  text:
    "This is a test from /admin, Email alerts.\n\n" +
    "From now on, if a backup, an update or a restore of this site fails, an email like this one tells you what went wrong.",
};

// Send one message. Rejects with the mailer's own error (the test button shows
// it); bounded by timeoutMs even when the far end just stops talking.
async function sendMail(cfg, { subject, text }, { timeoutMs = TIMEOUT_MS } = {}) {
  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport(transportOptions(cfg, timeoutMs), { logger: false, debug: false });
  let timer;
  try {
    return await Promise.race([
      transport.sendMail({ from: fromAddress(cfg), to: cfg.to, subject, text, disableFileAccess: true, disableUrlAccess: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs + 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}

// notify.json: null when there is none, {config} when it is good, {error} when
// it cannot be read (a symlink, junk) or is not valid.
function loadConfig(file, opts) {
  let raw;
  try {
    raw = readRequestNoFollow(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return { error: "notify.json cannot be read" };
  }
  const v = validateConfig(raw, opts);
  return v.ok ? { config: v.config } : { error: `notify.json is not valid: ${v.error}` };
}

// A site URL's /admin address, or null when it does not look like a URL.
function adminUrl(siteUrl) {
  if (typeof siteUrl !== "string" || !/^https?:\/\/[^\s"'<>]+$/.test(siteUrl)) return null;
  return siteUrl.replace(/\/+$/, "") + "/admin/";
}

// The site's /admin address, for the email: site.json's url, else SITE_URL.
function adminUrlFor(dataDir, confDir) {
  let url = null;
  try {
    url = readRequestNoFollow(path.join(dataDir, "site.json")).url;
  } catch {}
  if (typeof url !== "string" || !url) {
    try {
      url = parseEnvFile(path.join(confDir, "featherspress.env")).SITE_URL;
    } catch {}
  }
  return adminUrl(url);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Returns {sent:true} or {sent:false, error}; logs either way.
async function main(argv) {
  const log = (m) => process.stderr.write(`[notify] ${m}\n`);
  const notSent = (error) => {
    log(`${error}; nothing sent`);
    return { sent: false, error };
  };
  const i = argv.indexOf("--subject");
  const subject = i >= 0 ? argv[i + 1] : "";
  if (!subject) return notSent("usage: echo body | notify.js --subject <text> [--report]");
  let inst;
  try {
    inst = instance(process.env);
  } catch (e) {
    return notSent(e.message);
  }
  const file = process.env.NOTIFY_CONFIG || path.join(inst.dataDir, "notify.json");
  const loaded = loadConfig(file);
  const text = readStdin();
  if (!loaded) return notSent(`email alerts are not set up ("${oneLine(subject, 150)}")`);
  if (loaded.error) return notSent(loaded.error);
  const timeoutMs = Number(process.env.NOTIFY_TIMEOUT_MS) > 0 ? Number(process.env.NOTIFY_TIMEOUT_MS) : TIMEOUT_MS;
  const msg = composeMessage({ subject, text }, { instance: inst.name, adminUrl: adminUrlFor(inst.dataDir, inst.confDir) });
  try {
    await sendMail(loaded.config, msg, { timeoutMs });
    log(`sent "${msg.subject}" to ${loaded.config.to}`);
    return { sent: true };
  } catch (e) {
    const error = oneLine(e && e.message, 500);
    log(`could not send the alert email to ${loaded.config.to}: ${error}`);
    return { sent: false, error };
  }
}

if (require.main === module) {
  // Whatever happens, the caller's own failure handling carries on: exit 0,
  // and never hang past the send timeout.
  const report = process.argv.includes("--report");
  const done = (result) => {
    if (report) process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  };
  const hard = setTimeout(() => done({ sent: false, error: "timed out" }), (Number(process.env.NOTIFY_TIMEOUT_MS) || TIMEOUT_MS) + 8000);
  main(process.argv.slice(2))
    .catch((e) => ({ sent: false, error: `not sent: ${e && e.message}` }))
    .then((result) => {
      clearTimeout(hard);
      done(result);
    });
}

module.exports = {
  SENDMAIL,
  TEST_MESSAGE,
  validateConfig,
  transportOptions,
  composeMessage,
  sendMail,
  loadConfig,
  adminUrl,
  adminUrlFor,
  sendmailExists,
  fromAddress,
};
