# HRMS Pro

Multi-tenant HR system for running a software company: people, directory and org chart, team calendar and
events, leave, attendance,
timesheets, payroll with Bangladesh tax, loans, expenses, meal billing, recruitment, performance, helpdesk, letters,
policies, shareable reports and one search box for pages and records.

SvelteKit (Svelte 5) · TypeScript · Postgres 17 with row-level security · drizzle-orm · Redis + BullMQ · MinIO ·
Vitest · Playwright · Docker.

[![HRMS Pro walkthrough on YouTube: six roles, every module, live file attachments (6:51)](screenshots/walkthrough-video.png)](https://youtu.be/BGxO0nnjlsM)

<p align="center"><a href="https://youtu.be/BGxO0nnjlsM" target="_blank" rel="noopener">▶ Watch the 7-minute walkthrough on YouTube</a></p>

<p align="center"><a href="https://srabon444.github.io/hrms-pro/"><b>System design</b></a>: architecture, data model, business requirements and functional spec</p>

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="screenshots/home.png" alt="Owner dashboard"><br><sub>Dashboard scoped to the signed-in role</sub></td>
    <td width="50%"><img src="screenshots/employees.png" alt="Employee directory"><br><sub>Employee directory with filters and CSV import and export</sub></td>
  </tr>
  <tr>
    <td><img src="screenshots/payroll.png" alt="Payroll run"><br><sub>Payroll run with tax, provident fund and bank sheets</sub></td>
    <td><img src="screenshots/recruitment.png" alt="Recruitment pipeline"><br><sub>Recruitment pipeline from applied to hired</sub></td>
  </tr>
  <tr>
    <td><img src="screenshots/leave-approval.png" alt="Leave approval with a prescription"><br><sub>Leave approval with the attached prescription</sub></td>
    <td><img src="screenshots/roles.png" alt="Roles and permissions"><br><sub>Roles with permissions at own, team, department or company scope</sub></td>
  </tr>
</table>

## How it is built

- **Tenant isolation in the database.** Every tenant table has Postgres row-level security, so a missed filter in code
  still cannot leak another company's data.
- **Scoped permissions.** Each permission is granted at own, team, department or company scope, and every check runs
  on the server.
- **Files with access rules.** Attachments on 15+ record types (leave, resignations, candidates, offers, salary changes,
  projects, assets and more) live in MinIO and open only for people who may see the record.
- **One search box.** `Ctrl K` (or `/`) finds menu pages and records across 12 modules: people, documents, letters,
  policies, tickets, expenses, assets, projects, candidates, payroll runs and more. Each module answers through its own
  access rule, so search never shows a row its page would hide; confidential tickets match only by number.
- **AI with the company's own key.** Settings → AI lets an owner turn AI on (with an explicit consent that data is
  sent to the provider), pick Google Gemini, OpenAI or Anthropic Claude, paste the company's API key, pick a model and
  set a monthly token budget. A key is tested with one small call before it is saved, stored encrypted and bound to
  the organisation, and never shown, logged or audited; only its last four characters are. Calls go through a model
  chain that skips models the key cannot see and falls through on rate limits, outages and timeouts. Every call is
  rate limited per person and per organisation, reserved against the budget before it runs, recorded in a usage
  table kept for 13 months, and never made while a database transaction is open. Without a key, a platform Gemini
  key can be used if the operator sets `AI_PLATFORM_GEMINI=1` (only with a paid key) and has not switched AI off for
  that organisation on the platform page.
- **Money in integer poisha.** Payroll, tax, loans and meal bills never touch floating point.
- **Background work.** Email, meal bills and an hourly job for leave accrual, attendance and exits run on BullMQ
  workers backed by Redis. Each hourly step runs on its own, so one failure does not stop the others.
- **Directory and org chart.** Everyone can find colleagues, browse the reporting lines or departments and jump to
  their own place in the chart; work anniversaries and opt-in birthdays (day and month only) show on the home page.
  Optional parts like these are modules each organisation turns on or off.
- **Team calendar and events.** A month view (an agenda list on phones) of who is out, holidays and events, plus a
  private subscription link for Google Calendar, Outlook or Apple Calendar. The link is stored only as a hash, shows
  other people's leave just as "Out", stops working when the member, user or organisation is switched off or the
  password changes, and is rate limited per link and per address. Events go to everyone, a department or a branch;
  people answer going, maybe or not going and get a reminder the day before.
- **Leave balance cards.** The Leave page shows one card per leave type: days left, the balance today, after
  approved leave still to come and after pending requests, the accrual rule in plain words, and a history of every
  credit, leave, adjustment and lapse with the balance after it and links to attached files. The numbers come
  straight from the leave ledger.
- **Locked payslip PDFs by email.** An organisation can attach the payslip PDF to the payslip email. Each person
  sets their own payslip password (12 to 64 characters, not their sign-in password) and the attached PDF is locked
  with AES-256; without a password they get the link only. Downloads inside the app stay unlocked.
- **Work weeks.** Settings → Work weeks defines other weekends, such as Saturday–Sunday next to a Friday–Saturday
  company weekend, and a profile assigns one from a date onwards. Attendance, leave day counts, payroll working days
  and meal defaults follow each person's own weekend. A change can only start today or later, never inside a month
  whose payroll is approved, and it refuses to turn rest days inside booked leave into working days; leave days that
  become rest days are dropped and refunded.
- **Schedule.** The Schedule page is a weekly roster: a manager puts people on a shift or gives them a day off
  for each day, copies last week as drafts, and publishes the week, which tells each person. Staff only see
  published days. A published shift makes a weekend a working day for attendance and meals, a published day off
  makes a working day a rest day, and a work week marked "Rostered" rests people on every day without a shift.
  Leave days and payroll still follow the work week. People mark the times they are unavailable, and the grid flags
  a shift during them or over leave. Publishing refuses a shift over leave or inside a month whose payroll is
  approved, and warns about anyone with no rest day that week. Line managers schedule only their team.
- **Open shifts and shift swaps.** A manager can post an open shift; staff ask for it, and their approver gives
  it to one of them, which turns the other requests down. Staff can offer one of their published shifts to a
  colleague in their team or department, either as a swap for one of the colleague's shifts or as a give-away. The
  colleague accepts, then each person's approver approves; one approver over both people approves once. The swap
  is checked again at approval (employment, leave, another entry that day, approved payroll), the giver gets a
  published day off for the day they gave away, and attendance is recounted. Swaps nobody finished expire on the
  day. Requests show in the Approvals inbox, and each person's published shifts appear on their calendar and in
  their calendar feed.
- **International by default.** A new company starts on UTC, USD, a January fiscal year and a Saturday–Sunday
  weekend, or on the time zone, currency, fiscal month and weekend days its creator picks. Payslips, letters and
  reports print names in Latin, Cyrillic, Greek, Vietnamese, Devanagari and Bengali script.
- **Audit trail.** Database triggers record every change, with sensitive fields masked.
- **Tested.** 800+ unit, integration and end-to-end tests run against real Postgres, Redis and MinIO; a shared leak
  helper checks that reads stay inside each viewer's scope and tenant.

## Run it locally

```bash
cp .env.example .env && npm ci && npm run infra:up && npm run db:migrate
SEED_PASSWORD=secret npm run db:seed && npm run dev   # and `npm run worker`
```

The seed creates the demo company at `/t/demo` with `owner@demo.local`, `hr@demo.local`, `manager@demo.local`,
`staff@demo.local`, `payroll@demo.local` and `finance@demo.local`, all using `SEED_PASSWORD`.

Running, configuring and operating it: [RUNBOOK.md](RUNBOOK.md).
