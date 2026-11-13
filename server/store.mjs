import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes } from "node:crypto";

const hour = 3600000;
export function chinaDayStart(now) {
  return Math.floor((now + 8 * hour) / (24 * hour)) * 24 * hour - 8 * hour;
}

export class MonitorStore {
  constructor(file) {
    if (file !== ":memory:")
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, site TEXT NOT NULL, type TEXT NOT NULL, session TEXT NOT NULL,
        path TEXT NOT NULL, label TEXT NOT NULL, referrer TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_at_site ON events(at, site);
      CREATE TABLE IF NOT EXISTS probes (
        id TEXT NOT NULL, status TEXT NOT NULL, latency REAL, code INTEGER,
        checkedAt INTEGER NOT NULL, error TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS probes_id_at ON probes(id, checkedAt);`);
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES (?, ?)")
      .run("salt", randomBytes(32).toString("hex"));
    this.salt = this.db
      .prepare("SELECT value FROM settings WHERE name=?")
      .get("salt").value;
    this.eventInsert = this.db.prepare(
      "INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.probeInsert = this.db.prepare(
      "INSERT INTO probes VALUES (?, ?, ?, ?, ?, ?)",
    );
  }
  event(event, now = Date.now()) {
    const session = createHmac("sha256", this.salt)
      .update(chinaDayStart(now) + ":" + event.session)
      .digest("hex");
    return (
      this.eventInsert.run(
        event.id,
        event.site,
        event.type,
        session,
        event.path,
        event.label || "",
        event.referrer || "",
        now,
      ).changes > 0
    );
  }
  summary(now = Date.now(), site = "") {
    const start = chinaDayStart(now),
      scope = site ? " AND site=?" : "";
    const args = site ? [start, now, site] : [start, now];
    const counts = this.db
      .prepare(
        `SELECT
      COALESCE(SUM(type='pageview'),0) AS pv,
      COUNT(DISTINCT CASE WHEN type='pageview' THEN session END) AS uv,
      COALESCE(SUM(type='click'),0) AS clicks FROM events WHERE at>=? AND at<=?${scope}`,
      )
      .get(...args);
    const pages = this.db
      .prepare(
        `SELECT site,path,COUNT(*) AS views FROM events WHERE at>=? AND at<=?${scope} AND type='pageview' GROUP BY site,path ORDER BY views DESC,path LIMIT 8`,
      )
      .all(...args);
    const clickTargets = this.db
      .prepare(
        `SELECT site,path,label,COUNT(*) AS clicks FROM events WHERE at>=? AND at<=?${scope} AND type='click' GROUP BY site,path,label ORDER BY clicks DESC,label LIMIT 8`,
      )
      .all(...args);
    const sites = this.db
      .prepare(
        `SELECT site,SUM(type='pageview') AS pv,SUM(type='click') AS clicks FROM events WHERE at>=? AND at<=?${scope} GROUP BY site ORDER BY pv DESC`,
      )
      .all(...args);
    const from = Math.floor(now / hour) * hour - 23 * hour;
    const trendArgs = site ? [from, now, site] : [from, now];
    const buckets = this.db
      .prepare(
        `SELECT CAST(at/${hour} AS INTEGER)*${hour} AS at,SUM(type='pageview') AS pv,SUM(type='click') AS clicks FROM events WHERE at>=? AND at<=?${scope} GROUP BY CAST(at/${hour} AS INTEGER)`,
      )
      .all(...trendArgs);
    const byTime = new Map(buckets.map((row) => [row.at, row]));
    const trend = Array.from(
      { length: 24 },
      (_, i) =>
        byTime.get(from + i * hour) || {
          at: from + i * hour,
          pv: 0,
          clicks: 0,
        },
    );
    const collectedSince = this.db
      .prepare("SELECT MIN(at) AS first FROM events")
      .get().first;
    return {
      ...counts,
      pages,
      clickTargets,
      sites,
      trend,
      collectedSince,
      dayStart: start,
    };
  }
  probe(result) {
    this.probeInsert.run(
      result.id,
      result.status,
      result.latency,
      result.code ?? null,
      result.checkedAt,
      result.error || "",
    );
  }
  history(id, since = Date.now() - 86400000) {
    return this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM probes WHERE id=? AND checkedAt>=? ORDER BY checkedAt DESC LIMIT 60) ORDER BY checkedAt",
      )
      .all(id, since);
  }
  health(id, now = Date.now()) {
    const last = this.db
      .prepare(
        "SELECT * FROM probes WHERE id=? ORDER BY checkedAt DESC,rowid DESC LIMIT 1",
      )
      .get(id);
    const counts = this.db
      .prepare(
        "SELECT COUNT(*) AS total,SUM(status='up') AS good FROM probes WHERE id=? AND checkedAt>=?",
      )
      .get(id, now - 86400000);
    return {
      ...(last || {
        status: "pending",
        latency: null,
        checkedAt: null,
        code: null,
        error: "",
      }),
      uptime: counts.total ? (counts.good / counts.total) * 100 : null,
      samples: counts.total,
      history: this.history(id, now - 86400000),
    };
  }
  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM events WHERE at<?").run(now - 30 * 86400000);
    this.db
      .prepare("DELETE FROM probes WHERE checkedAt<?")
      .run(now - 30 * 86400000);
  }
  close() {
    this.db.close();
  }
}
