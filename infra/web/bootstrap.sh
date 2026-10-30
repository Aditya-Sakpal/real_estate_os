#!/bin/bash
# The Sales Desk web server: the console (app.salesdesk.app) and the
# operator console (admin.salesdesk.app), served by `next start` behind
# Caddy, which holds the HTTPS certificates. Passed to EC2 as user data
# (Amazon Linux 2023, x86_64), and safe to run again. Settings come from SSM
# Parameter Store (/salesdesk/web/env), the GitHub key from the worker's.
#
#   deploy   every 2 min: new code on main is unpacked into its own release,
#            installed and built, started on the idle port (3000 or 3001),
#            checked, and only then given the traffic; the old one stops
#            after it has finished what it was doing. A release that fails
#            to build or start never takes traffic. The worker migrates the
#            database; this server never does.
#   logs     /var/log/salesdesk/web-<port>.log and deploy.log, 14 days
set -euxo pipefail
REGION=ap-south-1
ROOT=/opt/salesdesk
CADDY_VERSION=2.8.4

# --- packages
dnf install -y --setopt=strict=False git tar xz fontconfig dejavu-sans-fonts logrotate

# --- Node 24, the version the worker runs
if ! command -v node >/dev/null || ! node -v | grep -q '^v24'; then
  NODE_TGZ=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -o 'node-v24[0-9.]*-linux-x64.tar.xz' | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_TGZ" | tar -xJ -C /usr/local --strip-components=1
fi

# --- FFmpeg and ffprobe, static: video stills, recordings, voice notes
if ! command -v ffmpeg >/dev/null; then
  mkdir -p /tmp/ff && curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ -C /tmp/ff --strip-components=1
  install -m 755 /tmp/ff/ffmpeg /tmp/ff/ffprobe /usr/local/bin/ && rm -rf /tmp/ff
fi

# --- Caddy, for HTTPS
if ! command -v caddy >/dev/null; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin caddy
  chmod 755 /usr/local/bin/caddy
fi
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy

# --- 4 GB of swap: a build of the console needs more than the 4 GB of RAM
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi

# --- the user the server runs as, and its GitHub key
id salesdesk >/dev/null 2>&1 || useradd --system --create-home --home-dir $ROOT --shell /bin/bash salesdesk
mkdir -p $ROOT/bin $ROOT/releases $ROOT/.ssh /var/log/salesdesk /etc/caddy
aws ssm get-parameter --region $REGION --name /salesdesk/worker/deploy-key --with-decryption \
  --query Parameter.Value --output text > $ROOT/.ssh/deploy_key
chmod 600 $ROOT/.ssh/deploy_key
ssh-keyscan -t ed25519 github.com > $ROOT/.ssh/known_hosts 2>/dev/null

# --- Caddy: both addresses to whichever port is live
cat > /etc/caddy/Caddyfile <<'CADDY'
{
	email ops@salesdesk.app
}
app.salesdesk.app, admin.salesdesk.app {
	encode zstd gzip
	request_body {
		max_size 120MB
	}
	import /etc/caddy/upstream.caddy
}
CADDY
[ -f /etc/caddy/upstream.caddy ] || printf 'reverse_proxy 127.0.0.1:3000 {\n\tflush_interval -1\n}\n' > /etc/caddy/upstream.caddy
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy, HTTPS for app.salesdesk.app and admin.salesdesk.app
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT

# --- the console on one port; two of these run only while a release changes over
cat > /etc/systemd/system/salesdesk-web@.service <<'UNIT'
[Unit]
Description=Sales Desk console on port %i
After=network-online.target
[Service]
User=salesdesk
WorkingDirectory=/opt/salesdesk/web-%i
Environment=PATH=/usr/local/bin:/usr/bin:/bin HOME=/opt/salesdesk NODE_ENV=production
ExecStart=/usr/local/bin/node node_modules/next/dist/bin/next start -p %i -H 127.0.0.1
Restart=always
RestartSec=3
TimeoutStopSec=60
StandardOutput=append:/var/log/salesdesk/web-%i.log
StandardError=append:/var/log/salesdesk/web-%i.log
UNIT

