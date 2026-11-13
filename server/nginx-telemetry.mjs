import { endpoints } from "./endpoints.mjs";

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function nginxTelemetry(origin) {
  const host = new URL(origin).hostname;
  const probeHosts = ["127.0.0.1", "::1", host].map(escape).join("|");
  const patterns = [...new Set(endpoints.map((item) => item.path))].map(
    (path) => {
      const regex = path
        .split("/")
        .map((part) =>
          part.startsWith(":")
            ? part.endsWith(".png")
              ? "[^/]+\\.png"
              : "[^/]+"
            : escape(part),
        )
        .join("/");
      return `    "~^${path.startsWith("/api/") ? regex.replace("/api/", "/(?:nikowenku-archive/)?api/") : regex}$" "${path}";`;
    },
  );
  return `# Generated from server/endpoints.mjs. No queries, bodies or credentials are logged.
map $uri $niko_monitor_endpoint {
    default "";
${patterns.join("\n")}
    ~^/(?:nikowenku-archive/)?api/ /api/:unmatched;
    ~^/chat-api/ /chat-api/:unmatched;
}
map $niko_monitor_endpoint $niko_monitor_log { "" 0; default 1; }
map "$remote_addr|$http_user_agent" $niko_monitor_probe {
    default 0;
    "~^(${probeHosts})\\|niko-monitor/" 1;
}
log_format niko_monitor escape=json '{"id":"$request_id","ip":"$remote_addr","method":"$request_method","endpoint":"$niko_monitor_endpoint","status":"$status","seconds":"$request_time","at":"$msec","probe":"$niko_monitor_probe"}';
`;
}
