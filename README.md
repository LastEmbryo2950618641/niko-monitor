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
- 访问 IP：服务端识别 IPv4/IPv6，浏览器访问与 API 调用合并去重，支持按项目筛选、IP 搜索和分页。
- 逐接口统计：方法、归一化路径、请求量、独立 IP、平均耗时、4xx/5xx；兼容旧 CLI 的 `/api/` 与网站的 `/nikowenku-archive/api/`，合并相同业务接口。
- 精简为概览、访问 IP、接口三个视图；仅概览展示关键数字，历史和诊断细节折叠查看。
- SQLite 持久化、事件 ID 去重、北京时间每日统计、24 小时趋势、30 天原始样本保留。
- SSE 实时推送与重连、站点筛选、手动检查、桌面及手机布局。
- 使用固定的 Niko 管理员账号、密码登录与 HttpOnly 会话；公开采集端点校验站点和 Origin 白名单。

数据从接入时开始累计，没有数据时显示零和空状态。UV 是匿名浏览会话数，不是经身份识别的独立自然人数；无 JavaScript、拒绝跟踪或拦截 SDK 的访问不计入浏览器统计。成功率按实际探测样本计算，不伪造历史可用率。

## 点击采集

在网站页面引入脚本，主站与文库分别使用自己的站点 ID：

```html
<script defer src="/niko-monitor/tracker.js" data-site="niko-main"></script>
<!-- 文库使用 data-site="niko-wenku" -->
```

记录首次访问、前端路由变化与链接/按钮点击。`data-monitor-label` 可指定点击标签，`data-monitor-ignore` 可排除区域；表单与主站 AI 对话区域不采集点击。不采集输入值、正文或 URL 查询参数，会话 ID 每日 HMAC 匿名化，不持久化原始会话 ID。浏览器的 Do Not Track 仍被尊重，采集失败不影响导航。

管理员明确启用 IP 统计后，服务器保存来源 IP 30 天；浏览器传入的 IP 字段无效，仅信任本机反向代理覆盖的 `X-Real-IP`。IP 明细只在管理员登录后提供。UV 仍是匿名会话数，独立 IP 是另一项指标，共享出口不代表独立人数。升级前的事件保留原计数，缺少 IP 的历史访问显示“未记录”，不会补造地址。

## 接口请求与健康

安装脚本在现有 Nginx 站点加入独立访问日志 `/var/log/niko-monitor/access.jsonl`。仅采集文库和聊天业务 API；不采集监控自身轮询、静态资源或其他站点。CLI、浏览器与其他 HTTP 客户端均可统计。请求完成后约 2 秒入库；流式响应及长下载在结束时记录，HTTP 200 流内部的业务错误不属于 HTTP 5xx 指标。

日志写盘前即归一化书籍、章节、验证码等动态路径；未知路由合并为 `:unmatched`，不保存原始路径、查询、请求体、Cookie、密钥或聊天内容。请求 ID 去重，读取位置和写入同一事务保存；重启续读，支持 rename 轮转及 `.1` 尾部补读。安装独立日志组、0640 文件权限和每日轮转，不把日志开放给所有用户。原始 Nginx 日志最多保留 14 个轮转文件，SQLite 原始请求保留 30 天。

`probeEndpoints: true` 开启接口级主动探测：仅 GET 文库健康、书库搜索、登录状态、任务状态及聊天健康；任务状态预期返回 401/403，表示鉴权正常。书库搜索只检查响应状态并取消读取大响应，不重复拉取书库。验证码生成、登录/注册、任务启停、发布、聊天及动态书籍端点不被监控主动执行，依据最近 5 分钟真实 HTTP 响应判断。无请求显示“待观测”，过期显示“无近期请求”；最新 5xx 标记异常，近期已恢复的 5xx 或非鉴权 4xx 标记需关注。健康探测不会进入用户请求量统计。

主动探测与实际请求的来源会在接口详情显示。日志缺失、权限错误或积压会在界面提示，不会把采集异常误报成零流量或全部健康。

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
| `MONITOR_PUBLIC_ORIGIN` | 空 | 公开 origin，不含路径，如 `https://111.229.32.85` |
| `MONITOR_ACCESS_LOG` | 空 | Nginx 清洗后的 JSONL 路径；生产 unit 已设置 |

