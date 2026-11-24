# HRMS Pro runbook

How to run, operate and recover the system. For what it does, see the README.

## Services

| Service  | Role                                                              | Port (dev) |
| -------- | ----------------------------------------------------------------- | ---------- |
| app      | SvelteKit server (`node build`)                                   | 3000       |
| worker   | BullMQ worker: mail, meal bills, hourly lifecycle job             | none       |
| migrate  | One-shot: database migrations, bucket, system-role sync           | none       |
| postgres | Postgres 17, row-level security per tenant                        | 55432      |
| redis    | Queues, rate limits, session cache, sign-in challenges (AOF on)   | 56379      |
| minio    | S3-compatible file store (documents, receipts, payslips, resumes) | 59000      |
| mailpit  | Local SMTP sink with a web inbox (dev only)                       | 58025      |

The app and worker both need Postgres and Redis. Only the worker sends mail.

## Run locally

```bash
cp .env.example .env            # fill every <...> value
npm ci
npm run infra:up                # postgres, redis, minio, mailpit
npm run db:migrate              # schema, roles, bucket, system roles
SEED_PASSWORD=secret npm run db:seed   # demo tenant at /t/demo
npm run dev                     # app on :5173
npm run worker                  # in a second terminal
```

Seeded users: `admin@hrms.local` (platform admin), `owner@demo.local`, `hr@demo.local`, `staff@demo.local`.

## Run with Docker

```bash
docker compose --profile app up -d --build
```

`migrate` runs first; `app` and `worker` start only after it succeeds. Set real secrets in the environment before this;
the compose defaults are for development.

## Configuration

Every variable is validated at startup (`src/lib/server/config.ts`); a bad value stops the process with the name of the
variable.

| Variable                                     | Notes                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`                               | `hrms_app` role, no BYPASSRLS. All tenant traffic.                                       |
| `AUTH_DATABASE_URL`                          | `hrms_auth` role. Users, sessions, tenant lookup.                                        |
| `OWNER_DATABASE_URL`                         | Table owner. Used only by `migrate`.                                                     |
| `HRMS_APP_DB_PASSWORD` `HRMS_AUTH_DB_PASSWORD` | `migrate` creates or updates the two roles with these.                                 |
| `APP_ENC_KEYS`                               | `kid:base64(32 bytes)`, comma separated. The first key encrypts; all keys decrypt.       |
| `METRICS_TOKEN`                              | Bearer token for `/metrics`.                                                             |
| `TEST_MODE`                                  | Enables e2e fixture endpoints. Refused when `NODE_ENV=production`.                       |
| `RL_*`, `TOTP_FAILS_PER_15MIN`               | Rate limits (login, reset, invite, mutations, downloads, 2FA). Defaults in `config.ts`.  |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET`    | Optional Google sign-in.                                                                 |

Business settings (leave, attendance, payroll, tax, meals, letters) live per tenant in the app under Settings, not in
the environment.

## Tenants and users

```bash
printf %s "$PW" | npm run cli -- create-platform-admin ops@example.com "Ops"
npm run cli -- create-tenant acme "Acme Ltd" owner@acme.com   # prints the owner's invitation link
```

The owner role cannot be edited or removed from the last owner. Every other built-in role is editable per tenant;
`migrate` brings built-in roles in line with the code without undoing an admin's own changes.

## Health and monitoring

- `GET /healthz`: process is up.
- `GET /readyz`: Postgres, Redis and MinIO reachable (503 otherwise). Use this for load balancer checks.
- `GET /metrics`: Prometheus metrics, `Authorization: Bearer $METRICS_TOKEN`.
- Logs are JSON (pino) on stdout. Postgres logs statements slower than 500 ms.

## Scheduled work

The worker registers one hourly job (minute 5). For each active tenant it, in order: completes exits whose last day
has passed and ends expired ex-employee access, accrues leave, recomputes attendance days, prepares and locks meal
days, retries stuck meal bill emails and purges candidate data past retention. Each step picks up whatever is due, so
a missed hour is caught up by the next one.

## Deploy

1. Build the image.
2. Run `migrate` to completion (migrations are forward only; take a backup first).
3. Roll `app` and `worker`. Both stop cleanly on SIGTERM.

Behind a reverse proxy, set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH` to the number of proxies in front of the
app. Without them every request appears to come from the proxy, so all clients share one login and reset rate-limit
bucket. Never set them when the app is reachable directly, or clients can choose their own address.

If Redis is down, sign-in, password reset and 2FA refuse requests rather than run without limits. Saves and downloads
keep working with limits counted in each app process's memory and log `redis rate limit unavailable; counting in memory`,
so with several app processes a user can briefly get that many times the normal allowance.

## Backup and restore

```bash
docker compose exec -T postgres pg_dump -U hrms_owner -Fc hrms > hrms-$(date +%F).dump
docker compose exec -T postgres pg_restore -U hrms_owner -d hrms --clean --if-exists < hrms-YYYY-MM-DD.dump
mc mirror local/hrms ./hrms-files      # MinIO bucket (configure `mc alias set local ...` first)
```

Back up Postgres and the MinIO bucket together; files are referenced by key from the database. Redis holds only queues, counters, a
session cache and in-progress sign-ins: losing it drops unsent mail jobs and half-finished logins, never records.

## Rotating secrets

- Encryption key: prepend a new `kid:key` to `APP_ENC_KEYS` and restart. Keep the old key in the list until nothing
  encrypted with it remains.
- Database passwords: change `HRMS_APP_DB_PASSWORD` / `HRMS_AUTH_DB_PASSWORD`, run `migrate`, restart app and worker.

## Tests

```bash
npm test                 # unit
npm run test:int         # integration, against the local Postgres/Redis/MinIO
npm run test:e2e         # Playwright; builds the app and starts a worker
```

## Troubleshooting

| Symptom                              | Check                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Startup fails "Invalid environment"  | The message names the variable.                                          |
| `/readyz` 503                        | The JSON body says which dependency is down.                             |
| No emails                            | Worker running? Mailpit (dev) or SMTP reachable? Failed jobs in Redis.   |
| User sees "permission" errors        | Their roles under Users; role grants under Roles.                        |
| 429 responses                        | Rate limit hit; limits are the `RL_*` variables.                         |
