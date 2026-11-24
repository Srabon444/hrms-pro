# HRMS Pro

Multi-tenant HR system for running a software company: people, leave, attendance, timesheets, payroll with Bangladesh
tax, loans, expenses, meal billing, recruitment, performance, helpdesk, letters, policies and shareable reports.

SvelteKit (Svelte 5) · TypeScript · Postgres 17 with row-level security · drizzle-orm · Redis + BullMQ · MinIO ·
Vitest · Playwright · Docker.

```bash
cp .env.example .env && npm ci && npm run infra:up && npm run db:migrate
SEED_PASSWORD=secret npm run db:seed && npm run dev   # and `npm run worker`
```

Running, configuring and operating it: [RUNBOOK.md](RUNBOOK.md).
