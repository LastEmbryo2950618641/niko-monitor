/* Niko Monitor: anonymous sessions, no form values, no URL query strings. */
(() => {
  const script = document.currentScript;
  const site = script?.dataset.site;
  if (!site || window.__nikoMonitorInstalled || navigator.doNotTrack === "1")
    return;
  window.__nikoMonitorInstalled = true;
  const endpoint = new URL("api/collect", script.src).href;
  let session;
  const id = () =>
    crypto.randomUUID?.() ||
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  try {
    session = sessionStorage.getItem("niko-monitor-session") || id();
    sessionStorage.setItem("niko-monitor-session", session);
  } catch {
    session = id();
  }
  const pathOf = () =>
    (location.pathname + location.hash.split("?")[0]).slice(0, 300);
  function send(type, path, label = "") {
    try {
      const payload = JSON.stringify({
        id: id(),
        site,
        type,
        session,
        path,
        label: label.slice(0, 100),
        referrer: document.referrer ? new URL(document.referrer).hostname : "",
      });
      if (
        !navigator.sendBeacon?.(
          endpoint,
          new Blob([payload], { type: "text/plain;charset=UTF-8" }),
        )
      )
        fetch(endpoint, {
          method: "POST",
          body: payload,
          keepalive: true,
          credentials: "omit",
        }).catch(() => {});
    } catch {
      /* Monitoring must never interrupt the site. */
    }
  }
  let previous = "";
  const view = () => {
    const path = pathOf();
    if (path !== previous) {
      previous = path;
      send("pageview", path);
    }
  };
  view();
  addEventListener("hashchange", view);
  addEventListener("popstate", view);
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      view();
      return result;
    };
  }
  document.addEventListener(
    "click",
    (event) => {
      const element = event.target.closest?.(
        "a[href],button,[data-monitor-label]",
      );
      if (
        !element ||
        element.closest("[data-monitor-ignore],form") ||
        element.disabled
      )
        return;
      let path = pathOf();
      if (element.href) {
        try {
          const target = new URL(element.href, location.href);
          if (!/^https?:$/.test(target.protocol)) return;
          path =
            target.origin === location.origin
              ? target.pathname + target.hash.split("?")[0]
              : "/out/" + target.hostname + target.pathname;
        } catch {
          return;
        }
      }
      const label = (
        element.dataset.monitorLabel ||
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ");
      send("click", path.slice(0, 300), label);
    },
    { capture: true, passive: true },
  );
})();
