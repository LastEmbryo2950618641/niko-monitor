import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MonitorStore, chinaDayStart } from "../server/store.mjs";
import { AccessLogReader } from "../server/access-log.mjs";
import {
  clientIp,
  normalizeEndpoint,
  normalizeIp,
  parseAccessLine,
  endpointHealth,
  endpoints,
} from "../server/endpoints.mjs";
import { nginxTelemetry } from "../server/nginx-telemetry.mjs";

const access = (id, extra = {}) =>
  JSON.stringify({
    id: String(id).padStart(32, "0"),
    ip: "203.0.113.9",
    method: "GET",
    endpoint: "/api/library",
    status: "200",
    seconds: "0.025",
    at: String(Date.now() / 1000),
    probe: "0",
    ...extra,
  });
test("IP addresses are normalized and only a loopback proxy can supply X-Real-IP", () => {
  assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeIp("2001:0DB8:0000::1"), "2001:db8::1");
  assert.equal(normalizeIp("fe80::1%lo0"), "");
  assert.equal(normalizeIp("203.0.113.9, 127.0.0.1"), "");
  const req = (remoteAddress, value) => ({
    socket: { remoteAddress },
    headers: { "x-real-ip": value, "x-forwarded-for": "198.51.100.77" },
  });
  assert.equal(clientIp(req("203.0.113.9", "198.51.100.2")), "203.0.113.9");
  assert.equal(clientIp(req("::ffff:127.0.0.1", "2001:db8::1")), "2001:db8::1");
  assert.equal(clientIp(req("127.0.0.1", "invalid")), "127.0.0.1");
});

test("normalization removes IDs and queries, bounds unknown routes and excludes monitoring probes", () => {
  assert.deepEqual(
    normalizeEndpoint(
      "/nikowenku-archive/api/books/book123/files/text?token=secret",
    ),
    { path: "/api/books/:book/files/:file", site: "niko-wenku" },
  );
  assert.equal(
    normalizeEndpoint("/api/auth/captcha/privateid.png").path,
    "/api/auth/captcha/:image.png",
  );
  assert.equal(
    normalizeEndpoint("/api/random-sensitive-path").path,
    "/api/:unmatched",
  );
  assert.equal(
    normalizeEndpoint("/chat-api/private-name").path,
    "/chat-api/:unmatched",
  );
  assert.equal(normalizeEndpoint("/niko-monitor/api/snapshot"), null);
  assert.equal(parseAccessLine(access(1, { probe: "1" })), null);
  assert.equal(parseAccessLine(access(1, { ip: "spoofed" })), null);
  assert.equal(parseAccessLine(access(1, { seconds: "NaN" })), null);
  assert.equal(parseAccessLine(access(1, { status: "700" })), null);
  assert.equal(parseAccessLine(access(1, { id: "invalid" })), null);
  assert.equal(parseAccessLine(access(1, { at: "0" })), null);
  assert.equal(parseAccessLine("incomplete"), null);
  const row = parseAccessLine(
    access(2, { endpoint: "/api/books/id?password=secret" }),
  );
  assert.equal(row.path, "/api/books/:book");
  assert.equal(JSON.stringify(row).includes("secret"), false);
});

test("daily IP union deduplicates browser/CLI, filters sites, paginates and preserves old unknown-IP events", (t) => {
  const store = new MonitorStore(":memory:");
  t.after(() => store.close());
  const now = Date.now(),
    old = chinaDayStart(now) - 1;
  const event = {
    id: "browser-1",
    type: "pageview",
    site: "niko-main",
    session: "s1",
    path: "/",
    ip: "203.0.113.9",
  };
  store.event(event, now);
  store.event({ ...event, id: "browser-2", session: "s2" }, now);
  store.event({ ...event, id: "old-no-ip", ip: "" }, now);
  store.event({ ...event, id: "previous-day", ip: "198.51.100.1" }, old);
  const row = parseAccessLine(access(1, { at: String(now / 1000) }));
  store.accessBatch([
    row,
    row,
    { ...row, id: "other", code: 503, method: "POST" },
  ]);
  assert.equal(store.requests(now).total, 2);
  assert.equal(store.requests(now).serverErrors, 1);
  assert.equal(
    store.requests(now).endpoints.length,
    2,
    "methods are separate endpoints",
  );
  assert.equal(store.summary(now).ips, 1);
  assert.equal(store.summary(now).pv, 3);
  assert.equal(store.summary(now).unknownIpViews, 1);
  assert.equal(store.requests(now, "niko-main").total, 0);
  let visitors = store.visitors(now);
  assert.equal(visitors.total, 1);
  assert.equal(visitors.rows[0].pv, 2);
  assert.equal(visitors.rows[0].requests, 2);
  assert.equal(visitors.rows[0].errors, 1);
  assert.equal(visitors.rows[0].sites.split(",").length, 2);
  assert.equal(store.visitors(now, "niko-wenku").rows[0].pv, 0);
  assert.equal(
    store.visitors(now, "", 1, "%").total,
    0,
    "search uses literal strings, not LIKE wildcards",
  );
  const many = Array.from({ length: 30 }, (_, i) => ({
    ...row,
    id: "extra" + i,
    ip: "198.51.100." + (i + 1),
  }));
  store.accessBatch(many);
  visitors = store.visitors(now, "", 2);
  assert.equal(visitors.total, 31);
  assert.equal(visitors.rows.length, 6);
  assert.equal(visitors.pages, 2);
  store.prune(now + 31 * 86400000);
  assert.equal(store.visitors(now).total, 0);
});

