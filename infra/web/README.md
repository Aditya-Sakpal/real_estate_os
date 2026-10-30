# The web server

`salesdesk-web`, an EC2 `c7i-flex.large` (2 vCPU, 4 GB, 4 GB swap) in
`ap-south-1`, account 111111111111, beside the worker and the database.
Elastic IP 203.0.113.10. It serves app.salesdesk.app and
admin.salesdesk.app, which moved off Vercel on 17 October 2026.
`bootstrap.sh` is its whole setup, passed as EC2 user data; running it again
on the server is safe.

- **Caddy** holds the HTTPS certificates (Let's Encrypt) and proxies both
  addresses to the live port. DNS (Cloudflare) is an A record to the Elastic
  IP, not proxied, so the certificate challenge reaches Caddy.
- **`next start`** runs as `salesdesk-web@3000` or `@3001`. No request
  timeout and no body cap beyond Caddy's 120 MB.
- **Deploy**, every 2 minutes: new code on `main` is unpacked, installed and
  built into `/opt/salesdesk/releases/<sha>`, started on the idle port,
  checked on `/signin`, then given the traffic by a Caddy reload. The old
  port stops four minutes later, so a post being designed finishes. A
  release that fails to build or start is marked `<sha>.failed` and never
  takes traffic. The worker migrates the database; this server never does.
- **Settings** are `/salesdesk/web/env` in SSM (SecureString, advanced
  tier), written to each release's `.env.local`. A change is picked up within
  2 minutes by a restart on the other port.

      aws ssm put-parameter --profile salesdesk-db --region ap-south-1 \
        --name /salesdesk/web/env --type SecureString --tier Advanced --overwrite --value file://web.env

- **`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`** is in those settings (since 21
  October 2026) and must never change. Next salts every server action's id
  with it, and without a fixed key each build drew its own, so a page opened
  before a deploy pressed buttons the new release did not know ("Failed to
  find Server Action") and nothing happened.

## Reaching it

No SSH. Session Manager:

    aws ssm start-session --profile salesdesk-db --region ap-south-1 --target i-0123456789abcdef0

Logs: `/var/log/salesdesk/deploy.log` and `web-<port>.log`, 14 days.

    cat /opt/salesdesk/web-live          # the live port and commit
    systemctl start salesdesk-web-deploy # deploy now
