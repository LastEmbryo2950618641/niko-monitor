import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  ChevronRight,
  Clock3,
  Globe2,
  HeartPulse,
  LayoutDashboard,
  LockKeyhole,
  MousePointer2,
  PawPrint,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { request, useMonitor } from "./use-monitor";
import { TrafficChart, Sparkline, formatHour } from "./Charts";

const number = (value) =>
  value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value);
const dateTime = (time) =>
  time
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(time)
    : "等待首次探测";
function Login({ onSuccess }) {
  const [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("login", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setToken("");
      onSuccess();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <form className="login-form" onSubmit={submit}>
        <span className="brand-icon">
          <Activity />
        </span>
        <h1>Niko Monitor</h1>
        <p>输入访问密钥，进入监控中心。</p>
        <label htmlFor="token">访问密钥</label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "验证中…" : "进入监控中心"}
        </button>
      </form>
    </main>
  );
}
function Metric({ icon: Icon, label, value, note, color }) {
  return (
    <div className="metric">
      <div className="metric-label">
        <Icon size={16} />
        {label}
      </div>
      <strong className={color || ""}>{value}</strong>
      <span>{note}</span>
    </div>
  );
}
function Status({ status }) {
  return (
    <span className={"status " + status}>
      <i />
      {{ up: "正常", down: "异常", pending: "待检测" }[status] || "待检测"}
    </span>
  );
}
function ServiceList({ services = [], onSelect }) {
  return (
    <div className="service-list">
      {services.length === 0 ? (
        <div className="empty-row">当前站点尚未配置探测项</div>
      ) : (
        services.map((service) => (
          <button
            className="service-row"
            key={service.id}
            onClick={() => onSelect(service)}
          >
            <div className={"service-icon " + service.status}>
              {service.kind === "web" ? (
                <Globe2 size={19} />
              ) : (
                <Server size={19} />
              )}
            </div>
            <div className="service-name">
              <strong>{service.name}</strong>
              <span>
                {service.group || "服务"} · {dateTime(service.checkedAt)}
              </span>
            </div>
            <div className="service-spark">
              <Sparkline samples={service.history} />
            </div>
            <div className="service-latency">
              <strong>
                {service.latency == null ? "—" : number(service.latency)}
                <small> ms</small>
              </strong>
              <span>响应时间</span>
            </div>
            <div className="service-uptime">
              <strong>
                {service.uptime == null ? "—" : service.uptime.toFixed(1) + "%"}
              </strong>
              <span>24h 探测成功率</span>
            </div>
            <Status status={service.status} />
            <ChevronRight size={15} className="row-chevron" />
          </button>
        ))
      )}
    </div>
  );
}
function ServiceDetail({ service, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector("button")?.focus();
    const keydown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        dialog.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = before;
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 id="detail-title">{service.name}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭详情"
          >
            <X size={18} />
          </button>
        </header>
        <Status status={service.status} />
        <dl>
          <dt>探测地址</dt>
          <dd className="break-word">{service.url}</dd>
          <dt>最近检查</dt>
          <dd>{dateTime(service.checkedAt)}</dd>
          <dt>响应状态</dt>
          <dd>{service.code || "未收到响应"}</dd>
          <dt>探测样本</dt>
          <dd>{service.samples} 次（最近 24 小时）</dd>
          {service.error && (
            <>
              <dt>异常原因</dt>
              <dd className="error-text">{service.error}</dd>
            </>
          )}
        </dl>
        <h3>最近探测</h3>
        <div className="probe-strip">
          {service.history.map((sample, i) => (
            <span
              key={i}
              className={sample.status}
              title={`${dateTime(sample.checkedAt)} · ${sample.status === "up" ? "正常" : sample.error} · ${sample.latency} ms`}
            />
          ))}
        </div>
        <p className="muted small">
          探测成功率按已采集样本计算，并非上线以来的完整可用率。
        </p>
      </section>
    </div>
  );
}
export default function App() {
  const [site, setSite] = useState(""),
    [section, setSection] = useState("overview"),
    [metric, setMetric] = useState("pv"),
    [selected, setSelected] = useState(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const monitor = useMonitor(site),
    data = monitor.data,
    traffic = data?.traffic;
  const services = data?.services || [],
    up = services.filter((s) => s.status === "up").length,
    down = services.filter((s) => s.status === "down").length,
    ready = services.filter((s) => s.status !== "pending").length;
  const average = up
    ? Math.round(
        services
          .filter((s) => s.status === "up")
          .reduce((n, s) => n + s.latency, 0) / up,
      )
    : null;
  const liveSelected = selected
    ? services.find((s) => s.id === selected.id) || selected
    : null;
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
  if (monitor.needsLogin) return <Login onSuccess={monitor.reconnect} />;
  return (
    <div className="monitor-app">
      <aside className="sidebar">
        <a className="brand" href={import.meta.env.BASE_URL}>
          <span className="brand-icon">
            <Activity size={22} />
          </span>
          <div>
            Niko<span>MONITOR</span>
          </div>
        </a>
        <div className="nav-title">工作空间</div>
        <nav>
          {[
            { id: "overview", label: "总览", icon: LayoutDashboard },
            { id: "health", label: "服务健康", icon: HeartPulse },
            { id: "traffic", label: "访问分析", icon: BarChart3 },
          ].map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "active" : ""}
              onClick={() => setSection(item.id)}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === "health" && down > 0 && (
                <span className="count-badge">{down}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-title projects-title">已接入项目</div>
        <div className="project-list">
          <button onClick={() => setSite("niko-main")}>
            <span className="project-dot pink" />
            niko-main
          </button>
          <button onClick={() => setSite("niko-wenku")}>
            <span className="project-dot blue" />
            niko-wenku
          </button>
          <span>
            <span className="project-dot green" />
            niko-cli <small>分发检测</small>
          </span>
        </div>
        <div className="sidebar-footer">
          <PawPrint size={20} />
          <span>
            Niko 系列监控中心<small>独立采集 · 只读探测</small>
          </span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间
            <ChevronRight size={14} />
            <strong>
              {section === "overview"
                ? "总览"
                : section === "health"
                  ? "服务健康"
                  : "访问分析"}
            </strong>
          </div>
          <span className={"connection " + monitor.connection}>
            <Radio size={13} />
            {
              {
                live: "实时连接",
                connecting: "正在连接",
                reconnecting: "重新连接中",
                offline: "连接中断",
              }[monitor.connection]
            }
          </span>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <h1>
                {section === "overview"
                  ? "一眼，看见运行状态。"
                  : section === "health"
                    ? "服务健康"
                    : "访问分析"}
              </h1>
              <p>
                {section === "traffic"
                  ? "了解网站访问，以及每一次有价值的点击。"
                  : "主站、文库与命令分发，集中监测。"}
              </p>
            </div>
            <div className="page-actions">
              <label className="sr-only" htmlFor="site">
                筛选站点
              </label>
              <select
                id="site"
                value={site}
                onChange={(e) => setSite(e.target.value)}
              >
                <option value="">全部项目</option>
                {(
                  data?.sites || [
                    { id: "niko-main", name: "主站" },
                    { id: "niko-wenku", name: "轻小说文库" },
                  ]
                ).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                className="secondary"
                onClick={check}
                disabled={busy || !data}
              >
                <RefreshCw size={15} className={busy ? "spinning" : ""} />
                {busy ? "检测中" : "立即检测"}
              </button>
            </div>
          </div>
          {(monitor.error || notice) && (
            <div className="error-banner" role="alert">
              {monitor.error || notice}
              <button onClick={monitor.reconnect}>重新连接</button>
            </div>
          )}
          {section !== "traffic" && (
            <section
              className={
                "health-banner " +
                (down
                  ? "has-error"
                  : ready === services.length && ready > 0
                    ? "healthy"
                    : "waiting")
              }
            >
              <div className="health-symbol">
                {down ? <Activity size={24} /> : <ShieldCheck size={24} />}
              </div>
              <div>
                <strong>
                  {down
                    ? `${down} 项服务需要关注`
                    : ready > 0 && ready === services.length
                      ? "所有服务运行正常"
                      : "正在确认各项服务状态"}
                </strong>
                <p>
                  {down
                    ? services
                        .filter((s) => s.status === "down")
                        .map((s) => s.name)
                        .join("、")
                    : "独立探测，不影响文库扫描、更新与下载。"}
                </p>
              </div>
              <span>
                {up}/{services.length || "—"} 正常
                <small>约每 {(data?.intervalMs || 15000) / 1000} 秒检测</small>
              </span>
            </section>
          )}
          <section className="metrics" aria-label="今日统计">
            <Metric
              icon={Globe2}
              label="今日访问"
              value={number(traffic?.pv)}
              note="页面浏览量 · PV"
            />
            <Metric
              icon={Users}
              label="今日访客"
              value={number(traffic?.uv)}
              note="匿名浏览会话 · UV"
            />
            <Metric
              icon={MousePointer2}
              label="今日点击"
              value={number(traffic?.clicks)}
              note="链接、卡片与按钮"
            />
            <Metric
              icon={section === "traffic" ? Clock3 : HeartPulse}
              label="平均响应"
              value={average == null ? "—" : number(average) + " ms"}
              note="当前正常服务的探测延迟"
              color="green-text"
            />
          </section>
          {section !== "health" && (
            <section className="panel traffic-panel">
              <div className="panel-heading">
                <div>
                  <h2>访问趋势</h2>
                  <p>最近 24 小时 · 小时聚合</p>
                </div>
                <div className="segmented" aria-label="趋势指标">
                  <button
                    className={metric === "pv" ? "selected" : ""}
                    onClick={() => setMetric("pv")}
                  >
                    访问量
                  </button>
                  <button
                    className={metric === "clicks" ? "selected" : ""}
                    onClick={() => setMetric("clicks")}
                  >
                    点击量
                  </button>
                </div>
              </div>
              <TrafficChart points={traffic?.trend} metric={metric} />
            </section>
          )}
          {section !== "traffic" && (
            <section className="panel services-panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    服务状态
                    <span className="heading-count">{services.length}</span>
                  </h2>
                  <p>点击服务，查看最近探测记录与异常原因</p>
                </div>
                <span className="muted small">实时探测</span>
              </div>
              <ServiceList services={services} onSelect={setSelected} />
              <div className="panel-footnote">
                <Clock3 size={13} />
                最后同步 {dateTime(data?.now)}
                <span>探测数据自接入时开始累计</span>
              </div>
            </section>
          )}
          {section !== "health" && (
            <div className="rankings">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>热门页面</h2>
                    <p>今日浏览量</p>
                  </div>
                  <Globe2 size={17} className="muted" />
                </div>
                {traffic?.pages.length ? (
                  <div className="rank-list">
                    {traffic.pages.map((page, i) => (
                      <div key={page.site + page.path}>
                        <span className="rank-index">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <strong>{page.path}</strong>
                          <span>{page.site}</span>
                        </div>
                        <b>{number(page.views)}</b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <Globe2 size={25} />
                    <strong>还没有页面访问记录</strong>
                    <span>网站接入采集后自动显示</span>
                  </div>
                )}
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>点击排行</h2>
                    <p>今日链接与按钮点击</p>
                  </div>
                  <MousePointer2 size={17} className="muted" />
                </div>
                {traffic?.clickTargets.length ? (
                  <div className="rank-list">
                    {traffic.clickTargets.map((target, i) => (
                      <div key={target.site + target.path + target.label}>
                        <span className="rank-index">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <strong>{target.label || target.path}</strong>
                          <span>{target.site}</span>
                        </div>
                        <b>{number(target.clicks)}</b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <MousePointer2 size={25} />
                    <strong>等待第一次点击</strong>
                    <span>卡片、链接与按钮会分别统计</span>
                  </div>
                )}
              </section>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <LockKeyhole size={12} />
              会话匿名化 · 不采集表单内容
            </span>
            <span>今日统计以北京时间 00:00 为起点</span>
          </footer>
        </div>
      </main>
      {liveSelected && (
        <ServiceDetail
          service={liveSelected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
