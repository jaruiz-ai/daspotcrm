# Da Spot 214 CRM — Phase 1

Shop CRM for a window tint and wrap shop: leads from texts and WhatsApp, quotes, scheduling,
payments, Texas tint-law waivers, warranties and claims, and partner rev-share.

```
apps/api   Express + TypeScript + Postgres (Zod validation, SQL migrations)
apps/web   React + Vite, mobile-first staff app
```

## Run it locally (no setup)

```bash
npm install
npm -w apps/api run dev     # API on :4000 with an in-memory Postgres and demo film products
npm -w apps/web run dev     # app on :5173 — sign in with access code: dev-token
```

Text a lead in without Twilio:

```bash
curl -X POST localhost:4000/webhooks/twilio/inbound \
  -d 'From=+12145550111&Body=how much for 20% on a 2022 camry&MessageSid=SM1'
```

## Tests

```bash
npm test          # 134 API tests + 9 end-to-end UI tests
npm run typecheck
npm run build
```

API tests run against a real Postgres engine in-process (PGlite), so constraints, locks and
date math behave as in production. UI tests drive the React app through a live API.

## Deploy

Set these, then `npm run build` and `npm -w apps/api start`. The API serves the staff app too,
so one address (for example `admin.daspot214.com`) is all you host:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres 13+ connection string. Migrations run on start. |
| `STAFF_API_TOKEN` | Shop access code, random, 24+ characters |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_SMS_FROM` | The shop's Twilio number, E.164 |
| `TWILIO_WHATSAPP_FROM` | WhatsApp sender, if different from the SMS number |
| `PUBLIC_BASE_URL` | e.g. `https://crm.daspot214.com` — used to verify Twilio signatures |

With `DATABASE_URL` set the server refuses to start if any of the others are missing.
Point both the SMS and WhatsApp inbound webhooks in Twilio at `POST {PUBLIC_BASE_URL}/webhooks/twilio/inbound`.

## On phones

The app is built phone-first. On iPhone, open the CRM address in Safari, tap Share, then
Add to Home Screen; on Android, use Chrome's menu and Install app. It then opens full screen
with the Da Spot icon, like a native app.

## Payments

Record a payment with one tap on the job: **Paid by card**, **Paid cash** or **Paid Zelle** (the balance is filled in).
The job moves to Paid, warranties are issued, and the customer gets a receipt text with their warranty numbers.

## Importing past clients

Warranties → Import past clients. In Google Sheets choose File → Download → Comma-separated values (.csv), then
choose that file. Columns are matched by name (name, phone, email, vehicle or year/make/model, plate, VIN, install
date, film, shade, warranty number, warranty end date or length, notes) and can be changed in the preview.

Warranty dates: start is the install date in the sheet; end is the sheet's end date, else install date plus the
sheet's length, else plus the film's standard term; "Lifetime" means no end date. The sheet's warranty numbers are
kept. Dates read month-first unless the column proves day-first; the preview says which and lets you switch.
Month ends follow the calendar (Feb 29, 2024 + 5 years = Feb 28, 2029). The import saves exactly the preview's
dates, and importing the same file twice creates no duplicates.

## iPhone

Built for one-handed use on an iPhone: a bottom tab bar, the job's next step pinned above it, and content kept
clear of the notch and home indicator (`--sat`/`--sab` safe-area variables in `styles.css`). Anything that records
money, texts a customer, cancels, or removes asks first in a bottom sheet. The bottom bars step aside while the
keyboard is up. `tools/iphone-tap-audit.mjs` checks every screen at iPhone SE and iPhone 15 Pro sizes for targets
under 44pt, overlapping or crowded targets, and anything stuck under the bars or home indicator.

## Business rules enforced

- A lead's phone number is its identity (E.164, unique). Texts and WhatsApp from the same number land on one contact.
- Paid is never set by hand; a completed job moves to Paid when the balance hits $0, and that issues warranties.
- Front side windows darker than 25% VLT need a signed acknowledgment before a job can be completed.
- No overpayments, no refunds above what was paid, no price changes that drop the total below what was paid.
- Several cars can be booked at the same time (no bays). Losing a job cancels its future appointments; cancelling the last one puts a Booked job back to Quoted.
- Warranties start on the shop-local (Dallas) day the job was completed.
- Rev-share is paid on pre-tax collected revenue; refunds post negative ledger lines.
- Webhook retries are idempotent (Twilio MessageSid); a failed auto-reply never loses the lead.

## Placeholders to replace

- Film products and warranty terms are seeded as "House" Carbon / Carbon-Ceramic / Nano Ceramic / Architectural.
  Replace with the shop's real brands and terms (`POST /api/film-products`).
- Sales tax defaults to 8.25% (Dallas). Change per job with `PATCH /api/jobs/:id`.
- Rev-share supports the gross basis only; net-of-material needs film usage tracking (Phase 2).

## Not in Phase 1

Individual staff logins and roles (one shared access code for now), Stripe card capture, reminder texts on a
schedule, Instagram DM capture, reports, warranty PDF cards. See the spec doc for Phase 2–3.
