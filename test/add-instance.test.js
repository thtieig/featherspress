"use strict";

// deploy/add-instance.sh checks everything before it touches the server, so
// those checks run here without root: FP_ETC points its look at the existing
// instances (/etc/featherspress/*) and vhosts (/etc/apache2) at a temp dir.
// A run that passes every check stops at "run this as root".

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "deploy", "add-instance.sh");

// A server that already runs "beta" on port 8802 for beta.example.org.
function server() {
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), "fp-add-instance-"));
  fs.mkdirSync(path.join(etc, "featherspress", "beta"), { recursive: true });
  fs.writeFileSync(path.join(etc, "featherspress", "beta", "featherspress.env"),
    "HOST=127.0.0.1\nPORT=8802\nSITE_PACKAGE=/var/lib/featherspress/beta\n");
  fs.mkdirSync(path.join(etc, "apache2", "sites-available"), { recursive: true });
  fs.writeFileSync(path.join(etc, "apache2", "sites-available", "featherspress-beta.conf"),
    "<VirtualHost *:80>\n    ServerName beta.example.org\n    ServerAlias www.beta.example.org\n</VirtualHost>\n");
  return etc;
}

function run(etc, ...args) {
  return runWith({}, etc, ...args);
}

function runWith(env, etc, ...args) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env, FP_ETC: etc } });
}

function refuses(r, re) {
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, re);
  assert.doesNotMatch(r.stderr, /as root/, "it must refuse before it gets as far as needing root");
}

