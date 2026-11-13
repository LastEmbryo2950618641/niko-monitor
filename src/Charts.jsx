import { useId } from "react";
export const formatHour = (time) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
export function TrafficChart({ points = [], metric = "pv" }) {
  const id = useId().replaceAll(":", "");
  const max =
    Math.ceil(Math.max(4, ...points.map((point) => point[metric])) / 4) * 4;
  const line = points
    .map(
      (p, i) =>
        `${38 + (i * 718) / Math.max(1, points.length - 1)},${170 - (p[metric] / max) * 140}`,
    )
    .join(" ");
  const active = points.some((point) => point[metric] > 0);
  return (
    <div className="chart-wrap">
      <svg
        viewBox="0 0 780 210"
        role="img"
        aria-label={`最近 24 小时${metric === "pv" ? "访问量" : "点击量"}趋势`}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity=".22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1="38"
              x2="756"
              y1={170 - i * 35}
              y2={170 - i * 35}
              className="chart-grid"
            />
            <text
              x="26"
              y={174 - i * 35}
              textAnchor="end"
              className="chart-label"
            >
              {Math.round((max * i) / 4)}
            </text>
          </g>
        ))}
        {active && (
          <polygon points={`38,170 ${line} 756,170`} fill={`url(#${id})`} />
        )}
        {points.length > 0 && (
          <polyline
            points={line}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {points
          .filter((_, i) => i % 4 === 0 || i === points.length - 1)
          .map((p) => (
            <text
              key={p.at}
              x={38 + (points.indexOf(p) * 718) / 23}
              y="198"
              textAnchor="middle"
              className="chart-label"
            >
              {formatHour(p.at)}
            </text>
          ))}
      </svg>
      {!active && (
        <div className="chart-empty">
          暂无访问数据<span>接入采集后，真实访问将在这里逐小时呈现</span>
        </div>
      )}
    </div>
  );
}
export function Sparkline({ samples = [] }) {
  const points = samples.filter((sample) => sample.latency != null);
  if (points.length < 2) return <span className="muted small">积累样本中</span>;
  const max = Math.max(1, ...points.map((p) => p.latency));
  return (
    <svg
      className="sparkline"
      viewBox="0 0 120 30"
      role="img"
      aria-label="最近探测延迟"
    >
      <polyline
        points={points
          .map(
            (p, i) =>
              `${2 + (i * 116) / (points.length - 1)},${27 - (p.latency / max) * 23}`,
          )
          .join(" ")}
        fill="none"
        stroke={points.at(-1).status === "up" ? "var(--green)" : "var(--red)"}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
