import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "../server/store.mjs";

test("traffic counters deduplicate events, distinguish sessions, filter sites and survive restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "niko-monitor-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "monitor.sqlite");
  const now = Date.parse("2026-11-13T14:00:00Z");
  let store = new MonitorStore(file);
  const event = {
    id: "event-000000000001",
    site: "niko-main",
    type: "pageview",
    session: "session-00000001",
    path: "/",
    label: "",
  };
  assert.equal(store.event(event, now), true);
  assert.equal(
    store.event(event, now),
    false,
    "a retried beacon must not count twice",
  );
  store.event({ ...event, id: "event-000000000002", path: "/collection" }, now);
  store.event(
    {
      ...event,
      id: "event-000000000003",
      type: "click",
      label: "文库",
      path: "/nikowenku-archive/",
    },
    now,
  );
  store.event(
    {
      ...event,
      id: "event-000000000004",
      site: "niko-wenku",
      session: "session-00000002",
    },
    now,
  );
  assert.equal(store.summary(now).pv, 3);
  assert.equal(store.summary(now).uv, 2);
  assert.equal(store.summary(now).clicks, 1);
  assert.equal(store.summary(now, "niko-main").pv, 2);
  assert.equal(store.summary(now, "niko-main").pages[0].views, 1);
  assert.equal(
    store.summary(now).trend.reduce((n, p) => n + p.pv, 0),
    3,
  );
  store.close();
  store = new MonitorStore(file);
  assert.equal(store.summary(now).pv, 3);
  assert.equal(
    store.summary(Date.parse("2026-11-13T16:01:00Z")).pv,
    0,
    "daily statistics roll over at China midnight",
  );
  store.close();
});

test("health history stores real failures and clears no old samples on restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "niko-monitor-probes-"));
  const store = new MonitorStore(join(dir, "monitor.sqlite"));
  t.after(async () => {
    store.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  store.probe({
    id: "api",
    status: "up",
    latency: 30,
    code: 200,
    checkedAt: 1000,
    error: "",
  });
  store.probe({
    id: "api",
    status: "down",
    latency: 100,
    code: 503,
    checkedAt: 2000,
    error: "HTTP 503",
  });
  const samples = store.history("api", 0);
  assert.equal(samples.length, 2);
  assert.equal(samples[1].status, "down");
  assert.equal(samples[1].code, 503);
});
