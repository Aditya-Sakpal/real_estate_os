# The worker

One server that runs the background jobs on timers: `salesdesk-worker`, an
EC2 `c7i-flex.large` (2 vCPU, 4 GB, 4 GB swap) in `ap-south-1`, in AWS
account 111111111111 beside the RDS database. Built 29 September 2026.
`bootstrap.sh` is its whole setup, passed as EC2 user data; running it
again on the server is safe.

| Job | Timer | Command |
| --- | --- | --- |
| lead-run | 3 min after the last run ended | `npm run lead:run` |
| call-watch | 5 s after the last run ended (each run looks every 15 s for about 3 min) | `npm run call:watch` |
| crm-run | 3 min | `npm run crm:run` |
| extract-run | 3 min | `npm run extract:run` |
| reel-run | 2 min | `npm run reel:run` |
| post-run | 10 min | `npm run post:run` |
| billing-sweep | 03:00 IST | `npm run billing -- sweep` |
| assets-sweep | Sunday 04:00 IST | `npm run assets:sweep` (a dry run) |
| rera-sweep | 02:30 IST, **off** | `npm run rera:sweep` |

A timer counts from when its job last ended, so a job never runs twice at
once. A job the live code does not have yet is skipped and says so.

**rera-sweep is off** because production's only registration is the demo
tower's (P52100012345), which no register holds: the first night would
block it. Turn it on once a real registration is recorded:

    systemctl enable --now salesdesk-rera-sweep.timer

## Code and the database follow main

Every 2 minutes `deploy` fetches `main` from GitHub (a read-only deploy key),
and for a new commit unpacks it into `/opt/salesdesk/releases/<sha>`, runs
`npm ci`, **runs `npm run db:migrate` against RDS**, then makes it live by
swapping the `current` symlink. A job already running keeps its own files.
A commit whose install or migration fails is marked `<sha>.failed`, the old
release stays live, and it is not retried until `main` moves. Vercel deploys
the same `main`, so the production database is migrated within about two
minutes of a push, and nobody has to remember to.

## Settings

`/salesdesk/worker/env` in SSM Parameter Store (SecureString) is the
worker's `.env.local`. It mirrors what production has: RDS, `DB_POOL_MAX=3`,
the production bucket, OpenAI, Higgsfield, Sarvam's speech key, and
`NODE_ENV=production`, which turns every dev seam off. It carries no calling,
WhatsApp, connector or Razorpay keys, because production has none: add them
here and to Vercel together. A change is picked up within 2 minutes.

    aws ssm put-parameter --profile salesdesk-db --region ap-south-1 \
      --name /salesdesk/worker/env --type SecureString --overwrite --value file://worker.env

`/salesdesk/worker/deploy-key` is the GitHub key (read-only deploy key
"salesdesk-worker" on the repository).

## Reaching it

No SSH and nothing open inbound. Use Session Manager:

    aws ssm start-session --profile salesdesk-db --region ap-south-1 --target i-0123456789abcdef0

Logs are `/var/log/salesdesk/<job>.log` (kept 14 days) and CloudWatch Logs
group `/salesdesk/worker` (30 days), one stream per job.

    systemctl list-timers 'salesdesk-*'
    systemctl start salesdesk-job@lead-run.service     # run one now
    tail -f /var/log/salesdesk/lead-run.log

## Cost

About $68 a month (Rs 6,200): the instance $0.085 an hour, 30 GB of gp3 and
a public IPv4 address. On the account's free-plan credits for now. Once the
account is on a paid plan, a `t4g.medium` (about $17) or `c7g.large` is
cheaper, if the ffmpeg and Chrome builds are switched to arm64.
