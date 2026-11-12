# Omnigaze

Omnigaze is a personalized market-intelligence workspace. Users search the active U.S. equity universe, track the companies they care about, record holdings, see material events as they arrive, and inspect an evidence-backed **Omnigaze View** that separates facts, derived observations, and AI inference.

The public alpha uses provider-backed quotes, chart history, licensed news, and SEC filings whenever those capabilities are configured. Every surface carries source, freshness, delay, and fallback metadata; illustrative fixtures are never labeled as live.

## Product loop

1. A user completes a local-first onboarding flow, searches the current asset catalog, and creates a personalized watchlist.
2. Provider adapters ingest market data, licensed news, SEC filings, and macro events.
3. The pipeline normalizes, timestamps, hashes, and deduplicates every source event.
4. Deterministic code calculates market changes and freshness.
5. The OpenAI Agents SDK produces a typed interpretation constrained to known evidence IDs.
6. Deterministic code—not the model—calculates any review zones and hypothetical share scenarios, and suppresses them when data is stale, demo, or insufficiently corroborated.
7. The dashboard, HTTP API, and MCP tools expose the same owner-scoped domain objects.

## Stack

- Next.js 16, React 19, and TypeScript
- Vinext and Cloudflare Workers through OpenAI Sites
- Tailwind CSS, Lucide, and Recharts
- Cloudflare D1 with Drizzle ORM
- OpenAI Agents SDK with Zod structured outputs
- MCP 2026-07-28 at `POST /mcp`
- Vitest, ESLint, and TypeScript release gates
- pnpm
- GitHub Actions CI with a locked, four-gate verification pipeline

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
pnpm dev
```

The portable Sites runtime serves on `http://127.0.0.1:5173` by default.

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
- `get_portfolio`
- `get_decision_support`
- `get_provider_status`

Use `server/discover`, `tools/list`, and `tools/call` with MCP version `2026-07-28`.

## Current limitations

- Alpaca currently uses resilient REST polling; long-lived streaming transport is a later infrastructure slice.
- SEC ingestion is available on demand but still needs a configured application/contact user agent and scheduled background ingestion.
- Alerts, notification delivery, and brokerage import/order execution are intentionally not part of this alpha.
- AI analysis requires an authenticated user and returns `503 ai_unconfigured` when the server secret is absent.
- Omnigaze provides research support, not investment advice or autonomous trading.