test("schema migration keeps historical events and deduplication after reopening", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "niko-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "monitor.sqlite"),
    db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE events(id TEXT PRIMARY KEY,site TEXT,type TEXT,session TEXT,path TEXT,label TEXT,referrer TEXT,at INTEGER)",
  );
  db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(
    "legacy",
    "niko-main",
    "pageview",
    "hash",
    "/",
    "",
    "",
    Date.now(),
  );
  db.close();
  let store = new MonitorStore(file);
  assert.equal(store.summary().pv, 1);
  assert.equal(store.summary().unknownIpViews, 1);
  const row = parseAccessLine(access(5));
  store.accessBatch([row], "checkpoint", 123);
  store.close();
  store = new MonitorStore(file);
  assert.equal(store.accessBatch([row]), 0);
  assert.equal(store.setting("checkpoint"), "123");
  assert.equal(store.summary().pv, 1);
  store.close();
});

test("log reader resumes partial lines, survives restart/rename rotation, and never double-counts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "niko-log-")),
    path = join(dir, "access.jsonl"),
    db = join(dir, "monitor.sqlite");
  let store = new MonitorStore(db),
    reader = new AccessLogReader(store, path);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await reader.read();
  assert.equal(reader.state.status, "down");
  const line = access(2);
  await writeFile(path, access(1) + "\n" + line.slice(0, 20));
  assert.equal(await reader.read(), true);
  assert.equal(store.requests().total, 1);
  await appendFile(
    path,
    line.slice(20) + "\n" + access(3, { probe: "1" }) + "\nbadjson\n",
  );
  await reader.read();
  assert.equal(store.requests().total, 2);
  assert.equal(reader.state.lagBytes, 0);
  store.close();
  store = new MonitorStore(db);
  reader = new AccessLogReader(store, path);
  await reader.read();
  assert.equal(store.requests().total, 2);
  // The old file may receive one final write after rename and before Nginx reopens.
  await rename(path, path + ".1");
  await appendFile(path + ".1", access(4) + "\n");
  await writeFile(path, access(5, { ip: "2001:db8::1" }) + "\n");
  await reader.read();
  assert.equal(store.requests().total, 4);
  assert.equal(store.summary().ips, 2);
  await writeFile(path, access(6) + "\n");
  await reader.read();
  assert.equal(store.requests().total, 5, "truncation resumes at zero");
  assert.equal(reader.state.status, "up");
});

test("per-interface health distinguishes failures, expected authentication, recovery and stale observations", () => {
  const now = Date.now(),
    row = { lastAt: now, lastCode: 200, recentErrors: 0 };
  assert.equal(endpointHealth(null, null, now).status, "pending");
  assert.equal(
    endpointHealth({ ...row, lastCode: 503 }, null, now).status,
    "down",
  );
  assert.equal(
    endpointHealth({ ...row, recentErrors: 1 }, null, now).status,
    "warning",
  );
  assert.equal(
    endpointHealth({ ...row, lastCode: 404 }, null, now).status,
    "warning",
  );
  assert.equal(
    endpointHealth({ ...row, lastCode: 401 }, null, now).status,
    "protected",
  );
  assert.equal(
    endpointHealth({ ...row, lastAt: now - 600000 }, null, now).status,
    "stale",
  );
  assert.equal(
    endpointHealth(row, { checkedAt: now, status: "down" }, now).status,
    "down",
  );
  assert.equal(
    endpointHealth(null, { checkedAt: now, status: "up", code: 401 }, now)
      .status,
    "protected",
  );
  assert.equal(
    endpointHealth(row, { checkedAt: now - 100000, status: "down" }, now)
      .status,
    "up",
  );
});

test("Nginx telemetry is sanitized before disk, preserves both CLI paths and excludes external spoofed probes", () => {
  const conf = nginxTelemetry("https://111.229.32.85");
  assert.match(conf, /nikowenku-archive/);
  assert.match(conf, /:book\/files\/:file/);
  assert.match(conf, /remote_addr/);
  assert.match(conf, /127/);
  assert.match(conf, /request_id/);
  assert.doesNotMatch(
    conf,
    /\$(request_uri|args|request_body|http_authorization|http_cookie|http_x_forwarded_for)/,
  );
  for (const item of endpoints) {
    const sample = item.path.replace(/:[a-z]+/g, "sample123");
    const rules = [...conf.matchAll(/"~([^"\n]+)" "([^"\n]+)";/g)];
    assert.equal(
      rules.find((rule) => new RegExp(rule[1]).test(sample))?.[2],
      item.path,
      sample,
    );
    if (sample.startsWith("/api/"))
      assert.equal(
        rules.find((rule) =>
          new RegExp(rule[1]).test("/nikowenku-archive" + sample),
        )?.[2],
        item.path,
      );
  }
});
