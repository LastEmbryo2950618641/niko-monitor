import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMonitor } from "./app.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.MONITOR_HOST || "127.0.0.1";
const port = Number(process.env.MONITOR_PORT || 4182);
let publicOrigin = process.env.MONITOR_PUBLIC_ORIGIN || "";
const development = process.argv.includes("--dev");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("MONITOR_PORT 必须为 1–65535");
if (!["127.0.0.1", "localhost", "::1"].includes(host) && !publicOrigin)
  throw new Error("公开监听必须设置 MONITOR_PUBLIC_ORIGIN");
if (publicOrigin) {
  const url = new URL(publicOrigin);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "MONITOR_PUBLIC_ORIGIN 必须是 HTTP(S) 来源，不包含路径或账号",
    );
  publicOrigin = url.origin;
}
if (
  development &&
  (publicOrigin || !["127.0.0.1", "localhost", "::1"].includes(host))
)
  throw new Error("开发模式只允许本机运行；公开部署请构建后使用 npm start");
const config = JSON.parse(
  await readFile(
    process.env.MONITOR_CONFIG || resolve(root, "monitor.config.json"),
    "utf8",
  ),
);
if (!Array.isArray(config.services) || !Array.isArray(config.sites))
  throw new Error("配置需要 sites 与 services 数组");
const ids = new Set();
for (const service of config.services) {
  if (
    !/^[a-z0-9-]+$/.test(service.id) ||
    ids.has(service.id) ||
    !/^https?:$/.test(new URL(service.url).protocol) ||
    !["web", "api", "npm"].includes(service.kind)
  )
    throw new Error("探测项 ID、类型或地址无效");
  ids.add(service.id);
}
const intervalMs = Number(process.env.MONITOR_INTERVAL_MS || 15000);
if (!Number.isInteger(intervalMs) || intervalMs < 5000 || intervalMs > 3600000)
  throw new Error("探测间隔必须在 5 秒至 1 小时之间");
let vite;
if (development) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
}
const monitor = createMonitor({
  ...config,
  dbFile: resolve(
    process.env.MONITOR_STATE_DIR || resolve(root, ".state"),
    "monitor.sqlite",
  ),
  publicOrigin,
  intervalMs,
  development,
  frontend: vite?.middlewares,
});
monitor.server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
monitor.server.listen(port, host, () => {
  console.log(`Niko Monitor: http://${host}:${port}/niko-monitor/`);
  monitor.start();
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await monitor.close();
    await vite?.close();
  });
