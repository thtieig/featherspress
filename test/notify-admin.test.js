"use strict";

// /admin → Email alerts: the app saves notify.json (0600) and sends the test
// email itself. The stored password never comes back out of the API.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-notify-admin-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";
const NOTIFY_FILE = path.join(TMP, "notify.json"); // beside content/, like every data file

const PASSWORD = "notify-admin-password";
const RECOVERY = "nnnn-1111";
fs.writeFileSync(process.env.AUTH_CONFIG, JSON.stringify({
  passwordHash: bcrypt.hashSync(PASSWORD, 8),
  totpSecret: "JBSWY3DPEHPK3PXP",
  recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
}));

const app = require("../server");

// Accepts any mail; records what it got.
function smtpSink() {
  const messages = [];
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    let data = null;
    sock.write("220 sink\r\n");
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data !== null) {
          if (line === ".") { messages.push(data); data = null; sock.write("250 ok\r\n"); } else data += line + "\n";
        } else if (/^EHLO/i.test(line)) sock.write("250-sink\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH/i.test(line)) sock.write("235 ok\r\n");
        else if (/^DATA/i.test(line)) { data = ""; sock.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, messages, close: () => server.close() })));
}

let base;
let server;
let cookie = "";

async function api(method, p, body) {
  const headers = cookie ? { cookie } : {};
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
}

const form = (port, over = {}) => ({
  to: "owner@example.com",
  from: "",
  method: "smtp",
  smtp: { host: "127.0.0.1", port: String(port), security: "none", user: "me@example.com", pass: "PLACEHOLDER-PASS-2", ...over },
});

test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("the email alert settings need a signed-in owner", async () => {
  assert.strictEqual((await api("GET", "/admin/api/notify")).status, 401);
  assert.strictEqual((await api("POST", "/admin/api/notify", form(25))).status, 401);
  assert.strictEqual((await api("POST", "/admin/api/notify-test", form(25))).status, 401);
  assert.strictEqual((await api("DELETE", "/admin/api/notify")).status, 401);
  const res = await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  assert.strictEqual(res.status, 200, await res.text());
});

test("not set up: says so, and whether this server has sendmail", async () => {
  const s = await (await api("GET", "/admin/api/notify")).json();
  assert.strictEqual(s.configured, false);
  assert.strictEqual(s.sendmailAvailable, fs.existsSync("/usr/sbin/sendmail"));
});

test("saving writes notify.json 0600, and the password never comes back", async () => {
  const res = await api("POST", "/admin/api/notify", form(2525));
  assert.strictEqual(res.status, 200, await res.text());
  assert.strictEqual(fs.statSync(NOTIFY_FILE).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf8"));
  assert.strictEqual(saved.smtp.pass, "PLACEHOLDER-PASS-2");
  assert.strictEqual(saved.smtp.port, 2525, "the port is stored as a number");

  const body = await (await api("GET", "/admin/api/notify")).text();
  assert.doesNotMatch(body, /PLACEHOLDER-PASS-2/);
  const s = JSON.parse(body);
  assert.strictEqual(s.configured, true);
  assert.strictEqual(s.to, "owner@example.com");
  assert.deepStrictEqual(s.smtp, { host: "127.0.0.1", port: 2525, security: "none", user: "me@example.com", passSaved: true });
});

test("an empty password keeps the saved one", async () => {
  const res = await api("POST", "/admin/api/notify", form(2526, { pass: "" }));
  assert.strictEqual(res.status, 200, await res.text());
  const saved = JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf8"));
  assert.strictEqual(saved.smtp.pass, "PLACEHOLDER-PASS-2");
  assert.strictEqual(saved.smtp.port, 2526);
});

test("an empty password is not reused for a different mail server or username", async () => {
  const before = fs.readFileSync(NOTIFY_FILE, "utf8");
  for (const over of [{ host: "mail.elsewhere.example", pass: "" }, { user: "someone-else@example.com", pass: "" }]) {
    const res = await api("POST", "/admin/api/notify", form(2526, over));
    assert.strictEqual(res.status, 400, JSON.stringify(over));
    assert.match((await res.json()).error, /password/);
  }
  assert.strictEqual(fs.readFileSync(NOTIFY_FILE, "utf8"), before, "the saved settings are unchanged");
});

test("invalid settings are refused with a plain message and nothing is changed", async () => {
  const before = fs.readFileSync(NOTIFY_FILE, "utf8");
  const res = await api("POST", "/admin/api/notify", form(2527, { host: "" }));
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /mail server/);
  assert.strictEqual(fs.readFileSync(NOTIFY_FILE, "utf8"), before);
});

test("Send test email saves, sends one email right away, and says it worked", async () => {
  const sink = await smtpSink();
  try {
    const res = await api("POST", "/admin/api/notify-test", form(sink.port, { pass: "" }));
    const r = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(r));
    assert.deepStrictEqual(r, { saved: true, sent: true, to: "owner@example.com" });
    assert.strictEqual(sink.messages.length, 1);
    assert.match(sink.messages[0], /^Subject: \[featherspress [a-z0-9-]+\] Email alerts work on /m);
    assert.strictEqual(JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf8")).smtp.port, sink.port);
  } finally {
    sink.close();
  }
});

test("Send test email shows the exact error when the server cannot be reached", async () => {
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  closed.close();
  const res = await api("POST", "/admin/api/notify-test", form(port));
  const r = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(r.saved, true);
  assert.strictEqual(r.sent, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test("Turn off removes the settings", async () => {
  const res = await api("DELETE", "/admin/api/notify");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fs.existsSync(NOTIFY_FILE), false);
  assert.strictEqual((await (await api("GET", "/admin/api/notify")).json()).configured, false);
});
