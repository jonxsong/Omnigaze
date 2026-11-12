# Omnigaze product status

This checklist tracks shipped repository capabilities and the next production milestones. A checked item means the code path is implemented and covered by an automated release gate; it does not imply every upstream provider is configured in every environment.

## Product and UX

- [x] Startup landing page with responsive product storytelling and English/Chinese presentation.
- [x] Local-first onboarding survey for watchlist, owned shares, average cost, goals, horizon, risk comfort, and liquidity preferences.
- [x] Debounced search across the active U.S. equity catalog during onboarding and from the dashboard.
- [x] Durable arbitrary-stock descriptors across anonymous reloads, with server-side canonical verification before authenticated writes.
- [x] Personalized watchlist and holdings dashboard with optimistic persistence and conflict recovery.
- [x] Intelligence timeline with neutral handling of controversial executive, governance, legal, and reputational events.
- [x] Durable intelligence inbox with read, saved, dismissed, and corrected-since-read state.
- [x] Explicit in-app alert rules with idempotent delivery records.
- [x] Responsive desktop and mobile layouts, including a scroll-safe live Omnigaze View.
- [x] Search discovery foundation: canonical metadata, JSON-LD, `robots.txt`, and `sitemap.xml`.

## Market data and pipelines

- [x] Alpaca-backed active-equity catalog, quotes, historical bars, and licensed news adapters.
- [x] One bounded multi-symbol quote request for up to 12 dashboard symbols, with ordered partial results and per-symbol fallback metadata.
- [x] Explicit source, coverage, delay, observation time, response time, and fallback labels throughout the UI.
- [x] Normalized source-event and evidence contracts with content hashing and correction-aware identity.
- [x] Cloudflare D1 persistence with append-only Drizzle migrations.
- [x] Lease-protected, cursor-based news ingestion with frozen windows, idempotent page replay, bounded retention, and safe aggregate health.
- [x] Request-time inbox reconciliation that projects collected global receipts into owner-scoped state.
- [ ] Verify the hosted hourly operator tick after refreshing the Omnigaze app connection; keep collection labeled `request_time` until the first successful checkpoint.
- [ ] Configure a real SEC application/contact user agent and broaden CIK resolution beyond the initial supported set.
- [ ] Add sub-minute streaming infrastructure for true push updates; the alpha intentionally uses resilient REST polling.

## AI and MCP

- [x] OpenAI Agents SDK analysis constrained to supplied evidence IDs and a strict Zod output contract.
- [x] Live Omnigaze View for any verified symbol, gated on authenticated, fresh, non-demo evidence.
- [x] Visible interpretation confidence, deterministic evidence coverage, citations, unknowns, prompt version, and generation time.
- [x] Manual model invocation only; selecting a stock or opening the dialog never spends an AI request automatically.
- [x] Deterministic review zones and hypothetical share scenarios that withhold numbers when evidence or quotes are inadequate.
- [x] Browser/API/MCP parity for market data, watchlists, portfolio, inbox, alert rules, provider status, and live Omnigaze Views.
- [x] Closed operator-only MCP ingestion tool with authenticated identity enforcement.
- [x] Durable, model-aware AI-result caching with stable evidence fingerprints, five-minute freshness-bounded TTLs, atomic per-owner budgets, rolling limits, and cross-isolate leases.
- [x] Daily Brief core contracts, grounded evidence selection, and correction-aware cache identity; no model, API, MCP, or dashboard invocation is enabled yet.
- [ ] Add a generated cross-watchlist daily brief using the existing personal Today feed.

## Engineering and operations

- [x] TypeScript strict checks, ESLint, Vitest, production Worker build, migration reconciliation, and Playwright journeys.
- [x] Browser tests run serially because they intentionally share one local D1 and one Sites test identity.
- [x] Provider deadlines, bounded pagination, partial failure handling, optimistic concurrency, and no-store owner responses.
- [x] Health/readiness contracts for database schema, providers, ingestion mode, cadence, latest success, and evidence time.
- [x] Public secrets remain server-side; repository credential-pattern scans are part of release review.
- [x] GitHub Actions runs the locked end-to-end release gates.
- [ ] Rotate credentials that were ever shared outside the secret manager, then update the deployed secret values.
- [ ] Split the largest client chunk and add production error/latency telemetry.
- [ ] Complete Chinese localization for onboarding, dashboard, inbox, and research workspaces.
