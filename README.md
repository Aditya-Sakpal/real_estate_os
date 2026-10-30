# Sales Desk: a real estate sales and marketing OS

An AI system of action for Indian real estate developers, the mandate firms
that sell for them and their channel-partner networks. It sits beside the
CRM and does the work: calls every enquiry within minutes, books and
confirms site visits, writes and designs compliant ads, publishes them,
and tells the ad platforms which leads became buyers.

Multi-tenant, built on Next.js 15, React 19 and PostgreSQL with row-level
security. About 225,000 lines of TypeScript, 129 migrations and 42 end-to-end
check suites.

## What it does

**Leads to bookings**
- Captures leads from Meta and Google lead forms, property portals, websites
  and inbound calls, de-duplicated by ownership rules (junk, already booked,
  a partner's buyer, the same open lead, new).
- An AI voice agent (Sarvam over Vobiz telephony) calls each lead in Hindi,
  Marathi or English, inside calling hours and consent rules, and hands a
  ready buyer to a free salesperson mid-call.
- Every call is read into nine qualification fields, each kept only when
  the buyer's own words are found in the transcript; a weighted score routes
  the lead hot, warm or cold.
- Site visits with per-hour capacity, a QR pass checked in offline at the
  site, host voice notes transcribed and drafted into the visit record, and
  a follow-up chosen by the buyer's objection.
- Quotes with GST, stamp duty and registration by state, a flat held while a
  token link (the developer's own Razorpay) is out, and booking on payment.

**Marketing**
- A "Project Brain": every fact about a building (prices, registration,
  possession, amenities) signed by named approvers, versioned and immutable
  once published, and read from the developer's own PDFs with the page and
  box each value came from.
- Copy written by an LLM and passed through a deterministic gate: every
  number, price and claim must trace to a signed fact, or the copy is sent
  back to the writer.
- An art-director agent designs image ads and carousels, looks at each
  attempt and asks again with a specific fix; a "pixel gate" then reads the
  finished file (OCR, QR decoding, contrast and placement) before anything
  can publish.
- 15 to 30 second video ads from per-format skills, with scene-by-scene
  repair, a voice fix for mispronounced words and lip-sync checks.
- Publishing to Facebook, Instagram, Meta ads and Google Search, Performance
  Max and Demand Gen, with a kill switch that pauses spend the moment a
  project stops being advertisable.
- Closed-loop attribution: qualified leads, visits and bookings sent back to
  Meta and Google so bidding optimises for buyers, not form fills.

**Partners and teams**
- Channel-partner empanelment, buyer registration with a logged verdict,
  commission ladders, invoices and payouts; a WhatsApp bot for partners.
- Mandate firms working a developer's projects through scoped grants.
- "Ask Jimmy": a chat assistant that answers questions over a typed data map
  (never model-written SQL), scoped to the asker's permissions, and proposes
  actions a person confirms.

**Compliance built in**
- RERA registration checked against state portals (Maharashtra and eight
  more) at the form and nightly; one publish gate every outbound surface
  passes through.
- Buyer phone numbers masked by policy on the server, with audited reveals.
- Append-only audit log, DPDP-style erasure that scrubs rather than deletes.

## Architecture

| Layer | How |
| --- | --- |
| Tenancy | `org > entity > region > project > phase` scope tree on `ltree`; every membership scoped to a node |
| Isolation | PostgreSQL RLS on every tenant table, enforced for the app role; policies fail closed |
| Authorization | 64 `resource:action` permissions, 16 shipped roles plus tenant-edited copies; you grant only what you hold, where you hold it |
| Auth | Work accounts only (Google Workspace, Microsoft Entra), SAML SSO and SCIM, phone sign-in for partners |
| Secrets | Connector tokens sealed with AES-256-GCM under per-tenant data keys (AWS KMS) |
| Jobs | Leased, idempotent workers on timers (lead engine, posts, reels, CRM sync, billing sweep) |
| Billing | Plans, metering, a prepaid wallet with a database-guarded ledger, GST invoices and credit notes |
| AI | OpenAI (copy, design, reading), Sarvam (voice, speech), Seedance and Kling (video), ElevenLabs (voice repair) |
| Media | sharp, FFmpeg, Remotion, Tesseract, OpenCV (WASM) |

Every paid model call is priced before it is written, refused before it is
spent, and capped per attempt.

## Run it

```bash
cp .env.example .env.local      # fill in what you have
docker compose up -d            # Postgres
psql -f db/bootstrap.sql        # roles, once, as superuser
npm install
npm run db:migrate
npm run seed:dev-tenant         # a sample developer, project and tower
npm run dev
```

`npm run check` runs the type check, the pure-logic suite and the
isolation suite, which seeds two tenants and attacks one from the other.
