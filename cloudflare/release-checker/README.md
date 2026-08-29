# Cloudflare release checker

This Worker keeps the frequent release check off GitHub-hosted runners. A
single Durable Object alarm checks every five minutes and dispatches
`publish.yml` only when a tracked upstream tag differs from the package's
published marker. The hourly Cron Trigger only repairs a missing alarm; it is
not the primary timer.

Durable Object alarms provide at-least-once execution. GitHub Pages markers and
the publisher's in-flight status make repeated alarm delivery safe. After the
platform's six automatic alarm retries are exhausted, the object schedules a
new five-minute alarm so the checker does not silently stop.

## Required secrets

- `GITHUB_TOKEN`: a fine-grained GitHub personal access token restricted to
  `kapdon/pacman-repo`, with repository **Actions: Read and write** permission.
- `CONTROL_SECRET`: a random bearer token for the status and manual-run routes.

Do not use a broad classic `repo` token. Public upstream release metadata needs
no additional repository grant.

## Deploy

```sh
npm ci
npm test
npm run deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put CONTROL_SECRET
```

After both secrets exist, start the alarm chain once:

```sh
curl --fail --request POST \
  --header "Authorization: Bearer $CONTROL_SECRET" \
  https://pacman-release-checker.<workers-subdomain>.workers.dev/control/start
```

Use `POST /control/run` for an immediate check and `GET /control/status` to
inspect the last result and next scheduled alarm. Both require the same bearer
token. `GET /health` is public and contains no release or credential data.
