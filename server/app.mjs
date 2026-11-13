import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MonitorStore } from "./store.mjs";
import { checkService } from "./health.mjs";

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0,
      chunks = [],
      failed = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        if (!failed) reject(fail(413, "请求过大"));
        failed = true;
        chunks = [];
      } else if (!failed) chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(fail(400, "JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

export function createMonitor({
  dbFile,
  sites = [],
  services = [],
  token = "",
  publicOrigin = "",
  intervalMs = 15000,
  frontend,
  development = false,
} = {}) {
  const store = new MonitorStore(dbFile);
  const peers = new Map(),
    sessions = new Map(),
    rates = new Map();
  const shutdown = new AbortController();
  let timer,
    pending,
    notifyTimer,
    closed = false;
  const snapshot = (site = "") => ({
    now: Date.now(),
    intervalMs,
    sites: sites.map(({ id, name, url }) => ({ id, name, url })),
    traffic: store.summary(Date.now(), site),
    services: services
      .filter((item) => !site || item.site === site)
      .map(({ id, name, site, url, kind, group }) => ({
        id,
        name,
        site,
        url,
        kind,
        group,
        ...store.health(id),
      })),
  });
  function notify() {
    if (closed || notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const [res, peer] of peers) {
        if (token && !sessions.has(peer.session)) {
          res.end();
          continue;
        }
        if (!res.destroyed && !res.writableNeedDrain)
          res.write(
            "event: snapshot\ndata: " +
              JSON.stringify(snapshot(peer.site)) +
              "\n\n",
          );
      }
    }, 100);
    notifyTimer.unref();
  }
  async function poll() {
    if (closed) return;
    if (pending) return pending;
    pending = Promise.all(
      services.map(async (service) => {
        const result = await checkService(service, shutdown.signal);
        if (!closed) store.probe(result);
      }),
    )
      .then(() => {
        if (!closed) notify();
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  const sessionOf = (req) =>
    /(?:^|;\s*)niko_monitor=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
  const authenticated = (req) => {
    if (!token) return true;
    const key = sessionOf(req),
      expires = sessions.get(key);
    if (!expires || expires < Date.now()) {
      sessions.delete(key);
      return false;
    }
    return true;
  };
  const ownOrigin = (req) => publicOrigin || "http://" + req.headers.host;
  function sameOrigin(req) {
    if (req.headers.origin !== ownOrigin(req))
      throw fail(403, "不允许跨站操作");
  }
  async function handler(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!development)
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/^\/niko-monitor(?=\/|$)/, "") || "/";
    if (path === "/api/collect") {
      const origin = req.headers.origin;
      const allowed = sites.some((site) => site.origins?.includes(origin));
      if (!allowed) throw fail(403, "未授权的数据来源");
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (req.method !== "POST") throw fail(405, "仅允许 POST");
      const key = req.socket.remoteAddress;
      const rate = rates.get(key) || { since: Date.now(), count: 0 };
      if (Date.now() - rate.since > 60000) {
        rate.since = Date.now();
        rate.count = 0;
      }
      rate.count++;
      rates.set(key, rate);
      if (rate.count > 3000) throw fail(429, "采集请求过于频繁");
      const event = await readJson(req);
      if (
        !event ||
        typeof event !== "object" ||
        !sites.some((site) => site.id === event.site)
      )
        throw fail(400, "站点无效");
      if (
        !sites.find((site) => site.id === event.site).origins?.includes(origin)
      )
        throw fail(403, "站点与来源不匹配");
      if (
        !["pageview", "click"].includes(event.type) ||
        !/^[A-Za-z0-9_-]{8,80}$/.test(event.id || "") ||
        !/^[A-Za-z0-9_-]{8,80}$/.test(event.session || "")
      )
        throw fail(400, "事件无效");
      if (
        typeof event.path !== "string" ||
        !event.path.startsWith("/") ||
        event.path.length > 300 ||
        /[?\x00-\x1f]/.test(event.path)
      )
        throw fail(400, "路径必须移除查询参数");
      if (typeof event.label !== "string" || event.label.length > 100)
        throw fail(400, "标签无效");
      event.referrer =
        typeof event.referrer === "string" &&
        /^[A-Za-z0-9.-]{0,200}$/.test(event.referrer)
          ? event.referrer
          : "";
      const accepted = store.event(event);
      json(res, 202, { accepted });
      notify();
      return;
    }
    if (path === "/tracker.js" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      res.end(await readFile(new URL("../public/tracker.js", import.meta.url)));
      return;
    }
    if (path === "/api/health" && req.method === "GET") {
      json(res, 200, { ok: true, service: "niko-monitor" });
      return;
    }
    const hostname = new URL("http://" + req.headers.host).hostname;
    const trustedHosts = [
      "localhost",
      "127.0.0.1",
      "[::1]",
      ...(publicOrigin ? [new URL(publicOrigin).hostname] : []),
    ];
    if (!trustedHosts.includes(hostname)) throw fail(403, "未授权的监控主机");
    if (path === "/api/login" && req.method === "POST") {
      sameOrigin(req);
      const body = await readJson(req);
      if (!token || !equal(body?.token, token))
        throw fail(401, "访问密钥不正确");
      for (const [key, expires] of sessions)
        if (expires < Date.now()) sessions.delete(key);
      if (sessions.size >= 100) throw fail(429, "会话数量已达上限");
      const session = randomBytes(32).toString("hex");
      sessions.set(session, Date.now() + 43200000);
      res.setHeader(
        "Set-Cookie",
        `niko_monitor=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${ownOrigin(req).startsWith("https:") ? "; Secure" : ""}`,
      );
      json(res, 200, { ok: true });
      return;
    }
    if (path.startsWith("/api/")) {
      if (!authenticated(req)) throw fail(401, "请先登录监控中心");
      const site = url.searchParams.get("site") || "";
      if (site && !sites.some((item) => item.id === site))
        throw fail(400, "站点无效");
      if (path === "/api/logout" && req.method === "POST") {
        sameOrigin(req);
        sessions.delete(sessionOf(req));
        res.setHeader(
          "Set-Cookie",
          "niko_monitor=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        );
        for (const [peer, info] of peers)
          if (info.session === sessionOf(req)) peer.end();
        json(res, 200, { ok: true });
        return;
      }
      if (path === "/api/snapshot" && req.method === "GET") {
        json(res, 200, snapshot(site));
        return;
      }
      if (path === "/api/check" && req.method === "POST") {
        sameOrigin(req);
        await poll();
        json(res, 200, snapshot(site));
        return;
      }
      if (path === "/api/events" && req.method === "GET") {
        if (peers.size >= 64) throw fail(503, "实时连接数量已达上限");
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(
          "event: snapshot\ndata: " + JSON.stringify(snapshot(site)) + "\n\n",
        );
        peers.set(res, { site, session: sessionOf(req) });
        const heartbeat = setInterval(() => {
          if (token && !authenticated(req)) {
            res.end();
            return;
          }
          res.write(": heartbeat\n\n");
        }, 15000);
        heartbeat.unref();
        res.on("close", () => {
          clearInterval(heartbeat);
          peers.delete(res);
        });
        return;
      }
      throw fail(404, "接口不存在");
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      throw fail(405, "方法不允许");
    if (frontend) {
      frontend(req, res, () => json(res, 404, { error: "页面不存在" }));
      return;
    }
    const root = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
    const file = resolve(root, "." + decodeURIComponent(path));
    if (!file.startsWith(root + sep) && file !== root)
      throw fail(403, "路径无效");
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };
    const target = path === "/" ? resolve(root, "index.html") : file;
    try {
      const content = await readFile(target);
      res.writeHead(200, {
        "Content-Type": mime[extname(target)] || "application/octet-stream",
        "Cache-Control": path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (error.code === "ENOENT")
        throw fail(404, "页面不存在，请先运行 npm run build");
      throw error;
    }
  }
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent)
        json(res, error.status || 500, {
          error: error.status ? error.message : "监控服务内部错误",
        });
      else res.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const maintenance = setInterval(() => {
    store.prune();
    for (const [key, rate] of rates)
      if (Date.now() - rate.since > 60000) rates.delete(key);
  }, 3600000);
  maintenance.unref();
  return {
    server,
    store,
    snapshot,
    poll,
    start() {
      const loop = async () => {
        try {
          await poll();
        } catch (error) {
          console.error("健康探测失败：", error.message);
        }
        if (!closed) {
          timer = setTimeout(loop, intervalMs);
          timer.unref();
        }
      };
      store.prune();
      void loop();
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(notifyTimer);
      clearInterval(maintenance);
      shutdown.abort();
      for (const res of peers.keys()) res.end();
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
      await pending;
      store.close();
    },
  };
}
