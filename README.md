# instabox-keepalive

Keeps an [instabox](https://instabox.sh) machine awake, so the 30 minute idle pause
never takes it — from **Cloudflare Workers** or **any always-on host**, never from
the machine itself.

```bash
# Cloudflare Workers: no server to maintain
npx wrangler secret put INSTABOX_API_KEY
npx wrangler deploy

# any host with Node 18+
INSTABOX_API_KEY=ibk_... MACHINES=fadz-1 npx instabox-keepalive tick
```

## Why it has to run outside

An instabox machine pauses itself after 30 idle minutes. That decision is made by
the platform, not by the guest: a 2 minute timer *inside* the machine, writing
files and making requests, does not stop the pause. The free plan's window is
fixed at 1800 s and `autoSuspendAfterSeconds: 0` is refused.

The supported lever is an **activity lease**:

```http
PUT /v1/machines/{id}/activity-leases/{lease}
{"ttlSeconds": 900}
```

While the lease is alive the machine is not paused. Renewing it is one HTTPS
request, so it belongs on something that is always up and does not share the
machine's fate: a Worker cron, a VPS, a NAS, a router.

Two behaviours of the API worth knowing, both verified against the live service:

- The lease call answers **200 even while the machine is suspended**. The status
  code alone tells you nothing, so this project reads `state` and wakes the
  machine whenever it is not `running`.
- `POST /resume` on a paused machine answers `202` and the machine is back within
  seconds, with memory and processes intact.

That second point is also the answer to a stopped machine (a runtime cap, a
crash): the next round sees `stopped`, calls `start`, then renews the lease.

## Install

### A. Cloudflare Workers (no host to keep alive)

```bash
git clone https://github.com/<you>/instabox-keepalive
cd instabox-keepalive
npm install -D wrangler
npx wrangler login
npx wrangler secret put INSTABOX_API_KEY      # ibk_..., scope machines:write

# edit wrangler.toml: MACHINES, TTL, and the cron
npx wrangler deploy
```

`wrangler.toml` ships with `MACHINES = ""`, which keeps **every machine the key can
see**. Set `MACHINES = "fadz-1,m_agqx..."` (comma separated, names or IDs) to pick
specific ones.

Check it, without waiting for the cron:

```bash
curl -s https://instabox-keepalive.<account>.workers.dev/ | jq
# { "ok": true, "lease": "keepalive", "results": [ { "name": "fadz-1",
#   "state": "running", "expiresAt": "..." } ] }
```

Add a `TOKEN` secret and the endpoint requires `?token=...`; the cron keeps working.

### B. Any host with Node 18+

```bash
git clone https://github.com/<you>/instabox-keepalive
cd instabox-keepalive
cp .env.example .env && $EDITOR .env          # INSTABOX_API_KEY, MACHINES

node src/cli.js status                        # states only, no wake, no lease
node src/cli.js tick                          # one round
node src/cli.js watch                         # every INTERVAL seconds
node src/cli.js release                       # drop the lease, back to idle pause
```

`tick` exits 0 when every machine is running and leased, 1 otherwise — cron-ready:

```cron
*/5 * * * * cd /opt/instabox-keepalive && /usr/bin/node src/cli.js tick >>/var/log/ibx.log 2>&1
```

systemd, if you prefer a service that stays up:

```ini
# /etc/systemd/system/instabox-keepalive.service
[Unit]
Description=instabox keepalive
After=network-online.target

[Service]
WorkingDirectory=/opt/instabox-keepalive
EnvironmentFile=/opt/instabox-keepalive/.env
ExecStart=/usr/bin/node src/cli.js watch
Restart=always

[Install]
WantedBy=multi-user.target
```

### C. Docker

```bash
docker build -t instabox-keepalive .
docker run -d --restart=always --env-file .env instabox-keepalive
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INSTABOX_API_KEY` | — | **required**, `ibk_...`, scope `machines:write` |
| `MACHINES` | empty | comma separated IDs (`m_...`) or names; empty = every machine the key sees |
| `LEASE` | `keepalive` | lease name; different names are independent |
| `TTL` | `900` | lease lifetime in seconds, 30–3600 |
| `INTERVAL` | `300` | seconds between rounds for `watch` (min 60) |
| `RETRIES` | `3` | attempts per request on a dropped connection or 429/5xx |
| `DRY_RUN` | off | log what would happen, wake and renew nothing |
| `INSTABOX_API_URL` | `https://api.instabox.sh` | another deployment |

Workers read the same names from `[vars]`, except the key and `TOKEN`, which are
secrets.

**Pick `TTL` at least 3× your interval.** A Worker cron can be minutes late; with
`*/5 * * * *` and `TTL = 900` three consecutive failures still leave the machine
awake.

## API key

Dashboard → **Profile → API keys → Create Key**, scope `machines:write` (it
includes `machines:read`). The key is shown once. Never commit it: the Worker keeps
it as a secret, the CLI reads `.env`, which is gitignored.

## How a round works

```
GET  /v1/machines/{ref}                        state
  ├─ state == running  ────────────────────────┐
  └─ otherwise: POST .../resume   (409 → /start), poll until running
                                               │
PUT  /v1/machines/{id}/activity-leases/{lease} {"ttlSeconds": N}
                                               │
                             200 → expiresAt, 4xx → reported per machine
```

One machine failing does not stop the others; each result carries its own `ok`.

## Tests

```bash
node --test test/*.test.js
```

Everything runs against a stubbed API: no key, no network, no machine. The suite
covers the resume path, the `start` fallback, a machine that never comes back, a
refused lease, retries, pagination, dry run, and `release` being idempotent.

## Limits

- This keeps a machine **running**, it does not create more runtime if your plan
  caps it. When a stop does happen, the next round starts the machine again.
- A lease is per machine and per name, and expires on its own; `release` gives the
  machine back to the normal idle pause.
- Processes do not survive a stop, only files. For long jobs, run them as a systemd
  unit in the guest so they come back after a start.

## License

MIT
