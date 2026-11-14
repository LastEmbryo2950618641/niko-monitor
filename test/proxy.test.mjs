import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";

// Opt-in checks exercise the real Nginx proxy without credentials or writes.
const origin = process.env.MONITOR_PROXY_ORIGIN;
const options = { skip: !origin };
function request(url, method = "GET", headers = {}, body) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method,
        headers,
        rejectUnauthorized: process.env.MONITOR_PROXY_INSECURE !== "1",
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error("Proxy check timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

test("HTTP monitor entry pages redirect to HTTPS before showing the login form", options, async () => {
  for (const path of ["/niko-monitor", "/niko-monitor/", "/niko-monitor/?from=bookmark", "/niko-monitor/index.html"]) {
    const url = new URL(path, origin);
    url.protocol = "http:";
    const response = await request(url);
    assert.equal(response.status, 308, path);
    const target = new URL(response.headers.location, url);
    assert.equal(target.origin, origin);
    assert.equal(target.pathname, path.split("?")[0] + (path === "/niko-monitor" ? "/" : ""));
    assert.equal(target.search, url.search);
    assert.equal((await request(target)).status, 200);
  }
});

test("HTTPS login keeps origin checks and HTTP visitor collection remains reachable", options, async () => {
  const login = new URL("/niko-monitor/api/login", origin);
  const headers = { Origin: origin, "Content-Type": "application/json" };
  const sameOrigin = await request(login, "POST", headers, "{}");
  assert.equal(sameOrigin.status, 400, "Same-origin requests must reach credential validation");
  assert.notEqual(JSON.parse(sameOrigin.text).error, "不允许跨站操作");
  for (const source of ["https://foreign.invalid", "null"]) {
    const rejected = await request(login, "POST", { ...headers, Origin: source }, "{}");
    assert.equal(rejected.status, 403);
  }
  const tracker = new URL("/niko-monitor/tracker.js", origin);
  tracker.protocol = "http:";
  assert.equal((await request(tracker)).status, 200);
  const collect = new URL("/niko-monitor/api/collect", tracker);
  const preflight = await request(collect, "OPTIONS", {
    Origin: tracker.origin,
    "Access-Control-Request-Method": "POST",
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], tracker.origin);
});
