# Omnigaze

Omnigaze is a personalized market-intelligence workspace. Users search the active U.S. equity universe, track the companies they care about, record holdings, keep a durable intelligence inbox, and inspect an evidence-backed **Omnigaze View** that separates facts, derived observations, and AI inference.

The public alpha uses provider-backed quotes, chart history, licensed news, and SEC filings whenever those capabilities are configured. Every surface carries source, freshness, delay, and fallback metadata; illustrative fixtures are never labeled as live.

## Product loop

1. A user completes a local-first onboarding flow, searches the current asset catalog, and creates a personalized watchlist.
2. Provider adapters ingest market data, licensed news, and configured SEC filings.
3. The pipeline normalizes, timestamps, hashes, and deduplicates every source event.
4. Deterministic code calculates market changes and freshness.
5. The OpenAI Agents SDK produces a typed interpretation constrained to known evidence IDs.
6. Deterministic code—not the model—calculates any review zones and hypothetical share scenarios, and suppresses them when data is stale, demo, or insufficiently corroborated.
7. A fresh live inbox read reconciles normalized events into D1, evaluates explicit in-app alert rules, and preserves per-user read, saved, and dismissed state across sessions.
8. The dashboard, HTTP API, and MCP tools expose the same owner-scoped domain objects.

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

The end-to-end data flow and failure boundaries are documented in [`docs/architecture.md`](docs/architecture.md).

## Local development

Requirements: Node.js 22.13+ and pnpm 11.25+.

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

The portable Sites runtime serves on `http://127.0.0.1:5173` by default.
`db:migrate:local` reconciles the additive Drizzle migrations with the persisted
local D1 database in `.wrangler/state`, records applied filenames, and is safe to
run again. Run it after pulling or generating a migration; it never deletes local
rows or resets the database.

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
| `SEC_USER_AGENT` | SEC-compliant application/contact identifier |

## Data integrity rules

- Every quote includes `asOf`, provider, delay, and market-session metadata.
- `publishedAt` and `observedAt` are separate to preserve point-in-time truth.
- Replayed events are idempotent; corrected source payloads remain historical records.
- Only live, fresh provider events can enter the durable inbox or create an alert delivery. Demo output is ignored; a successful stale live check may record activation metadata but persists no stale event or alert delivery.
- Inbox writes and alert rules use optimistic versions; exact retries are idempotent, while divergent stale writes fail with a conflict.
- The first successful live inbox sync baselines existing history as read so activation does not manufacture a backlog of alerts.
- Provider corrections retain their stable event identity and user state while exposing a new event revision and an `updated since read` signal.
- AI may interpret captured evidence but may not invent evidence IDs or act as a trading signal.
- AI output schemas do not include target-price or share-quantity fields. Scenario math is deterministic, versioned, and never places orders.
- Portfolio quantities and cost basis cross APIs as decimal strings and persist as scaled integers.
- Facts, derived values, inferences, and user views remain visibly distinct.
- A price movement is not treated as proof of causation.

## MCP surface

The initial stateless tool surface includes:

- `search_symbols`
- `get_market_snapshot`
- `get_intelligence_feed`
- `get_omnigaze_view`
- `get_watchlist_dashboard`
- `get_intelligence_inbox`
- `get_alert_rules`
- `get_portfolio`
- `get_decision_support`
- `get_provider_status`
- `run_intelligence_ingestion_tick` (closed operator tool; one provider page per call)

Use `server/discover`, `tools/list`, and `tools/call` with MCP version `2026-07-28`.

## Current limitations

- Alpaca currently uses resilient REST polling; long-lived streaming transport is a later infrastructure slice.
- A request-time news reconciliation still caps interactive reads at 100 events. The separate durable cursor engine processes exactly one frozen-window page per operator tick; continuous collection requires linking the authenticated MCP tool to a hosted schedule after deployment.
- SEC ingestion is available on demand but still needs a configured application/contact user agent and scheduled background ingestion.
- Alert rules currently deliver only inside the Omnigaze inbox during request-time refreshes. Email, SMS, push, browser notifications, and a continuously running background delivery worker are not enabled.
- Brokerage import and order execution are intentionally not part of this alpha.
- AI analysis requires an authenticated user and returns `503 ai_unconfigured` when the server secret is absent.
- Omnigaze provides research support, not investment advice or autonomous trading.

See [Scheduled ingestion](docs/scheduled-ingestion.md) for the operator contract, safety invariants, status semantics, and local verification workflow.
