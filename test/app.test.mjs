import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { scryptSync } from "node:crypto";
import { createMonitor } from "../server/app.mjs";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve("http://127.0.0.1:" + server.address().port),
    ),
  );
async function setup(t, options = {}) {
  const monitor = createMonitor({
    dbFile: ":memory:",
    sites: [
      { id: "niko-main", name: "主站", origins: ["https://niko.example"] },
    ],
    services: [],
    adminAccount: null,
    ...options,
  });
  const base = await listen(monitor.server);
  t.after(() => monitor.close());
  return { monitor, base };
}
const event = {
  id: "event-000000001",
  site: "niko-main",
  type: "pageview",
  session: "session-000000001",
  path: "/",
  label: "",
};
const send = (base, body, origin = "https://niko.example") =>
  fetch(base + "/api/collect", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "text/plain" },
    body: JSON.stringify(body),
  });

test("collection persists real counts and rejects foreign origins, unknown sites, unsafe paths and oversized bodies", async (t) => {
  const { base } = await setup(t);
  assert.equal((await send(base, event)).status, 202);
  assert.equal((await send(base, event)).status, 202);
  assert.equal(
    (
      await send(base, {
        ...event,
        id: "event-000000002",
        type: "click",
        label: "文库",
      })
    ).status,
    202,
  );
  const stats = await (await fetch(base + "/api/snapshot")).json();
  assert.equal(stats.traffic.pv, 1);
  assert.equal(stats.traffic.clicks, 1);
  assert.equal(stats.traffic.uv, 1);
  assert.equal(
    (
      await send(
        base,
        { ...event, id: "event-000000003" },
        "https://evil.example",
      )
    ).status,
    403,
  );
  assert.equal((await send(base, { ...event, site: "unknown" })).status, 400);
  assert.equal(
    (await send(base, { ...event, path: "/?password=secret" })).status,
    400,
  );
  assert.equal(
    (await send(base, { ...event, label: "x".repeat(20000) })).status,
    413,
  );
  assert.equal((await fetch(base + "/tracker.js")).status, 200);
});

