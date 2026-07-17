"use strict";

// Task 0 smoke test: the app module loads and answers a health check without
// binding a port (Express app is exported; we call it via a throwaway server).

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../server");

function get(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

test("app boots and /healthz returns 200", async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await get(server, "/healthz");
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /featherspress ok/);
  } finally {
    server.close();
  }
});
