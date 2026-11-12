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
- [x] Manual personalized Daily Brief with cited multi-symbol developments, omissions, unknowns, and visible AI-usage provenance.
- [x] Search discovery foundation: canonical metadata, JSON-LD, `robots.txt`, and `sitemap.xml`.
- [x] One persisted English/Chinese preference across the landing page, onboarding, dashboard, inbox, Daily Brief, Omnigaze View, and portfolio research workspaces.

## Market data and pipelines

- [x] Alpaca-backed active-equity catalog, quotes, historical bars, and licensed news adapters.
- [x] One bounded multi-symbol quote request for up to 12 dashboard symbols, with ordered partial results and per-symbol fallback metadata.
- [x] Explicit source, coverage, delay, observation time, response time, and fallback labels throughout the UI.
- [x] Normalized source-event and evidence contracts with content hashing and correction-aware identity.
- [x] Cloudflare D1 persistence with append-only Drizzle migrations.
- [x] Lease-protected, cursor-based news ingestion with frozen windows, idempotent page replay, bounded retention, and safe aggregate health.
- [x] Request-time inbox reconciliation that projects collected global receipts into owner-scoped state.
- [ ] Verify the hosted hourly operator tick after refreshing the Omnigaze app connection; keep collection labeled `request_time` until the first successful checkpoint.
- [x] Dormant SEC adapter with official ticker-catalog resolution, collision-safe class-share aliases, per-CIK request deduplication, bounded short-lived caching, global accession ordering, explicit partial-coverage reporting, and a production fail-closed activation gate.
- [ ] Add a distributed Fair Access coordinator with bounded admission, then configure a truthful application/contact user agent and explicitly activate production SEC egress. `SEC_USER_AGENT` alone cannot enable requests.
- [ ] Add durable scheduled SEC ingestion, historical backfill, and correction/removal reconciliation; the current adapter reads recent submissions on demand only.
- [ ] Add sub-minute streaming infrastructure for true push updates; the alpha intentionally uses resilient REST polling.

## AI and MCP

- [x] OpenAI Agents SDK analysis constrained to supplied evidence IDs and a strict Zod output contract.
- [x] Live Omnigaze View for any verified symbol, gated on authenticated, fresh, non-demo evidence.
- [x] Visible interpretation confidence, deterministic evidence coverage, citations, unknowns, prompt version, and generation time.
- [x] Manual model invocation only; selecting a stock or opening the dialog never spends an AI request automatically.
- [x] Deterministic review zones and hypothetical share scenarios that withhold numbers when evidence or quotes are inadequate.
- [x] Browser/API/MCP parity for market data, watchlists, portfolio, inbox, alert rules, provider status, live Omnigaze Views, and personalized Daily Briefs.
- [x] Closed operator-only MCP ingestion tool with authenticated identity enforcement.
- [x] Durable, model-aware AI-result caching with stable evidence fingerprints, freshness-bounded TTLs, atomic shared per-owner budgets, rolling limits, and cross-isolate leases.
- [x] Generated cross-watchlist Daily Brief with deterministic live-evidence selection, strict grounding, owner-scoped caching, HTTP/MCP parity, and a manual dashboard workflow.
- [x] Locale-aware Daily Brief and Omnigaze View generation with English/Chinese cache isolation, source-language preservation, and bilingual non-prescriptive output checks.

## Engineering and operations

- [x] TypeScript strict checks, ESLint, Vitest, production Worker build, migration reconciliation, and Playwright journeys.
- [x] Browser tests run serially because they intentionally share one local D1 and one Sites test identity.
- [x] Provider deadlines, bounded pagination, partial failure handling, optimistic concurrency, and no-store owner responses.
- [x] Health/readiness contracts for database schema, providers, ingestion mode, cadence, latest success, and evidence time.
- [x] Public secrets remain server-side; repository credential-pattern scans are part of release review.
- [x] GitHub Actions runs the locked end-to-end release gates.
- [ ] Rotate credentials that were ever shared outside the secret manager, then update the deployed secret values.
- [x] Lazy-load the Recharts workspace and reduce the initial dashboard bundle by roughly one third.
- [x] Privacy-bounded production error and latency telemetry for health, batched quotes, explicit AI generation, and MCP, including correlated response headers and uncaught Vinext runtime errors.
- [ ] Extend telemetry to the remaining HTTP routes and establish a sampling/retention policy before materially higher traffic.
- [x] Localize product controls, accessibility labels, validation, and safe error states while preserving tickers, company names, and cited source material in their original language.