test("private statistics require login, cross-origin login is rejected, and events remain public", async (t) => {
  const password = "test-admin-password-only";
  const adminAccount = {
    username: "test-admin",
    salt: "test-salt",
    passwordHash: scryptSync(password, "test-salt", 64).toString("hex"),
  };
  const { base } = await setup(t, { adminAccount });
  assert.equal((await fetch(base + "/api/snapshot")).status, 401);
  assert.equal((await fetch(base + "/api/events")).status, 401);
  assert.equal((await fetch(base + "/api/visitors")).status, 401);
  const login = (value, origin = base, username = "test-admin") =>
    fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: value }),
    });
  assert.equal((await login(password, "https://evil.example")).status, 403);
  assert.equal((await login("incorrect")).status, 401);
  assert.equal((await login(password, base, "unknown-admin")).status, 401);
  assert.equal((await login("x".repeat(1025))).status, 400);
  assert.equal(
    (
      await fetch(base + "/api/login", {
        method: "POST",
        headers: { Origin: base },
        body: JSON.stringify({ token: "legacy-token-is-not-a-login" }),
      })
    ).status,
    400,
  );
  const response = await login(password);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    username: "test-admin",
    role: "admin",
  });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/i);
  assert.doesNotMatch(
    response.headers.get("set-cookie"),
    /test-admin|test-admin-password-only/,
  );
  assert.equal(
    (await fetch(base + "/api/snapshot", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  assert.equal((await send(base, event)).status, 202);
  const logout = await fetch(base + "/api/logout", {
    method: "POST",
    headers: { Origin: base, Cookie: cookie },
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (await fetch(base + "/api/snapshot", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
});

test("browser-supplied IP is ignored and visitor lists remain filtered, validated and private", async (t) => {
  const { monitor, base } = await setup(t);
  await send(base, { ...event, ip: "198.51.100.1" });
  const visitors = await (await fetch(base + "/api/visitors")).json();
  assert.equal(visitors.total, 1);
  assert.equal(visitors.rows[0].ip, "127.0.0.1");
  assert.equal((await fetch(base + "/api/visitors?page=-1")).status, 400);
  assert.equal((await fetch(base + "/api/visitors?site=unknown")).status, 400);
  assert.equal(monitor.snapshot().traffic.ips, 1);
});

test("interface probes never execute write routes and treat protected endpoint authentication as healthy", async (t) => {
  const calls = [];
  const target = createServer((req, res) => {
    calls.push(req.method + " " + req.url);
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/worker/status")) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "login required" }));
    } else if (req.url.endsWith("/auth/session"))
      res.end(JSON.stringify({ authenticated: false }));
    else if (req.url.endsWith("/library"))
      res.end(JSON.stringify({ books: [] }));
    else res.end(JSON.stringify({ ok: true }));
  });
  const targetBase = await listen(target);
  t.after(
    () =>
      new Promise((resolve) => {
        target.closeAllConnections();
        target.close(resolve);
      }),
  );
  const { monitor } = await setup(t, {
    sites: [{ id: "niko-wenku", url: targetBase + "/nikowenku-archive/" }],
    probeEndpoints: true,
  });
  await monitor.poll();
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every((call) => call.startsWith("GET /nikowenku-archive/api/")),
  );
  assert.ok(
    !calls.some((call) =>
      /start|stop|publish|login|register|captcha/.test(call),
    ),
  );
  const rows = monitor.snapshot().requests.endpoints;
  assert.equal(
    rows.find((row) => row.path === "/api/worker/status").status,
    "protected",
  );
  assert.equal(rows.find((row) => row.path === "/api/library").status, "up");
  assert.equal(
    rows.find((row) => row.path === "/api/worker/start").status,
    "pending",
  );
});

test("fixed admin login is required by default and repeated wrong passwords are limited", async (t) => {
  const password = "rate-limit-password-only";
  const adminAccount = {
    username: "test-admin",
    salt: "test-salt",
    passwordHash: scryptSync(password, "test-salt", 64).toString("hex"),
  };
  const { base } = await setup(t, { adminAccount });
  for (let i = 0; i < 8; i++) {
    const response = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base },
      body: JSON.stringify({
        username: "test-admin",
        password: "incorrect-password",
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(
    (
      await fetch(base + "/api/login", {
        method: "POST",
        headers: { Origin: base },
        body: JSON.stringify({ username: "test-admin", password }),
      })
    ).status,
    429,
  );
  const secured = createMonitor({ dbFile: ":memory:" });
  t.after(() => secured.close());
  const securedBase = await listen(secured.server);
  assert.equal((await fetch(securedBase + "/api/snapshot")).status, 401);
  assert.throws(
    () =>
      createMonitor({
        dbFile: ":memory:",
        publicOrigin: "https://niko.example",
        adminAccount: null,
      }),
    /管理员/,
  );
});

test("health checks distinguish a JSON API failure from HTTP success, record downtime and recover", async (t) => {
  let healthy = false;
  const target = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: healthy }));
  });
  const targetBase = await listen(target);
  t.after(
    () =>
      new Promise((resolve) => {
        target.closeAllConnections();
        target.close(resolve);
      }),
  );
  const { base, monitor } = await setup(t, {
    services: [
      {
        id: "api",
        site: "niko-main",
        name: "API",
        url: targetBase,
        kind: "api",
      },
    ],
  });
  await monitor.poll();
  let snapshot = await (await fetch(base + "/api/snapshot")).json();
  assert.equal(snapshot.services[0].status, "down");
  healthy = true;
  await monitor.poll();
  snapshot = await (await fetch(base + "/api/snapshot")).json();
  assert.equal(snapshot.services[0].status, "up");
  assert.equal(snapshot.services[0].uptime, 50);
  assert.equal(snapshot.services[0].history.length, 2);
});

test("SSE immediately sends a snapshot and pushes a new snapshot after collection", async (t) => {
  const { base } = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(base + "/api/events", {
    signal: controller.signal,
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: snapshot/);
  await send(base, event);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"pv":1/);
  await reader.cancel();
});

test("health rejects a success-shaped error and verifies that the standby remains read-only", async (t) => {
  let payload = { error: "unavailable" };
  const target = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });
  const targetBase = await listen(target);
  t.after(
    () =>
      new Promise((resolve) => {
        target.closeAllConnections();
        target.close(resolve);
      }),
  );
  const { base, monitor } = await setup(t, {
    services: [
      {
        id: "standby",
        name: "Standby",
        site: "niko-main",
        url: targetBase,
        kind: "api",
        readOnly: true,
      },
    ],
  });
  await monitor.poll();
  assert.equal(
    (await (await fetch(base + "/api/snapshot")).json()).services[0].status,
    "down",
  );
  payload = { readOnly: true };
  await monitor.poll();
  assert.equal(
    (await (await fetch(base + "/api/snapshot")).json()).services[0].status,
    "down",
    "readOnly without a true health status is not healthy",
  );
  payload = { ok: true, readOnly: false };
  await monitor.poll();
  assert.equal(
    (await (await fetch(base + "/api/snapshot")).json()).services[0].status,
    "down",
  );
  payload = { ok: true, readOnly: true };
  await monitor.poll();
  assert.equal(
    (await (await fetch(base + "/api/snapshot")).json()).services[0].status,
    "up",
  );
});
