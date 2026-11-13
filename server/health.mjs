export async function checkService(service, signal) {
  const began = performance.now();
  let code = null;
  try {
    const response = await fetch(service.url, {
      signal: AbortSignal.any([
        AbortSignal.timeout(service.timeoutMs || 5000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        "User-Agent": "niko-monitor/0.1",
        Accept:
          service.kind === "api" || service.kind === "npm"
            ? "application/json"
            : "text/html",
      },
    });
    code = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("HTTP " + code);
    }
    if (["api", "npm"].includes(service.kind)) {
      const reader = response.body.getReader();
      let content = "",
        length = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 131072) throw new Error("健康响应过大");
          content += decoder.decode(value, { stream: true });
        }
        content += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }
      const json = JSON.parse(content);
      if (!json || typeof json !== "object" || json.ok === false)
        throw new Error("API 健康状态异常");
      if (service.kind === "api" && json.ok !== true)
        throw new Error("API 未返回明确的健康状态");
      if (
        service.kind === "npm" &&
        (json.name !== "nikowenku-archive" || typeof json.version !== "string")
      )
        throw new Error("npm 包信息异常");
      if (
        service.readOnly &&
        json.readOnly !== true &&
        json.mode !== "read-only"
      )
        throw new Error("备用服务未处于只读模式");
    } else {
      await response.body?.cancel();
    }
    return {
      id: service.id,
      status: "up",
      latency: Math.round(performance.now() - began),
      code,
      checkedAt: Date.now(),
      error: "",
    };
  } catch (error) {
    return {
      id: service.id,
      status: "down",
      latency: Math.round(performance.now() - began),
      code,
      checkedAt: Date.now(),
      error:
        error.name === "TimeoutError"
          ? "请求超时"
          : error.message.slice(0, 120),
    };
  }
}
