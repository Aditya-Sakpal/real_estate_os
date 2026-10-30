#!/bin/bash
# The Sales Desk worker: one server in Mumbai that runs the background jobs
# on timers. Passed to EC2 as user data (Amazon Linux 2023, x86_64), and safe
# to run again. Settings and the read-only GitHub key come from SSM Parameter
# Store (/salesdesk/worker/*), never from this file.
#
#   deploy   every 2 min: new code on main is unpacked into its own release,
#            installed, the database migrated, then made live by one symlink
#            swap, so a job already running keeps the files it started with
#   jobs     each a systemd timer; a job waits for its own last run to end,
#            and a job the live release does not have yet is skipped
#   logs     /var/log/salesdesk/<job>.log, shipped to CloudWatch
#            (/salesdesk/worker, 30 days)
set -euxo pipefail
REGION=ap-south-1
ROOT=/opt/salesdesk

# --- packages: git, fonts, the libraries headless Chrome needs for Remotion
dnf install -y --setopt=strict=False git tar xz fontconfig dejavu-sans-fonts logrotate amazon-cloudwatch-agent \
  mesa-libgbm libX11 libXrandr libdrm libXdamage libXfixes dbus-libs libXcomposite \
  alsa-lib nss libxkbcommon pango at-spi2-atk cups-libs

# --- Node 24, the version Vercel runs
if ! command -v node >/dev/null || ! node -v | grep -q '^v24'; then
  NODE_TGZ=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -o 'node-v24[0-9.]*-linux-x64.tar.xz' | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_TGZ" | tar -xJ -C /usr/local --strip-components=1
fi

# --- FFmpeg and ffprobe, static
if ! command -v ffmpeg >/dev/null; then
  mkdir -p /tmp/ff && curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ -C /tmp/ff --strip-components=1
  install -m 755 /tmp/ff/ffmpeg /tmp/ff/ffprobe /usr/local/bin/ && rm -rf /tmp/ff
fi

# --- 4 GB of swap, for a reel render on a 4 GB machine
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi

# --- the user the jobs run as, and its GitHub key
id salesdesk >/dev/null 2>&1 || useradd --system --create-home --home-dir $ROOT --shell /bin/bash salesdesk
mkdir -p $ROOT/bin $ROOT/releases $ROOT/.ssh /var/log/salesdesk
aws ssm get-parameter --region $REGION --name /salesdesk/worker/deploy-key --with-decryption \
  --query Parameter.Value --output text > $ROOT/.ssh/deploy_key
chmod 600 $ROOT/.ssh/deploy_key
ssh-keyscan -t ed25519 github.com > $ROOT/.ssh/known_hosts 2>/dev/null

# --- deploy: fetch main, and make it live if it is new
cat > $ROOT/bin/deploy <<'DEPLOY'
#!/bin/bash
set -euo pipefail
ROOT=/opt/salesdesk; REPO=$ROOT/repo.git; REL=$ROOT/releases
export GIT_SSH_COMMAND="ssh -i $ROOT/.ssh/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$ROOT/.ssh/known_hosts"
[ -d $REPO ] || git clone --quiet --mirror git@github.com:Aditya-Sakpal/Sales Desk.git $REPO
git -C $REPO fetch --quiet --prune origin '+refs/heads/main:refs/heads/main'
SHA=$(git -C $REPO rev-parse main)
ENV=$(aws ssm get-parameter --region ap-south-1 --name /salesdesk/worker/env --with-decryption --query Parameter.Value --output text)
CUR=$(readlink -f $ROOT/current 2>/dev/null || true)
if [ "$CUR" = "$REL/$SHA" ]; then
  if ! printf '%s\n' "$ENV" | cmp -s - "$CUR/.env.local"; then
    printf '%s\n' "$ENV" > "$CUR/.env.local.new" && chmod 600 "$CUR/.env.local.new" && mv "$CUR/.env.local.new" "$CUR/.env.local"
    echo "settings refreshed for $SHA"
  fi
  exit 0
