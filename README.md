# Omnigaze

Omnigaze is a personalized market-intelligence workspace. Users search the active U.S. equity universe, track the companies they care about, record holdings, inspect a live fixed-point **Portfolio Pulse**, keep a durable intelligence inbox, generate a cited cross-watchlist **Daily Brief**, and open an evidence-backed **Omnigaze View** that separates facts, derived observations, and AI inference.

The public alpha uses provider-backed quotes, chart history, and licensed news whenever those capabilities are configured. The SEC adapter now has a distributed D1 Fair Access coordinator plus durable recent-filing cursor ingestion, but production egress remains fail-closed until an operator supplies a truthful monitored contact identity and explicitly enables both requested SEC capabilities. Every surface carries source, freshness, delay, and fallback metadata; illustrative fixtures are never labeled as live.

## Product loop

1. A user completes a local-first onboarding flow, searches the current asset catalog, and creates a personalized watchlist.
2. Provider adapters ingest market data and licensed news; the guarded SEC adapter and its separate durable collector remain dormant unless their explicit activation and contact-identity requirements are satisfied.
3. The pipeline normalizes, timestamps, hashes, and deduplicates every source event. One unified read plane then merges fresh request-time responses with retained D1 receipts; the newest provider revision wins and an exact tie prefers the durable receipt.
4. Deterministic fixed-point code calculates market changes, freshness, portfolio value, daily contribution, unrealized P&L, and concentration. Missing, stale, or demo quotes remain explicit exclusions rather than zero-valued positions.
5. A fail-closed D1 guard checks owner-safe, model-aware evidence caches and atomically reserves the authenticated owner’s shared generation budget.
6. On a cache miss, the OpenAI Agents SDK produces a typed interpretation constrained to known evidence IDs. A single-stock view is cached for at most five minutes; a Daily Brief is keyed by the exact watchlist, evidence revisions, prompt, model, and UTC date and is cached for at most six hours. Neither cache stores a raw prompt.
7. Deterministic code—not the model—calculates any review zones and hypothetical share scenarios, and suppresses them when data is stale, demo, or insufficiently corroborated.
8. A fresh live inbox read reconciles normalized events into D1, evaluates explicit in-app alert rules, and preserves per-user read, saved, and dismissed state across sessions.
9. The dashboard, HTTP API, and MCP tools expose the same owner-scoped domain objects. Authenticated MCP clients can also update watchlist membership, upsert holdings, change inbox state, and configure in-app alert rules through the same strict parsers as the browser. Holdings, inbox state, and alert rules retain optimistic versions; watchlist set mutations remain idempotent.

## Stack

- Next.js 16, React 19, and TypeScript
- Vinext and Cloudflare Workers through OpenAI Sites
- Tailwind CSS, Lucide, and Recharts
- Cloudflare D1 with Drizzle ORM
- OpenAI Agents SDK with Zod structured outputs
- MCP 2026-07-28 at `POST /mcp`
- Vitest, ESLint, and TypeScript release gates
- pnpm
- GitHub Actions CI with locked static, domain, build, migration, and browser gates

## Repository map

```text
app/
  api/                 Browser-facing APIs and provider-safe server boundaries
  mcp/                 Stateless MCP JSON-RPC endpoint
components/            Interactive dashboard
db/                    Drizzle schema and D1 access
drizzle/               Reviewed, append-only database migrations
lib/
  ai/                   Evidence-constrained analysis agents and output gates
  intelligence-inbox/   Durable event projection, owner state, and alert rules
  portfolio/            Decimal-safe contracts and deterministic scenarios
  pipeline/             Ingestion contracts and deduplication
  providers/            Market, news, and filing adapters
  repositories/         User-owned persistence
  services/             Shared application/MCP domain services
tests/                  Domain and MCP contract tests
docs/                   Architecture and engineering decisions
```

The end-to-end data flow and failure boundaries are documented in [`docs/architecture.md`](docs/architecture.md). The shipped-capability checklist and remaining production milestones live in [`docs/product-status.md`](docs/product-status.md).

## Local development

Requirements: Node.js 22.13+ and pnpm 11.25+.

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

The portable Sites runtime serves on `http://127.0.0.1:5173` by default.
`db:migrate:local` reconciles the reviewed, append-only Drizzle migration history
with the persisted local D1 database in `.wrangler/state`, records applied
filenames, and is safe to run again. The reconciler permits additive tables and
indexes plus the checksum-audited 0006 reservation-table rebuild that preserves
every existing row; altered destructive SQL is rejected. Run it after pulling or
generating a migration; it never resets the database.

Useful release checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Generate a new migration after changing `db/schema.ts`:

```bash
pnpm db:generate
pnpm db:migrate:local
```

Never edit a migration that has been applied. Append a new migration instead.

## Runtime configuration

