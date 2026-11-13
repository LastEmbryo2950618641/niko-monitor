import { useCallback, useEffect, useRef, useState } from "react";
const base = import.meta.env.BASE_URL;
export async function request(path, options = {}) {
  const response = await fetch(base + "api/" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || "请求失败"), {
      status: response.status,
    });
  return result;
}
export function useMonitor(site) {
  const [data, setData] = useState(null),
    [connection, setConnection] = useState("connecting"),
    [error, setError] = useState(""),
    [needsLogin, setNeedsLogin] = useState(false),
    [generation, setGeneration] = useState(0);
  const source = useRef(null);
  useEffect(() => {
    let active = true;
    setConnection("connecting");
    setData(null);
    setError("");
    const suffix = site ? "?site=" + encodeURIComponent(site) : "";
    request("snapshot" + suffix)
      .then((snapshot) => {
        if (!active) return;
        setData(snapshot);
        setNeedsLogin(false);
        const stream = new EventSource(base + "api/events" + suffix);
        source.current = stream;
        stream.onopen = () => {
          if (active) {
            setConnection("live");
            setError("");
          }
        };
        stream.addEventListener("snapshot", (event) => {
          if (active) {
            setData(JSON.parse(event.data));
            setConnection("live");
            setError("");
          }
        });
        stream.onerror = () => {
          if (!active) return;
          setConnection("reconnecting");
          request("snapshot" + suffix)
            .then((snapshot) => {
              if (active) setData(snapshot);
            })
            .catch((reason) => {
              if (!active) return;
              if (reason.status === 401) {
                stream.close();
                setNeedsLogin(true);
              } else setError("实时连接断开，正在自动重连");
            });
        };
      })
      .catch((reason) => {
        if (active) {
          setConnection("offline");
          if (reason.status === 401) setNeedsLogin(true);
          else setError(reason.message);
        }
      });
    return () => {
      active = false;
      source.current?.close();
    };
  }, [site, generation]);
  const reconnect = useCallback(() => setGeneration((n) => n + 1), []);
  return { data, connection, error, needsLogin, reconnect };
}
