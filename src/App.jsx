import { useEffect, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ChartNoAxesCombined,
  Globe2,
  LogOut,
  Network,
  RefreshCw,
  Search,
  Server,
  Users,
} from "lucide-react";
import { request, useMonitor } from "./use-monitor";
import { TrafficChart } from "./Charts";

const number = (value) =>
  value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value);
const time = (value) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(value)
    : "—";
const ms = (value) => (value == null ? "—" : `${number(value)} ms`);
const names = { "niko-main": "主站", "niko-wenku": "文库", "niko-cli": "CLI" };
function Status({ status }) {
  return (
    <span className={`status ${status}`}>
      <i />
      {{
        up: "正常",
        down: "异常",
        warning: "需关注",
        protected: "鉴权正常",
        pending: "待观测",
        stale: "无近期请求",
      }[status] || "待观测"}
    </span>
  );
}
function Login({ onSuccess }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setPassword("");
      onSuccess();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <form className="login-form" onSubmit={submit}>
        <Activity size={28} className="accent" />
        <h1>Niko Monitor</h1>
        <p className="muted">使用 Niko 管理员账号登录。</p>
        <label htmlFor="username">管理员账号</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          maxLength={64}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="password">管理员密码</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "验证中…" : "进入监控中心"}
        </button>
      </form>
    </main>
  );
}
function ServiceList({ services }) {
  const up = services.filter((item) => item.status === "up").length;
  return (
    <section className="panel">
      <header className="panel-heading">
        <h2>服务状态</h2>
        <span className="muted">
          {up} / {services.length} 正常
        </span>
      </header>
      <div className="service-list">
        {services.map((item) => (
          <details key={item.id} className="service-item">
            <summary>
              {item.kind === "web" ? (
                <Globe2 size={16} />
              ) : (
                <Server size={16} />
              )}
              <strong>{item.name}</strong>
              <span className="mono muted service-ms">{ms(item.latency)}</span>
              <Status status={item.status} />
            </summary>
            <div className="detail-content">
              <p className="mono route">{item.url}</p>
              <p>
                最近探测 {time(item.checkedAt)} · HTTP {item.code || "—"}
              </p>
              <p>
                24 小时探测成功率{" "}
                {item.uptime == null ? "—" : item.uptime.toFixed(1) + "%"}（
                {number(item.samples)} 个样本）
              </p>
              {item.error && <p className="error-text">{item.error}</p>}
              <div className="probe-strip" aria-label="最近探测记录">
                {(item.history || []).map((probe, index) => (
                  <span
                    key={index}
                    className={probe.status}
                    title={`${time(probe.checkedAt)} · ${probe.code || probe.error}`}
                  />
                ))}
              </div>
            </div>
          </details>
        ))}
        {!services.length && <p className="empty">此项目未配置服务探测。</p>}
      </div>
    </section>
  );
}
function Rankings({ traffic }) {
  return (
    <details className="panel ranking-details">
      <summary>
        页面与点击排行
        <span className="muted">今日点击 {number(traffic?.clicks)}</span>
      </summary>
      <div className="rankings">
        {[
          { name: "页面浏览", rows: traffic?.pages, key: "views" },
          {
            name: "链接 / 按钮点击",
            rows: traffic?.clickTargets,
            key: "clicks",
          },
        ].map((group) => (
          <section key={group.name}>
            <h3>{group.name}</h3>
            {group.rows?.length ? (
              group.rows.map((row, index) => (
                <div className="rank-row" key={index}>
                  <span className="route">
                    {row.label || row.path}
                    <small>{names[row.site] || row.site}</small>
                  </span>
                  <b>{number(row[group.key])}</b>
                </div>
              ))
            ) : (
              <p className="empty">暂无记录</p>
            )}
          </section>
        ))}
      </div>
    </details>
  );
}
function Visitors({ site, updatedAt, unknown }) {
  const [page, setPage] = useState(1),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [result, setResult] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      page: String(page),
      q: search,
      ...(site ? { site } : {}),
    });
    request("visitors?" + params, { signal: controller.signal })
      .then((value) => {
        setResult(value);
        setError("");
      })
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, [site, page, search, updatedAt]);
  return (
    <section className="panel">
      <header className="panel-heading">
        <div>
          <h2>
            访问 IP{" "}
            <span className="heading-count">{number(result?.total)}</span>
          </h2>
          <p>今日浏览与接口请求合并去重，按最近访问排序。</p>
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="搜索 IP"
            placeholder="搜索 IP"
            maxLength={45}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </header>
      {error && (
        <p role="alert" className="error-text note">
          {error}
        </p>
      )}
      <div className="table-scroll">
        <table className="ip-table">
          <thead>
            <tr>
              <th>IP 地址</th>
              <th>项目</th>
              <th>页面浏览</th>
              <th>接口请求</th>
              <th>5xx</th>
              <th>最近访问</th>
            </tr>
          </thead>
          <tbody>
            {result?.rows.map((row) => (
              <tr key={row.ip}>
                <td className="mono">{row.ip}</td>
                <td>
                  {row.sites
                    .split(",")
                    .map((site) => names[site] || site)
                    .join(" / ")}
                </td>
                <td>{number(row.pv)}</td>
                <td>{number(row.requests)}</td>
                <td className={row.errors ? "error-text" : "muted"}>
                  {number(row.errors)}
                </td>
                <td className="mono muted">{time(row.lastAt)}</td>
              </tr>
            ))}
            {!result?.rows.length && (
              <tr>
                <td colSpan={6} className="empty">
                  {result ? "暂无匹配的访问记录" : "正在读取…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="table-footer">
        <span>
          IP 不等于独立人数；共享网络会合并。
          {unknown > 0 ? ` 今日 ${number(unknown)} 次历史浏览未记录 IP。` : ""}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="上一页"
            disabled={!result || result.page <= 1}
            onClick={() => setPage(result.page - 1)}
          >
            <ArrowLeft size={16} />
          </button>
          <span>
            {result?.page || 1} / {result?.pages || 1}
          </span>
          <button
            className="icon-button"
            aria-label="下一页"
            disabled={!result || result.page >= result.pages}
            onClick={() => setPage(result.page + 1)}
          >
            <ArrowRight size={16} />
          </button>
        </div>
      </footer>
    </section>
  );
}
const order = {
  down: 0,
  warning: 1,
  up: 2,
  protected: 2,
  stale: 3,
  pending: 4,
};
function Interfaces({ data }) {
  const [query, setQuery] = useState(""),
    [onlyProblems, setOnlyProblems] = useState(false);
  const rows = (data?.endpoints || [])
    .filter(
      (row) =>
        `${row.name} ${row.method} ${row.path}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (!onlyProblems || ["down", "warning"].includes(row.status)),
    )
    .sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        b.requests - a.requests ||
        a.path.localeCompare(b.path),
    );
  return (
    <section className="panel">
      <header className="panel-heading">
        <div>
          <h2>接口监控</h2>
          <p>读接口安全探测，其余依据实际响应；无请求时不推断健康。</p>
        </div>
        <div className="interface-filters">
          <label className="filter-check">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            只看异常
          </label>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索接口"
              placeholder="搜索接口"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      </header>
      <div className="table-scroll">
        <table className="endpoint-table">
          <thead>
            <tr>
              <th>接口 / 路径</th>
              <th>健康</th>
              <th>请求</th>
              <th>IP</th>
              <th>平均耗时</th>
              <th>4xx / 5xx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <details className="endpoint-detail">
                    <summary>
                      <strong>{row.name}</strong>
                      <span className="endpoint-path">
                        <b
                          className={`method ${row.method === "POST" ? "post" : ""}`}
                        >
                          {row.method}
                        </b>
                        <code>{row.path}</code>
                      </span>
                    </summary>
                    <div className="detail-content">
                      <p>
                        判断来源：
                        {row.source === "probe"
                          ? "只读主动探测"
                          : "最近 5 分钟真实请求"}
                      </p>
                      <p>
                        最近请求 {time(row.lastAt)} · HTTP {row.lastCode || "—"}
                      </p>
                      {row.probe && (
                        <p>
                          最近探测 {time(row.probe.checkedAt)} · HTTP{" "}
                          {row.probe.code || "—"}
                        </p>
                      )}
                      {row.probe?.error && (
                        <p className="error-text">{row.probe.error}</p>
                      )}
                      {row.path.endsWith(":unmatched") && (
                        <p>未匹配已知路由的请求合并记录，不保存原始路径。</p>
                      )}
                    </div>
                  </details>
                </td>
                <td>
                  <Status status={row.status} />
                </td>
                <td>{number(row.requests)}</td>
                <td>{number(row.ips)}</td>
                <td className="mono">{ms(row.latency)}</td>
                <td>
                  <span className={row.clientErrors ? "amber" : "muted"}>
                    {number(row.clientErrors)}
                  </span>{" "}
                  /{" "}
                  <span className={row.serverErrors ? "error-text" : "muted"}>
                    {number(row.serverErrors)}
                  </span>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="empty">
                  暂无匹配接口
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="note">
        请求统计为今日累计，排除监控探测。401 / 403 单独计入
        4xx，不视为服务宕机。点击接口展开详情。
      </p>
    </section>
  );
}
export default function App() {
  const [site, setSite] = useState(""),
    [tab, setTab] = useState("overview"),
    [metric, setMetric] = useState("pv"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const monitor = useMonitor(site),
    data = monitor.data,
    traffic = data?.traffic,
    api = data?.requests;
  async function check() {
    setBusy(true);
    setNotice("");
    try {
      await request(
        "check" + (site ? "?site=" + encodeURIComponent(site) : ""),
        { method: "POST" },
      );
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await request("logout", { method: "POST" });
      monitor.reconnect();
    } catch (error) {
      setNotice(error.message);
    }
  }
  if (monitor.needsLogin) return <Login onSuccess={monitor.reconnect} />;
  return (
    <main className="monitor-app">
      <header className="app-header">
        <a href={import.meta.env.BASE_URL} className="brand">
          <Activity size={24} />
          <h1>
            Niko <span>Monitor</span>
          </h1>
        </a>
        <div className="header-actions">
          <span className={`connection ${monitor.connection}`}>
            <i />
            {monitor.connection === "live" ? "实时" : "连接中"}
          </span>
          <select
            aria-label="筛选项目"
            value={site}
            onChange={(e) => setSite(e.target.value)}
          >
            <option value="">全部项目</option>
            {(data?.sites || []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            <option value="niko-cli">CLI 分发</option>
          </select>
          <button
            className="icon-button"
            aria-label="立即检测"
            title="立即检测"
            disabled={busy || !data}
            onClick={check}
          >
            <RefreshCw size={17} className={busy ? "spinning" : ""} />
          </button>
          <button
            className="icon-button"
            aria-label="退出登录"
            title="退出登录"
            onClick={logout}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <nav className="tabs" aria-label="监控视图">
        {[
          { id: "overview", label: "概览", Icon: ChartNoAxesCombined },
          { id: "visitors", label: "访问 IP", Icon: Users },
          { id: "interfaces", label: "接口", Icon: Network },
        ].map(({ id, label, Icon }) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
        <span>今日 · 北京时间</span>
      </nav>
      {(monitor.error || notice) && (
        <p className="error-banner" role="alert">
          {monitor.error || notice}
          <button onClick={monitor.reconnect}>重连</button>
        </p>
      )}
      {data && data.ingestion.status !== "up" && (
        <p className="collection-notice">
          {data.ingestion.enabled
            ? data.ingestion.error || "接口采集连接中…"
            : "此环境未启用服务端日志采集；接口请求统计等待接入。"}
        </p>
      )}
      {data?.ingestion.lagBytes > 262144 && (
        <p className="collection-notice">
          正在追赶接口日志，统计可能稍有延迟。
        </p>
      )}
      {!data ? (
        <p className="empty" role="status">
          正在读取监控数据…
        </p>
      ) : (
        <>
          {tab === "overview" && (
            <>
              <section className="metrics" aria-label="今日统计">
                {[
                  {
                    label: "页面浏览",
                    value: traffic?.pv,
                    note: "PV · 浏览器采集",
                  },
                  {
                    label: "访问 IP",
                    value: traffic?.ips,
                    note: "浏览与接口去重",
                  },
                  {
                    label: "接口请求",
                    value: api?.total,
                    note: "包含 CLI 调用",
                  },
                  {
                    label: "服务端错误",
                    value: api?.serverErrors,
                    note: "HTTP 5xx",
                    error: api?.serverErrors > 0,
                  },
                ].map((item) => (
                  <div className="metric" key={item.label}>
                    <span>{item.label}</span>
                    <strong className={item.error ? "error-text" : ""}>
                      {number(item.value)}
                    </strong>
                    <small>{item.note}</small>
                  </div>
                ))}
              </section>
              <div className="overview-grid">
                <section className="panel">
                  <header className="panel-heading">
                    <div>
                      <h2>访问趋势</h2>
                      <p>最近 24 小时</p>
                    </div>
                    <div className="segmented">
                      {[
                        { id: "pv", label: "浏览" },
                        { id: "clicks", label: "点击" },
                      ].map((item) => (
                        <button
                          key={item.id}
                          className={metric === item.id ? "selected" : ""}
                          onClick={() => setMetric(item.id)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </header>
                  <TrafficChart points={traffic?.trend} metric={metric} />
                </section>
                <ServiceList services={data.services} />
              </div>
              <Rankings traffic={traffic} />
            </>
          )}
          {tab === "visitors" && (
            <Visitors
              key={site}
              site={site}
              updatedAt={data.now}
              unknown={traffic?.unknownIpViews}
            />
          )}
          {tab === "interfaces" && <Interfaces key={site} data={api} />}
          <footer className="app-footer">
            <span>同步于 {time(data.now)}</span>
            <span>约 {data.intervalMs / 1000} 秒探测 · 原始数据保留 30 天</span>
          </footer>
        </>
      )}
    </main>
  );
}
