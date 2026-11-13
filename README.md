# Niko Monitor

Niko 系列独立监控中心，以子模块接入 `niko-archive`。不启动扫描或下载任务，不修改书库及工作进程。

## 本地运行

需要 Node.js 22.13+。后端使用内置 HTTP、SQLite 和加密模块，前端使用 React + Vite。

```sh
npm ci
npm test
npm run build
npm start
```

打开 `http://127.0.0.1:4182/niko-monitor/`。开发模式为 `npm run dev`，默认只监听本机。

## 当前能力

- 定时 HTTP/JSON 健康探测、响应时间、异常原因、最近记录与 24 小时样本成功率。
- 默认检测真实线上首页、文库、公共 API 和 `nikowenku-archive` npm 包；生产配置另含主后端与只读备用后端的直接探测，避免备用掩盖主服务故障。
- 页面访问 PV、匿名会话 UV、卡片/链接/按钮点击、热门页面和点击排行。
- SQLite 持久化、事件 ID 去重、北京时间每日统计、24 小时趋势、30 天原始样本保留。
- SSE 实时推送与重连、站点筛选、手动检查、桌面及手机布局。
- 公开部署使用访问密钥登录与 HttpOnly 会话；公开采集端点校验站点和 Origin 白名单。

数据从接入时开始累计，没有数据时显示零和空状态。UV 是匿名浏览会话数，不是经身份识别的独立自然人数；无 JavaScript、拒绝跟踪或拦截 SDK 的访问不计入浏览器统计。成功率按实际探测样本计算，不伪造历史可用率。

## 点击采集

在网站页面引入脚本，主站与文库分别使用自己的站点 ID：

```html
<script defer src="/niko-monitor/tracker.js" data-site="niko-main"></script>
<!-- 文库使用 data-site="niko-wenku" -->
```

记录首次访问、前端路由变化与链接/按钮点击。`data-monitor-label` 可指定点击标签，`data-monitor-ignore` 可排除区域；表单区域不采集点击。不采集输入值、正文或 URL 查询参数，会话 ID 每日 HMAC 匿名化，不持久化原始 IP 或会话 ID。尊重 Do Not Track，采集失败不影响导航。

主站与文库源码已配置生产环境加载，本机及 `file:` 预览不向线上发送数据。部署顺序是监控服务、Nginx 代理、带采集入口的网站。新增域名时更新 `sites[].origins`，不使用通配 Origin。

## 配置

`monitor.config.json` 用于本地探测公开端点，`monitor.config.production.json` 用于文库所在服务器，可直接检测 4178/4179 端口。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MONITOR_HOST` | `127.0.0.1` | 监听地址 |
| `MONITOR_PORT` | `4182` | 独立端口 |
| `MONITOR_CONFIG` | `monitor.config.json` | 配置文件绝对路径 |
| `MONITOR_STATE_DIR` | `.state` | 独立数据库目录 |
| `MONITOR_INTERVAL_MS` | `15000` | 每轮完成后等待的探测间隔，至少 5 秒 |
| `MONITOR_TOKEN` | 空 | 生产访问密钥，至少 24 字符 |
| `MONITOR_PUBLIC_ORIGIN` | 空 | 公开 origin，不含路径，如 `https://111.229.32.85` |

采集接口 `POST /niko-monitor/api/collect` 公开但校验来源；快照 `/niko-monitor/api/snapshot` 和 SSE `/niko-monitor/api/events` 在生产环境需要登录。SDK 和健康接口允许公开读取。

## 服务器部署

生产服务独立安装，现有主站发布脚本暂不自动安装它。先在构建机执行 `npm ci && npm run build`；发布目录 `/srv/niko-archive/niko-monitor` 包含 `server/`、`public/tracker.js`、`dist/` 和配置文件即可，运行不依赖 `node_modules`。服务器需要 Node.js 22.13+。

1. 安全创建 `/etc/niko-monitor.env`，配置 `MONITOR_PUBLIC_ORIGIN=https://111.229.32.85` 和强随机 `MONITOR_TOKEN`。文件仅允许 root 读取，不提交 Git；在页面登录框输入密钥，不将其放入 URL。
2. 安装 `deploy/niko-monitor.service` 至 `/etc/systemd/system/`，核对用户及 Node 路径，再执行 `sudo systemctl daemon-reload && sudo systemctl enable --now niko-monitor`。
3. 确认 `curl http://127.0.0.1:4182/api/health` 返回 `{"ok":true,"service":"niko-monitor"}`。
4. 把 `deploy/nginx-monitor.conf` 包含进现有 `server {}` 块，`sudo nginx -t` 通过后仅 reload Nginx，保留文库主备 upstream 与工作进程。
5. 登录 `/niko-monitor/`，确认六个探测项，再发布带采集入口的主站与文库，通过真实访问验证计数增长。

数据库为 `/var/lib/niko-monitor/monitor.sqlite`，使用 WAL；备份应使用 SQLite 一致性备份，或停监控服务后复制整个状态目录，不在写入时单独复制主数据库文件。监控故障不影响主站、文库和 CLI。