Copy `.env.example` for local development. Never commit `.env` files or API keys.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side Omnigaze analysis |
| `OPENAI_MODEL` | Optional Agents SDK model override |
| `ALPACA_API_KEY_ID` | Market-data/news provider identity |
| `ALPACA_API_SECRET_KEY` | Market-data/news provider secret |
| `ALPACA_TRADING_API_BASE_URL` | Allowlisted paper/live Trading API host for asset search |
| `ALPACA_DATA_FEED` | `iex` for development or licensed `sip` where entitled |
| `OMNIGAZE_TELEMETRY_SUCCESS_SAMPLE_RATE` | Server-only `0`–`1` sampling rate for ordinary successful HTTP API completion logs; MCP, errors, and slow requests always emit |
| `SEC_EDGAR_ENABLED` | Exact `true` opt-in for request-time SEC egress; remains inert without the D1 coordinator and a valid contact-bearing identity |
| `SEC_USER_AGENT` | Truthful SEC-compliant application/contact identifier; it never activates production egress by itself |
| `SEC_DURABLE_INGESTION_ENABLED` | Independent exact `true` opt-in for durable recent-filing collection; all request-time SEC gates still apply |
| `SEC_INGESTION_SYMBOLS` | Reviewed canonical symbols with stable CIK mappings, grouped into one durable partition per issuer |
| `SEC_INGESTION_COLLECTION_MODE` | Leave `request_time` until the SEC operator schedule is linked and verified; then set `scheduled` |
| `SEC_INGESTION_EXPECTED_CADENCE_SECONDS` | Bounded 60–86,400 second SEC due interval, publicly reported only for a declared schedule |

## Data integrity rules

- Every quote includes `asOf`, provider, delay, and market-session metadata.
- `publishedAt` and `observedAt` are separate to preserve point-in-time truth.
- Replayed events are idempotent; corrected source payloads remain historical records.
- Only live, fresh provider events can enter the durable inbox or create an alert delivery. Demo output is ignored; a successful stale live check may record activation metadata but persists no stale event or alert delivery.
- Inbox writes and alert rules use optimistic versions; exact retries are idempotent, while divergent stale writes fail with a conflict.
- The first successful live inbox sync baselines existing history as read so activation does not manufacture a backlog of alerts.
- Provider corrections retain their stable event identity and user state while exposing a new event revision and an `updated since read` signal.
- AI may interpret captured evidence but may not invent evidence IDs or act as a trading signal.
- AI generation is manual, authenticated, and fail-closed behind a durable model-aware cache plus atomic per-owner budgets. The ledger stores hashed request/operation keys, not prompts, credentials, headers, or raw provider payloads.
- Single-stock views and Daily Briefs share the default policy of 20 attempts per UTC day, 5 per rolling minute, and 2 concurrent leases per owner. Exact active retries are denied until the existing lease expires; cache hits and in-isolate followers spend no additional model budget.
- AI output schemas do not include target-price or share-quantity fields. Scenario math is deterministic, versioned, and never places orders.
- Portfolio quantities and cost basis cross APIs as decimal strings and persist as scaled integers.
- Portfolio Pulse uses BigInt micro-units, returns decimal strings, bounds each calculation to 50 positions, reports omitted and excluded coverage, and never treats a missing quote as zero.
- Facts, derived values, inferences, and user views remain visibly distinct.
- A price movement is not treated as proof of causation.

## MCP surface

The initial stateless tool surface includes:

- `search_symbols`
- `get_market_snapshot`
- `get_intelligence_feed`
- `get_omnigaze_view`
- `get_daily_brief`
- `get_watchlist_dashboard`
- `update_watchlist`
- `get_intelligence_inbox`
- `update_intelligence_inbox_item`
- `get_alert_rules`
- `put_alert_rule`
- `get_portfolio`
- `put_portfolio_holding`
- `get_portfolio_pulse`
- `get_decision_support`
- `get_provider_status`
- `run_intelligence_ingestion_tick` (closed operator tool; one provider page per call)
- `run_sec_filing_ingestion_tick` (closed operator tool; one recent-filing page per call, independently fail-closed)

Use `server/discover`, `tools/list`, and `tools/call` with MCP version `2026-07-28`.

## Current limitations

- Alpaca currently uses resilient REST polling; long-lived streaming transport is a later infrastructure slice.
- A request-time news reconciliation still caps interactive reads at 100 events. The separate durable cursor engine processes exactly one frozen-window page per operator tick; continuous collection requires a linked hosted schedule, a current authenticated Omnigaze app connection, and at least one verified successful tick before the UI may claim scheduled collection.
- The unified read plane makes fresh durable receipts available to the timeline, Today, AI, portfolio research, and MCP during a request-time provider outage. Owner inbox projection still has a 100-event global-page cap and requires a future per-owner projection cursor for complete offline catch-up.
- The SEC adapter, distributed Fair Access coordinator, and durable recent-filing cursor engine are covered by tests, but production egress remains disabled until a truthful monitored application/contact identity is configured and `SEC_EDGAR_ENABLED` is set to exact `true`. Any durable tick additionally requires `SEC_DURABLE_INGESTION_ENABLED=true`; continuous collection requires a verified operator schedule. Historical shard backfill and authoritative correction/removal reconciliation remain separate milestones.
- Alert rules currently deliver only inside the Omnigaze inbox during request-time refreshes. Email, SMS, push, browser notifications, and a continuously running background delivery worker are not enabled.
- Brokerage import and order execution are intentionally not part of this alpha.
- AI analysis requires an authenticated user, runs only after an explicit user request, and returns `503 ai_unconfigured` when the server secret is absent. Daily Brief generation is manual rather than scheduled; it fails closed when the watchlist has no eligible fresh live evidence.
- Omnigaze provides research support, not investment advice or autonomous trading.

See [Scheduled ingestion](docs/scheduled-ingestion.md) for the operator contract, safety invariants, status semantics, and local verification workflow.