fi
# A release that failed once is not retried until main moves.
[ -f "$REL/$SHA.failed" ] && exit 0
echo "deploying $SHA"
rm -rf "$REL/$SHA.tmp" && mkdir -p "$REL/$SHA.tmp"
git -C $REPO archive "$SHA" | tar -x -C "$REL/$SHA.tmp"
cd "$REL/$SHA.tmp"
printf '%s\n' "$ENV" > .env.local && chmod 600 .env.local
if ! npm ci --no-audit --no-fund --loglevel=error; then echo "npm ci failed for $SHA"; touch "$REL/$SHA.failed"; exit 1; fi
if ! npm run --silent db:migrate; then echo "migration failed for $SHA; the old release stays live"; touch "$REL/$SHA.failed"; exit 1; fi
echo "$SHA" > REVISION
mv "$REL/$SHA.tmp" "$REL/$SHA"
ln -sfn "$REL/$SHA" $ROOT/current.new && mv -T $ROOT/current.new $ROOT/current
ls -1dt "$REL"/*/ | grep -v '\.tmp/$' | tail -n +4 | xargs -r rm -rf
echo "live: $SHA"
DEPLOY

# --- job <name>: one scheduled job, from the live release
cat > $ROOT/bin/job <<'JOB'
#!/bin/bash
set -uo pipefail
NAME=$1; ARGS=()
case $NAME in
  lead-run) SCRIPT=lead:run;;
  call-watch) SCRIPT=call:watch;;
  post-run) SCRIPT=post:run;;
  crm-run) SCRIPT=crm:run;;
  reel-run) SCRIPT=reel:run;;
  extract-run) SCRIPT=extract:run;;
  rera-sweep) SCRIPT=rera:sweep;;
  billing-sweep) SCRIPT=billing; ARGS=(-- sweep);;
  assets-sweep) SCRIPT=assets:sweep;;
  watchdog) SCRIPT=watchdog;;
  *) echo "unknown job $NAME"; exit 2;;
esac
cd /opt/salesdesk/current 2>/dev/null || { echo "no release is live yet"; exit 0; }
REV=$(cat REVISION)
if ! node -e "process.exit(require('./package.json').scripts['$SCRIPT'] ? 0 : 1)"; then
  echo "$(date -Is) $SCRIPT is not in release ${REV:0:7}; skipped"; exit 0
fi
echo "$(date -Is) start $SCRIPT ${ARGS[*]:-} (${REV:0:7})"
npm run --silent "$SCRIPT" "${ARGS[@]}" 2>&1 | while IFS= read -r l; do printf '%s %s\n' "$(date -Is)" "$l"; done
RC=${PIPESTATUS[0]}
echo "$(date -Is) end $SCRIPT exit $RC"
exit $RC
JOB
chmod 755 $ROOT/bin/*
chown -R salesdesk:salesdesk $ROOT /var/log/salesdesk

# --- systemd: the deploy, and one service template for every job
cat > /etc/systemd/system/salesdesk-deploy.service <<'UNIT'
[Unit]
Description=Sales Desk: make new code on main live
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=salesdesk
Environment=PATH=/usr/local/bin:/usr/bin:/bin HOME=/opt/salesdesk
ExecStart=/opt/salesdesk/bin/deploy
StandardOutput=append:/var/log/salesdesk/deploy.log
StandardError=append:/var/log/salesdesk/deploy.log
TimeoutStartSec=30min
UNIT
cat > /etc/systemd/system/salesdesk-deploy.timer <<'UNIT'
[Unit]
Description=Sales Desk: check main every 2 minutes
[Timer]
OnBootSec=30s
OnUnitInactiveSec=2min
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/salesdesk-job@.service <<'UNIT'
[Unit]
Description=Sales Desk job %i
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=salesdesk
Nice=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin HOME=/opt/salesdesk
ExecStart=/opt/salesdesk/bin/job %i
StandardOutput=append:/var/log/salesdesk/%i.log
StandardError=append:/var/log/salesdesk/%i.log
TimeoutStartSec=2h
UNIT

# name, then the [Timer] lines
timer() {
  printf '[Unit]\nDescription=Sales Desk job %s\n[Timer]\n%b\nUnit=salesdesk-job@%s.service\n[Install]\nWantedBy=timers.target\n' "$1" "$2" "$1" \
    > /etc/systemd/system/salesdesk-$1.timer
}
timer lead-run      'OnBootSec=2min\nOnUnitInactiveSec=3min'
# Runs about three minutes, looking every 15 s, and starts again at once.
timer call-watch    'OnBootSec=2min\nOnUnitInactiveSec=5s\nAccuracySec=1s'
timer crm-run       'OnBootSec=3min\nOnUnitInactiveSec=3min'
timer extract-run   'OnBootSec=3min\nOnUnitInactiveSec=3min'
timer reel-run      'OnBootSec=4min\nOnUnitInactiveSec=2min'
timer post-run      'OnBootSec=5min\nOnUnitInactiveSec=10min'
timer watchdog      'OnBootSec=6min\nOnUnitInactiveSec=5min'
# IST is UTC+5:30: 02:30, 03:00 and Sunday 04:00 in India
timer rera-sweep    'OnCalendar=*-*-* 21:00:00 UTC\nPersistent=true'
timer billing-sweep 'OnCalendar=*-*-* 21:30:00 UTC\nPersistent=true'
timer assets-sweep  'OnCalendar=Sat *-*-* 22:30:00 UTC\nPersistent=true'

systemctl daemon-reload
systemctl enable --now salesdesk-deploy.timer
for t in lead-run call-watch crm-run extract-run reel-run post-run billing-sweep assets-sweep watchdog; do
  systemctl enable --now salesdesk-$t.timer
done
# rera-sweep is installed but left off: production's only registration is the
# demo tower's, which no register holds, so the first night would block it.
# Turn it on with: systemctl enable --now salesdesk-rera-sweep.timer

# --- logs: rotated here, shipped to CloudWatch
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
python3 - <<'PY'
import json
jobs = ["deploy", "lead-run", "crm-run", "extract-run", "reel-run", "post-run", "rera-sweep", "billing-sweep", "assets-sweep"]
cfg = {"logs": {"logs_collected": {"files": {"collect_list": [
  {"file_path": f"/var/log/salesdesk/{j}.log", "log_group_name": "/salesdesk/worker",
   "log_stream_name": j, "retention_in_days": 30} for j in jobs]}}}}
open("/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json", "w").write(json.dumps(cfg))
PY
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# --- the first deploy, now rather than in two minutes
systemctl start salesdesk-deploy.service || true

# --- the films' voice fix (scripts/voicefix.py): Python 3.11, CPU torch and
# Demucs in their own environment. VOICEFIX_PYTHON in /salesdesk/worker/env
# names its python; without it the voice fix is skipped and the film kept.
if [ ! -x $ROOT/voicefix/venv/bin/python ]; then
  dnf install -y -q python3.11 python3.11-pip
  mkdir -p $ROOT/voicefix && chown salesdesk:salesdesk $ROOT/voicefix
  sudo -u salesdesk -H bash -c "python3.11 -m venv $ROOT/voicefix/venv && V=$ROOT/voicefix/venv/bin && \
    \$V/pip install -q --upgrade pip && \
    \$V/pip install -q torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu && \
    \$V/pip install -q --no-deps demucs==4.1.0 && \
    \$V/pip install -q huggingface-hub safetensors dora-search einops julius lameenc openunmix pyyaml tqdm sphn soundfile scipy praat-parselmouth numpy" || true
fi
# --- the lip check (scripts/lipsync.py): MediaPipe finds her face, SyncNet
# scores her lips against her voice. OpenCV headless only: MediaPipe pulls in
# the full build, which wants a display; MediaPipe itself still loads libEGL. LIPSYNC_MODELS in /salesdesk/worker/env
# names the models' folder; without it no scene is scored.
if [ ! -f $ROOT/voicefix/lipsync/syncnet_v2.model ]; then
  dnf install -y -q mesa-libEGL mesa-libGL   # MediaPipe's own library loads libEGL
  sudo -u salesdesk -H bash -c "V=$ROOT/voicefix/venv/bin && \$V/pip install -q mediapipe python_speech_features &&     \$V/pip uninstall -y -q opencv-contrib-python opencv-python; \$V/pip install -q --force-reinstall --no-deps opencv-python-headless" || true
  mkdir -p $ROOT/voicefix/lipsync
  curl -sSL -o $ROOT/voicefix/lipsync/syncnet_v2.model http://www.robots.ox.ac.uk/~vgg/software/lipsync/data/syncnet_v2.model
  curl -sSL -o $ROOT/voicefix/lipsync/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
  curl -sSL -o $ROOT/voicefix/lipsync/pose.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task
  chown -R salesdesk:salesdesk $ROOT/voicefix/lipsync
fi