管理员账号固定为 `liuqi`，密码由部署管理员指定，服务端仅保留 `server/admin-account.mjs` 中的 scrypt 摘要。浏览器提交 `username` 与 `password`，登录后使用 12 小时 HttpOnly、SameSite=Strict 会话；HTTPS 下附加 Secure。连续 8 次失败会暂时限制登录。旧 `MONITOR_TOKEN` 登录已移除，部署会删除旧环境变量。本地预览同样需要登录。

采集接口 `POST /niko-monitor/api/collect` 公开但校验来源；快照 `/niko-monitor/api/snapshot`、IP 明细 `/niko-monitor/api/visitors?site=&page=1&q=` 和 SSE `/niko-monitor/api/events` 需要登录。SDK 和健康接口允许公开读取。管理员密码不在前端、文档、采集事件或浏览器存储中保存。

## 服务器部署

生产服务独立安装，现有主站发布脚本暂不自动安装它。先在构建机执行 `npm ci && npm run build`；发布目录 `/srv/niko-archive/niko-monitor` 包含 `server/`、`public/tracker.js`、`dist/` 和配置文件即可，运行不依赖 `node_modules`。服务器需要 Node.js 22.13+。

推荐将上述发布文件连同 `deploy/` 上传至服务器临时目录后执行：

```sh
sudo bash deploy/install.sh /srv/niko-archive/niko-monitor https://111.229.32.85 /etc/nginx/sites-enabled/worldseed ubuntu
```

安装脚本保留监控数据库与旧版静态资源，只重启监控服务。它检查健康状态后插入独立 Nginx include，验证配置再 reload；代理验证失败时恢复旧配置。重复执行不会更改固定管理员，也不会重启文库主备、扫描、下载或聊天服务。现有站点配置必须包含 `/srv/niko-archive/niko-main` 的 root 指令，否则脚本拒绝猜测插入位置。

监控登录入口（`/niko-monitor`、`/niko-monitor/`、`/niko-monitor/index.html`）的 HTTP 访问会跳转至同主机的 HTTPS 地址；公开访问主机必须与 `MONITOR_PUBLIC_ORIGIN` 一致。后端保留严格来源校验，HTTP 与 HTTPS 属于不同来源。若旧 HTTP 页面提示“不允许跨站操作”，刷新页面或直接打开 HTTPS 入口。采集脚本及 `/api/collect` 继续支持已配置的 HTTP 站点，避免跳转中断统计。

部署后可执行代理回归检查（不需要账号，不发送采集数据，不触发扫描）：

```sh
MONITOR_PROXY_ORIGIN=https://111.229.32.85 node --test test/proxy.test.mjs
```

仅当部署使用自签名证书时额外设置 `MONITOR_PROXY_INSECURE=1`；此开关只作用于该检查脚本。

手动安装步骤：

1. 安全创建 `/etc/niko-monitor.env`，配置 `MONITOR_PUBLIC_ORIGIN=https://111.229.32.85`，文件仅允许 root 读取，不提交 Git；在 HTTPS 页面使用固定的管理员账号和密码登录。
2. 安装 `deploy/niko-monitor.service` 至 `/etc/systemd/system/`，核对用户及 Node 路径，再执行 `sudo systemctl daemon-reload && sudo systemctl enable --now niko-monitor`。
3. 确认 `curl http://127.0.0.1:4182/api/health` 返回 `{"ok":true,"service":"niko-monitor"}`。
4. 把 `deploy/nginx-monitor.conf` 包含进现有 `server {}` 块，`sudo nginx -t` 通过后仅 reload Nginx，保留文库主备 upstream 与工作进程。
5. 登录 `/niko-monitor/`，确认六个探测项，再发布带采集入口的主站与文库，通过真实访问验证计数增长。

数据库为 `/var/lib/niko-monitor/monitor.sqlite`，使用 WAL；备份应使用 SQLite 一致性备份，或停监控服务后复制整个状态目录，不在写入时单独复制主数据库文件。监控故障不影响主站、文库和 CLI。
