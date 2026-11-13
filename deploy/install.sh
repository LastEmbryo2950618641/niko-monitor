#!/usr/bin/env bash
# Install only the independent monitor; existing library/chat workers stay running.
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-/srv/niko-archive/niko-monitor}"
origin="${2:-https://111.229.32.85}"
site="${3:-/etc/nginx/sites-enabled/worldseed}"
service_user="${4:-ubuntu}"

[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ "$target" =~ ^/srv/[A-Za-z0-9_./-]+/niko-monitor$ && "$target" != *..* ]] || { echo 'Invalid monitor target.' >&2; exit 1; }
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
id "$service_user" >/dev/null
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<13)) process.exit(1)'
for file in server/index.mjs server/app.mjs server/admin-account.mjs server/store.mjs server/health.mjs public/tracker.js dist/index.html monitor.config.production.json deploy/niko-monitor.service deploy/nginx-monitor.conf; do
  test -f "$source_dir/$file"
done
test -f "$site"
site="$(readlink -f -- "$site")"
export NIKO_MONITOR_TARGET="$target" NIKO_MONITOR_ORIGIN="$origin" NIKO_MONITOR_USER="$service_user" NIKO_MONITOR_SITE="$site" NIKO_MONITOR_SOURCE="$source_dir"

# The fixed administrator is verified by the server; environment files contain no login password.
node --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
const origin = new URL(process.env.NIKO_MONITOR_ORIGIN);
if (origin.protocol !== 'https:' || origin.origin !== process.env.NIKO_MONITOR_ORIGIN) throw Error('Use a canonical HTTPS origin');
const file = '/etc/niko-monitor.env';
if (!existsSync(file)) writeFileSync(file, `MONITOR_PUBLIC_ORIGIN=${origin.origin}\n`, { flag: 'wx', mode: 0o600 });
const env = readFileSync(file, 'utf8');
if (!env.split('\n').includes(`MONITOR_PUBLIC_ORIGIN=${origin.origin}`)) throw Error('Existing monitor origin needs manual review');
writeFileSync(file, env.replace(/^MONITOR_TOKEN=.*(?:\r?\n|$)/gm, ''), { mode: 0o600 });
chmodSync(file, 0o600);
NODE

install -d -m 0755 "$target" /etc/nginx/snippets
# Keep earlier hashed assets so already-open dashboards can finish loading.
for directory in dist public server; do
  install -d -m 0755 "$target/$directory"
  cp -R -- "$source_dir/$directory/." "$target/$directory/"
done
install -m 0644 "$source_dir/monitor.config.production.json" "$target/monitor.config.production.json"
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const source = process.env.NIKO_MONITOR_SOURCE;
const unit = readFileSync(source + '/deploy/niko-monitor.service', 'utf8')
  .replaceAll('/srv/niko-archive/niko-monitor', process.env.NIKO_MONITOR_TARGET)
  .replace('User=ubuntu', 'User=' + process.env.NIKO_MONITOR_USER);
writeFileSync('/etc/systemd/system/niko-monitor.service', unit, { mode: 0o644 });
NODE
systemctl daemon-reload
systemctl enable niko-monitor.service
systemctl restart niko-monitor.service
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:4182/api/health | node --input-type=module -e 'let text="";for await(const part of process.stdin) text+=part;const value=JSON.parse(text);if(value.ok!==true||value.service!=="niko-monitor")process.exit(1)' 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 0.5
done
[[ "$healthy" == true ]] || { echo 'Monitor health check failed.' >&2; exit 1; }

backup="${site}.before-niko-monitor-$(date +%Y%m%d%H%M%S)"
cp -p -- "$site" "$backup"
snippet=/etc/nginx/snippets/niko-monitor.conf
snippet_backup="${backup}.snippet"
if [[ -f "$snippet" ]]; then cp -p -- "$snippet" "$snippet_backup"; fi
install -m 0644 "$source_dir/deploy/nginx-monitor.conf" "$snippet"
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const site = process.env.NIKO_MONITOR_SITE;
let text = readFileSync(site, 'utf8');
const include = '    include /etc/nginx/snippets/niko-monitor.conf;';
if (!text.includes(include.trim())) {
  const anchor = /^    root \/srv\/niko-archive\/niko-main;$/m;
  if (!anchor.test(text) || /location\s+(?:\^~\s+|=\s+)?\/niko-monitor/.test(text)) throw Error('Cannot safely locate monitor proxy insertion point');
  text = text.replace(anchor, match => `    # BEGIN Niko Monitor\n${include}\n    # END Niko Monitor\n\n${match}`);
  writeFileSync(site, text);
}
NODE
if ! nginx -t || ! systemctl reload nginx; then
  cp -p -- "$backup" "$site"
  if [[ -f "$snippet_backup" ]]; then cp -p -- "$snippet_backup" "$snippet"; else rm -f -- "$snippet"; fi
  nginx -t && systemctl reload nginx
  echo 'Monitor proxy failed; previous Nginx configuration restored.' >&2
  exit 1
fi
echo "Niko Monitor deployed: $origin/niko-monitor/"
echo 'Sign in with the fixed Niko administrator account; legacy access-token login is disabled.'
