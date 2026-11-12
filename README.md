# Omnigaze

Omnigaze is a personalized market-intelligence workspace. Users track the stocks they care about, see material events as they arrive, and inspect an evidence-backed **Omnigaze View** that separates facts, derived observations, and AI inference.

The current repository is the production-minded foundation. The UI is interactive, but its visible market dataset is deliberately labeled as fixture data until licensed providers are configured and verified.

## Product loop

1. A user creates or edits a watchlist.
2. Provider adapters ingest market data, licensed news, SEC filings, and macro events.
3. The pipeline normalizes, timestamps, hashes, and deduplicates every source event.
4. Deterministic code calculates market changes and freshness.
5. The OpenAI Agents SDK produces a typed interpretation constrained to known evidence IDs.
6. The dashboard, API, alerts, and MCP tools expose the same domain objects.

## Stack

- Next.js 16, React 19, and TypeScript
- Vinext and Cloudflare Workers through OpenAI Sites
- Tailwind CSS, Lucide, and Recharts
- Cloudflare D1 with Drizzle ORM
- OpenAI Agents SDK with Zod structured outputs
- MCP 2026-07-28 at `POST /mcp`
- Vitest, ESLint, and TypeScript release gates
- pnpm

## Repository map

```text
app/
  api/                 Browser-facing APIs and provider-safe server boundaries
  mcp/                 Stateless MCP JSON-RPC endpoint
components/            Interactive dashboard
db/                    Drizzle schema and D1 access
drizzle/               Reviewed, append-only database migrations
lib/
  ai/                   Evidence-constrained analysis agent
  pipeline/             Ingestion contracts and deduplication
  providers/            Market, news, and filing adapters
  repositories/         User-owned persistence
  services/             Shared application/MCP domain services
tests/                  Domain and MCP contract tests
```

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
| `ALPACA_DATA_FEED` | `iex` for development or licensed `sip` where entitled |
| `SEC_USER_AGENT` | SEC-compliant application/contact identifier |

## Data integrity rules

- Every quote includes `asOf`, provider, delay, and market-session metadata.
- `publishedAt` and `observedAt` are separate to preserve point-in-time truth.
- Replayed events are idempotent; corrected source payloads remain historical records.
- AI may interpret captured evidence but may not invent evidence IDs or act as a trading signal.
- Facts, derived values, inferences, and user views remain visibly distinct.
- A price movement is not treated as proof of causation.

## MCP surface

The initial stateless tool surface includes:

- `search_symbols`
- `get_market_snapshot`
- `get_intelligence_feed`
- `get_omnigaze_view`
- `get_watchlist_dashboard`

Use `server/discover`, `tools/list`, and `tools/call` with MCP version `2026-07-28`.

## Current limitations

- The visible dashboard uses fixture data until live provider credentials are configured.
- The Alpaca adapter currently uses REST snapshots/news; long-lived streaming transport is a later infrastructure slice.
- SEC ingestion is implemented as a provider boundary but is not scheduled yet.
- The AI route returns `503 ai_unconfigured` when the server secret is absent.
- Omnigaze provides research support, not investment advice or autonomous trading.
