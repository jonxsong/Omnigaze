# Scheduled ingestion

Omnigaze has one trigger-independent bounded ingestion engine with separate licensed-news and SEC filing adapters. One invocation claims one due provider partition, fetches at most one page inside a frozen time window, persists minimal receipts and symbol links, advances the opaque cursor in the same lease-protected operation, and releases the run. It does not expose a public write endpoint and does not place trades.

The hosted trigger is intentionally external to the worker bundle. After deployment, link trusted Sites schedules to `run_intelligence_ingestion_tick` for news and, only after SEC identity/activation is ready, `run_sec_filing_ingestion_tick` for recent filings. Set each collection mode to `scheduled` only after its schedule is verified; this keeps health from claiming a trigger that does not exist.

## Required configuration

- `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`: server-only provider credentials.
- `INGESTION_OPERATOR_USER_ID`: the exact authenticated Sites user ID permitted to invoke the operator tool.
- `ALPACA_INGESTION_SYMBOLS`: optional comma-separated canonical IDs such as `NASDAQ:NVDA,NASDAQ:MSFT`. The core watchlist is used when omitted.
- `INGESTION_EXPECTED_CADENCE_SECONDS`: bounded to 60–86,400 seconds; defaults to 300.
- `INGESTION_COLLECTION_MODE`: leave as `request_time` until the hosted schedule is confirmed, then set to `scheduled`.
- `SEC_EDGAR_ENABLED`: exact `true` request/egress gate.
- `SEC_USER_AGENT`: truthful monitored application and operator contact identity.
- `SEC_DURABLE_INGESTION_ENABLED`: second exact `true` gate for durable recent filings.
- `SEC_INGESTION_SYMBOLS`: reviewed canonical symbols with stable CIK mappings; defaults to the core watchlist and groups share classes by CIK.
- `SEC_INGESTION_EXPECTED_CADENCE_SECONDS`: bounded to 60–86,400 seconds; defaults to 300.
- `SEC_INGESTION_COLLECTION_MODE`: leave `request_time` until the separate SEC schedule is confirmed.

Apply the checked-in D1 migration before the first tick. A tick fails closed when the schema or credentials are unavailable.

## Safety and recovery invariants

- Query fingerprints cover provider, symbols, exact start/end timestamps, page size, and ascending sort. A cursor cannot be reused with another query.
- SEC fingerprints also cover CIK and stream version. Continuation cursors contain only a strict keyset plus a digest of the frozen normalized recent-filing snapshot; a changed snapshot is rejected rather than traversed by an unsafe offset.
- The checkpoint window is frozen for all continuation pages. A new tick cannot skip ahead while a traversal is incomplete.
- Receipts are written before the cursor is advanced, under the same compare-and-swap lease. Replays are idempotent.
- Corrections use `providerUpdatedAt` for window validation while preserving the original `publishedAt`.
- SEC amendments use their own accession numbers and remain separate events. Equal-revision metadata corrections append an immutable receipt and the latest observation wins projection.
- Only a `minimal_redacted_v1` envelope is stored. Provider response bodies, credentials, headers, cursor tokens, and article bodies are not exposed through health or MCP status output.
- Rejected, mismatched, or repeated tokens clear the active traversal without advancing the completed scan watermark. The next due run opens a fresh overlap window.
- Each invocation performs at most one page and has bounded provider and tick deadlines. Another invocation resumes immediately when a next cursor remains.

## MCP invocation

Discovery uses `tools/list`. The call has a closed empty input schema:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "run_intelligence_ingestion_tick",
    "arguments": {}
  }
}
```

Use the same closed argument object with `name` set to
`run_sec_filing_ingestion_tick` for the independently gated SEC runner.

The request must carry the trusted authenticated identity injected by Sites, and that identity must equal `INGESTION_OPERATOR_USER_ID`. Client-supplied owner or partition arguments are rejected. Never expose this tool through an unauthenticated proxy.

For local verification, use the local Sites sign-in flow, configure a disposable operator user ID, call the tool once, then inspect `/api/health`. Run the focused suites with:

```text
pnpm exec vitest run tests/provider-resilience.test.ts tests/bounded-provider-ingestion.test.ts tests/intelligence-ingestion.test.ts tests/sec-filing-ingestion.test.ts tests/ingestion-repository.test.ts tests/ingestion-mcp.test.ts tests/ingestion-health.test.ts
```

Authenticated inbox reads project the newest 100 matching global receipts across the active news and SEC partitions before owner-state materialization and merge them with the request-time provider batch. Corrections use stable `provider:sourceEventId` identity, so they revise an event instead of duplicating it; SEC amendments remain distinct accessions. The global page's `hasMore` flag is not converted into an owner catch-up loop because no per-owner global cursor exists yet; older collected history remains a documented alpha cap rather than repeatedly scheduling the same top page.

## Health contract

`/api/health` and `get_provider_status` expose only aggregate ingestion state: collection mode, explicit status, expected cadence, last success, latest evidence, and per-provider counts. They never expose partition keys, symbols, leases, cursors, raw payloads, errors, operator IDs, or credentials.

Status precedence is:

1. `unavailable` when aggregate state cannot be read.
2. `degraded` when a partition has an unresolved failure.
3. `delayed` when a declared schedule is more than two cadences past its last success.
4. `catching_up` when a partition is due, resuming, or actively running.
5. `idle` when no checkpoint exists.
6. `healthy` otherwise.
