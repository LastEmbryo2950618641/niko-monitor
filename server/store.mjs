import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { normalizeIp } from "./endpoints.mjs";

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
      CREATE INDEX IF NOT EXISTS probes_id_at ON probes(id, checkedAt);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, site TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
        ip TEXT NOT NULL, code INTEGER NOT NULL, latency REAL NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_at_site ON requests(at, site);
      CREATE INDEX IF NOT EXISTS requests_endpoint_at ON requests(site, method, path, at);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(events)")
        .all()
        .some((column) => column.name === "ip")
    )
      this.db.exec("ALTER TABLE events ADD COLUMN ip TEXT NOT NULL DEFAULT ''");
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES (?, ?)")
      .run("salt", randomBytes(32).toString("hex"));
    this.salt = this.db
      .prepare("SELECT value FROM settings WHERE name=?")
      .get("salt").value;
    this.eventInsert = this.db.prepare(
      "INSERT OR IGNORE INTO events (id,site,type,session,path,label,referrer,at,ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        normalizeIp(event.ip),
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
      ips: this.visitorCount(now, site),
      unknownIpViews: this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM events WHERE at>=? AND at<=?${scope} AND type='pageview' AND ip=''`,
        )
        .get(...args).total,
      pages,
      clickTargets,
      sites,
      trend,
      collectedSince,
      dayStart: start,
    };
  }
  setting(key) {
    return this.db.prepare("SELECT value FROM settings WHERE name=?").get(key)
      ?.value;
  }
  accessBatch(rows, checkpoint, offset) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO requests (id,site,method,path,ip,code,latency,at) VALUES (?,?,?,?,?,?,?,?)",
    );
    let count = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows)
        count += insert.run(
          row.id,
          row.site,
          row.method,
          row.path,
          row.ip,
          row.code,
          row.latency,
          row.at,
        ).changes;
      if (checkpoint)
        this.db
          .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
          .run(checkpoint, String(offset));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return count;
  }
  visitorSql(site) {
    const scope = site ? " AND site=?" : "";
    return `SELECT ip,site,at,1 AS pv,0 AS requests,0 AS errors FROM events WHERE at>=? AND at<=?${scope} AND type='pageview' AND ip<>''
      UNION ALL SELECT ip,site,at,0 AS pv,1 AS requests,code>=500 AS errors FROM requests WHERE at>=? AND at<=?${scope}`;
  }
  visitorArgs(now, site) {
    const args = [chinaDayStart(now), now, ...(site ? [site] : [])];
    return [...args, ...args];
  }
  visitorCount(now, site) {
    return this.db
      .prepare(
        `SELECT COUNT(DISTINCT ip) AS total FROM (${this.visitorSql(site)})`,
      )
      .get(...this.visitorArgs(now, site)).total;
  }
  visitors(now = Date.now(), site = "", page = 1, query = "") {
    const args = this.visitorArgs(now, site),
      source = this.visitorSql(site);
    const filter = " WHERE instr(ip,?)>0",
      size = 25;
    const total = this.db
      .prepare(`SELECT COUNT(DISTINCT ip) AS total FROM (${source})${filter}`)
      .get(...args, query).total;
    const pages = Math.max(1, Math.ceil(total / size));
    page = Math.max(1, Math.min(page, pages));
    const rows = this.db
      .prepare(
        `SELECT ip,GROUP_CONCAT(DISTINCT site) AS sites,SUM(pv) AS pv,SUM(requests) AS requests,
      SUM(errors) AS errors,MIN(at) AS firstAt,MAX(at) AS lastAt FROM (${source})${filter}
      GROUP BY ip ORDER BY lastAt DESC,ip LIMIT ? OFFSET ?`,
      )
      .all(...args, query, size, (page - 1) * size);
    return { rows, total, page, pages, size };
  }
  requests(now = Date.now(), site = "") {
    const start = chinaDayStart(now),
      scope = site ? " AND site=?" : "";
    const args = [start, now, ...(site ? [site] : [])];
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS total,COUNT(DISTINCT ip) AS ips,
      COALESCE(SUM(code>=500),0) AS serverErrors,COALESCE(SUM(code>=400 AND code<500),0) AS clientErrors,
      ROUND(AVG(latency)) AS latency FROM requests WHERE at>=? AND at<=?${scope}`,
      )
      .get(...args);
    const rows = this.db
      .prepare(
        `WITH recent AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY site,method,path ORDER BY at DESC,rowid DESC) AS rn
      FROM requests WHERE at>=? AND at<=?${scope})
      SELECT site,method,path,SUM(at>=?) AS requests,COUNT(DISTINCT CASE WHEN at>=? THEN ip END) AS ips,
      SUM(at>=? AND code>=500) AS serverErrors,SUM(at>=? AND code>=400 AND code<500) AS clientErrors,
      ROUND(AVG(CASE WHEN at>=? THEN latency END)) AS latency,
      SUM(at>=? AND code>=500) AS recentErrors,MAX(at) AS lastAt,MAX(CASE WHEN rn=1 THEN code END) AS lastCode
      FROM recent GROUP BY site,method,path ORDER BY requests DESC,path,method`,
      )
      .all(
        now - 30 * 86400000,
        now,
        ...(site ? [site] : []),
        start,
        start,
        start,
        start,
        start,
        now - 5 * 60000,
      );
    return {
      ...counts,
      endpoints: rows,
      collectedSince: this.db
        .prepare("SELECT MIN(at) AS first FROM requests")
        .get().first,
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
    this.db.prepare("DELETE FROM requests WHERE at<?").run(now - 30 * 86400000);
    this.db
      .prepare("DELETE FROM probes WHERE checkedAt<?")
      .run(now - 30 * 86400000);
  }
  close() {
    this.db.close();
  }
}
