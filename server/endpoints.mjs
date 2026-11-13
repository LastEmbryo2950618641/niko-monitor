import { isIP } from "node:net";

// Templates are shared by the log sanitizer, aggregation and interface inventory.
export const endpoints = [
  ["GET", "/api/health", "文库健康", "niko-wenku", "health"],
  ["GET", "/api/library", "书库 / 搜索", "niko-wenku", "status"],
  ["GET", "/api/books/:book", "书籍详情", "niko-wenku"],
  ["GET", "/api/books/:book/chapters/:chapter", "章节内容", "niko-wenku"],
  ["GET", "/api/books/:book/files/:file", "文件下载", "niko-wenku"],
  ["GET", "/api/auth/session", "登录状态", "niko-wenku", "session"],
  ["GET", "/api/auth/captcha", "生成验证码", "niko-wenku"],
  ["GET", "/api/auth/captcha/:image.png", "验证码图片", "niko-wenku"],
  ["POST", "/api/auth/login", "登录", "niko-wenku"],
  ["POST", "/api/auth/register", "注册", "niko-wenku"],
  ["POST", "/api/auth/logout", "退出登录", "niko-wenku"],
  ["GET", "/api/worker/status", "扫描 / 更新状态", "niko-wenku", "protected"],
  ["POST", "/api/worker/start", "启动任务", "niko-wenku"],
  ["POST", "/api/worker/stop", "停止任务", "niko-wenku"],
  ["POST", "/api/publish", "发布书库", "niko-wenku"],
  ["GET", "/chat-api/health", "聊天服务健康", "niko-main", "health"],
  ["POST", "/chat-api/chat", "聊天请求", "niko-main"],
].map(([method, path, name, site, probe]) => ({
  id: `${method} ${path}`,
  method,
  path,
  name,
  site,
  probe,
}));

export function normalizeIp(value) {
  if (typeof value !== "string") return "";
  const ip =
    value.startsWith("::ffff:") && isIP(value.slice(7)) === 4
      ? value.slice(7)
      : value;
  if (!isIP(ip) || ip.includes("%")) return "";
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

export function clientIp(req) {
  const remote = normalizeIp(req.socket.remoteAddress);
  return ["127.0.0.1", "::1"].includes(remote)
    ? normalizeIp(req.headers["x-real-ip"]) || remote
    : remote;
}

export function normalizeEndpoint(path) {
  if (typeof path !== "string") return null;
  const clean = path
    .split(/[?#]/)[0]
    .replace(/^\/nikowenku-archive(?=\/api\/)/, "");
  for (const item of endpoints) {
    const pattern =
      "^" +
      item.path
        .split("/")
        .map((part) =>
          part.startsWith(":")
            ? part.endsWith(".png")
              ? "[^/]+\\.png"
              : "[^/]+"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/") +
      "$";
    if (new RegExp(pattern).test(clean))
      return { path: item.path, site: item.site };
  }
  if (clean.startsWith("/api/"))
    return { path: "/api/:unmatched", site: "niko-wenku" };
  if (clean.startsWith("/chat-api/"))
    return { path: "/chat-api/:unmatched", site: "niko-main" };
  return null;
}

export function parseAccessLine(line, now = Date.now()) {
  try {
    const row = JSON.parse(line),
      normalized = normalizeEndpoint(row.endpoint);
    const at = Math.round(Number(row.at) * 1000),
      latency = Number(row.seconds) * 1000;
    const code = Number(row.status),
      method = row.method;
    const ip = normalizeIp(row.ip);
    if (
      !normalized ||
      !ip ||
      !/^[a-f0-9]{32}$/i.test(row.id) ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        method,
      ) ||
      !Number.isInteger(code) ||
      code < 100 ||
      code > 599 ||
      !Number.isFinite(at) ||
      at < now - 30 * 86400000 ||
      at > now + 60000 ||
      !Number.isFinite(latency) ||
      latency < 0 ||
      latency > 86400000 ||
      row.probe === "1"
    )
      return null;
    return {
      id: row.id,
      ...normalized,
      ip,
      method,
      code,
      at,
      latency: Math.round(latency),
    };
  } catch {
    return null;
  }
}

export function endpointHealth(row, probe, now = Date.now()) {
  const recent = row?.lastAt && now - row.lastAt <= 5 * 60000;
  const active = probe?.checkedAt && now - probe.checkedAt <= 90000;
  if (active && probe.status === "down")
    return { status: "down", source: "probe" };
  if (recent && row.lastCode >= 500)
    return { status: "down", source: "traffic" };
  if (
    recent &&
    (row.recentErrors > 0 ||
      (row.lastCode >= 400 && ![401, 403].includes(row.lastCode)))
  )
    return { status: "warning", source: "traffic" };
  if (active)
    return {
      status: [401, 403].includes(probe.code) ? "protected" : "up",
      source: "probe",
    };
  if (recent)
    return {
      status: [401, 403].includes(row.lastCode) ? "protected" : "up",
      source: "traffic",
    };
  return { status: row?.lastAt ? "stale" : "pending", source: "traffic" };
}