# --- deploy: build new code on main, start it on the idle port, then switch
cat > $ROOT/bin/deploy <<'DEPLOY'
#!/bin/bash
set -euo pipefail
ROOT=/opt/salesdesk; REPO=$ROOT/repo.git; REL=$ROOT/releases
as() { /usr/sbin/runuser -u salesdesk -- env HOME=$ROOT PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
export GIT_SSH_COMMAND="ssh -i $ROOT/.ssh/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$ROOT/.ssh/known_hosts"
[ -d $REPO ] || as env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git clone --quiet --mirror git@github.com:Aditya-Sakpal/Sales Desk.git $REPO
as env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git -C $REPO fetch --quiet --prune origin '+refs/heads/main:refs/heads/main'
SHA=$(as git -C $REPO rev-parse main)
ENV=$(aws ssm get-parameter --region ap-south-1 --name /salesdesk/web/env --with-decryption --query Parameter.Value --output text)
read -r LIVE_PORT LIVE_SHA < $ROOT/web-live 2>/dev/null || { LIVE_PORT=; LIVE_SHA=; }

if [ "$SHA" = "$LIVE_SHA" ]; then
  # Same code; new settings only need a restart on the other port.
  if printf '%s\n' "$ENV" | cmp -s - "$REL/$SHA/.env.local"; then exit 0; fi
  echo "settings changed for $SHA"
  printf '%s\n' "$ENV" > "$REL/$SHA/.env.local"; chown salesdesk:salesdesk "$REL/$SHA/.env.local"; chmod 600 "$REL/$SHA/.env.local"
else
  [ -f "$REL/$SHA.failed" ] && exit 0
  echo "$(date -Is) building $SHA"
  rm -rf "$REL/$SHA.tmp" && mkdir -p "$REL/$SHA.tmp" && chown salesdesk:salesdesk "$REL/$SHA.tmp"
  as git -C $REPO archive "$SHA" | as tar -x -C "$REL/$SHA.tmp"
  printf '%s\n' "$ENV" > "$REL/$SHA.tmp/.env.local"; chown salesdesk:salesdesk "$REL/$SHA.tmp/.env.local"; chmod 600 "$REL/$SHA.tmp/.env.local"
  cd "$REL/$SHA.tmp"
  if ! as npm ci --no-audit --no-fund --loglevel=error; then echo "npm ci failed for $SHA"; touch "$REL/$SHA.failed"; exit 1; fi
  if ! as env NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=3584 npm run --silent build; then
    echo "build failed for $SHA; the old release stays live"; touch "$REL/$SHA.failed"; exit 1
  fi
  echo "$SHA" > REVISION
  cd /; rm -rf "$REL/$SHA"; mv "$REL/$SHA.tmp" "$REL/$SHA"
fi

NEW_PORT=3000; [ "$LIVE_PORT" = "3000" ] && NEW_PORT=3001
ln -sfn "$REL/$SHA" $ROOT/web-$NEW_PORT
systemctl restart salesdesk-web@$NEW_PORT
OK=
for i in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.salesdesk.app' "http://127.0.0.1:$NEW_PORT/signin" || true)
  case $CODE in 2??|3??) OK=1; break;; esac
  sleep 2
done
if [ -z "$OK" ]; then
  echo "$SHA did not start on $NEW_PORT; the old release stays live"
  systemctl stop salesdesk-web@$NEW_PORT || true
  [ "$SHA" != "$LIVE_SHA" ] && touch "$REL/$SHA.failed"
  exit 1
fi
printf 'reverse_proxy 127.0.0.1:%s {\n\tflush_interval -1\n}\n' "$NEW_PORT" > /etc/caddy/upstream.caddy
systemctl reload caddy || systemctl restart caddy
echo "$NEW_PORT $SHA" > $ROOT/web-live
if [ -n "$LIVE_PORT" ] && [ "$LIVE_PORT" != "$NEW_PORT" ]; then
  # Long requests (a post being designed) finish on the old one first.
  sleep 240
  systemctl stop salesdesk-web@$LIVE_PORT || true
fi
# Keep the live release and the two before it.
ls -1dt "$REL"/*/ | grep -v '\.tmp/$' | tail -n +4 | while read -r d; do
  [ "$(readlink -f $ROOT/web-3000)/" = "$d" ] || [ "$(readlink -f $ROOT/web-3001)/" = "$d" ] || rm -rf "$d"
done
echo "$(date -Is) live: $SHA on $NEW_PORT"
DEPLOY
chmod 755 $ROOT/bin/deploy
chown -R salesdesk:salesdesk $ROOT /var/log/salesdesk

cat > /etc/systemd/system/salesdesk-web-deploy.service <<'UNIT'
[Unit]
Description=Sales Desk: make new code on main live on the web server
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=/opt/salesdesk/bin/deploy
StandardOutput=append:/var/log/salesdesk/deploy.log
StandardError=append:/var/log/salesdesk/deploy.log
TimeoutStartSec=45min
UNIT
cat > /etc/systemd/system/salesdesk-web-deploy.timer <<'UNIT'
[Unit]
Description=Sales Desk: check main every 2 minutes
[Timer]
OnBootSec=30s
OnUnitInactiveSec=2min
[Install]
WantedBy=timers.target
UNIT

cat > /etc/logrotate.d/salesdesk <<'ROT'
/var/log/salesdesk/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
ROT

systemctl daemon-reload
systemctl enable --now caddy
systemctl enable --now salesdesk-web-deploy.timer