test("add-instance.sh needs a name, a domain and a port", () => {
  const etc = server();
  try {
    refuses(run(etc), /usage/i);
    refuses(run(etc, "alpha", "alpha.example.org"), /usage/i);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("add-instance.sh refuses a bad name, domain or port", () => {
  const etc = server();
  try {
    refuses(run(etc, "Alpha", "alpha.example.org", "8801"), /name/);
    refuses(run(etc, "a/b", "alpha.example.org", "8801"), /name/);
    refuses(run(etc, "alpha", "not a domain", "8801"), /domain/);
    refuses(run(etc, "alpha", "alpha.example.org/x", "8801"), /domain/);
    refuses(run(etc, "alpha", "alpha.example.org", "80"), /port/);
    refuses(run(etc, "alpha", "alpha.example.org", "70000"), /port/);
    refuses(run(etc, "alpha", "alpha.example.org", "88x"), /port/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("add-instance.sh refuses a port or domain another instance already uses", () => {
  const etc = server();
  try {
    refuses(run(etc, "alpha", "alpha.example.org", "8802"), /port 8802 .*beta/);
    refuses(run(etc, "alpha", "beta.example.org", "8801"), /beta\.example\.org .*featherspress-beta/);
    refuses(run(etc, "alpha", "www.beta.example.org", "8801"), /featherspress-beta/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("re-running add-instance.sh for an existing instance must keep its port and domain", () => {
  const etc = server();
  try {
    refuses(run(etc, "beta", "beta.example.org", "8803"), /beta already .*port 8802/);
    refuses(run(etc, "beta", "other.example.org", "8802"), /beta already .*beta\.example\.org/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("add-instance.sh accepts a new instance, and a re-run of an existing one, then wants root", () => {
  if (process.getuid() === 0) return; // as root it would really build the site
  const etc = server();
  try {
    for (const args of [["alpha", "alpha.example.org", "8801"], ["beta", "beta.example.org", "8802"]]) {
      const r = run(etc, ...args);
      assert.strictEqual(r.status, 1, r.stderr);
      assert.match(r.stderr, /as root/);
    }
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("add-instance.sh refuses a bad alias, or one another instance already serves", () => {
  const etc = server();
  try {
    const args = ["alpha", "alpha.example.org", "8801"];
    refuses(runWith({ ALIASES: "WWW.alpha.example.org" }, etc, ...args), /alias 'WWW/);
    refuses(runWith({ ALIASES: "www.alpha.example.org not/a/domain" }, etc, ...args), /alias 'not\/a\/domain'/);
    refuses(runWith({ ALIASES: "alpha.example.org" }, etc, ...args), /the domain itself/);
    refuses(runWith({ ALIASES: "www.alpha.example.org www.beta.example.org" }, etc, ...args),
      /www\.beta\.example\.org .*featherspress-beta/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("add-instance.sh accepts free aliases, then wants root", () => {
  if (process.getuid() === 0) return;
  const etc = server();
  try {
    const r = runWith({ ALIASES: "www.alpha.example.org  alpha.example.net" }, etc, "alpha", "alpha.example.org", "8801");
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /as root/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("the vhost template has the one ServerAlias line add-instance.sh fills in or drops", () => {
  const tpl = fs.readFileSync(path.join(__dirname, "..", "deploy", "apache", "featherspress.conf"), "utf8");
  const lines = tpl.split("\n").filter((l) => l.includes("@ALIASES@"));
  assert.deepStrictEqual(lines, ["    ServerAlias @ALIASES@"]);
  assert.match(fs.readFileSync(SCRIPT, "utf8"), /ServerAlias @ALIASES@\$/);
});

// ---- the vhost it writes: PRINT_VHOST=1 prints it after every check, and
// stops there, so the alias handling is tested on the real output.
function vhost(etc, aliases, ...args) {
  return runWith({ PRINT_VHOST: "1", ALIASES: aliases }, etc, ...args);
}

test("the vhost carries the aliases on one ServerAlias line, or no such line without them", () => {
  const etc = server();
  try {
    const withAliases = vhost(etc, "www.alpha.example.org alpha.example.net", "alpha", "alpha.example.org", "8801");
    assert.strictEqual(withAliases.status, 0, withAliases.stderr);
    assert.match(withAliases.stdout, /^\s*ServerName alpha\.example\.org$/m);
    assert.match(withAliases.stdout, /^\s*ServerAlias www\.alpha\.example\.org alpha\.example\.net$/m);
    assert.doesNotMatch(withAliases.stdout, /@[A-Z]+@/, "every placeholder is filled in");

    const without = vhost(etc, "", "alpha", "alpha.example.org", "8801");
    assert.strictEqual(without.status, 0, without.stderr);
    assert.doesNotMatch(without.stdout, /^\s*ServerAlias\b/m);
    assert.doesNotMatch(without.stdout, /@[A-Z]+@/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("aliases on several lines are all taken, and one listed twice is refused", () => {
  const etc = server();
  try {
    const r = vhost(etc, "www.alpha.example.org\nalpha.example.net", "alpha", "alpha.example.org", "8801");
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /ServerAlias www\.alpha\.example\.org alpha\.example\.net$/m);
    refuses(vhost(etc, "www.alpha.example.org www.alpha.example.org", "alpha", "alpha.example.org", "8801"),
      /listed twice/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("the certbot step it prints names the aliases too", () => {
  const etc = server();
  try {
    const r = vhost(etc, "www.alpha.example.org", "alpha", "alpha.example.org", "8801");
    assert.match(r.stderr, /certbot --apache -d alpha\.example\.org -d www\.alpha\.example\.org/);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});

test("re-running with new aliases for a site whose vhost exists says to add them by hand", () => {
  const etc = server();
  try {
    // beta's vhost already exists, with www.beta.example.org.
    const r = runWith({ ALIASES: "beta.example.net" }, etc, "beta", "beta.example.org", "8802");
    refuses(r, /already has a vhost.*beta\.example\.net/s);
    assert.match(r.stderr, /certbot --apache -d beta\.example\.org -d www\.beta\.example\.org -d beta\.example\.net$/m,
      "the certificate must keep covering the names the vhost already has");
    // Naming the aliases it already has is fine.
    const same = runWith({ ALIASES: "www.beta.example.org", PRINT_VHOST: "1" }, etc, "beta", "beta.example.org", "8802");
    assert.strictEqual(same.status, 0, same.stderr);
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
});
