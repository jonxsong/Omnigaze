# Scheduled ingestion

Omnigaze has a trigger-independent ingestion engine. One invocation claims one due Alpaca news partition, fetches at most one provider page inside a frozen time window, persists minimal receipts and symbol links, advances the opaque cursor in the same lease-protected operation, and releases the run. It does not expose a public write endpoint and does not place trades.

The hosted trigger is intentionally external to the worker bundle. After deployment, link a trusted Sites schedule to the `run_intelligence_ingestion_tick` MCP tool. Only then set `INGESTION_COLLECTION_MODE=scheduled`; this keeps the health API from claiming a schedule that does not exist.

## Required configuration

- `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`: server-only provider credentials.
- `INGESTION_OPERATOR_USER_ID`: the exact authenticated Sites user ID permitted to invoke the operator tool.
- `ALPACA_INGESTION_SYMBOLS`: optional comma-separated canonical IDs such as `NASDAQ:NVDA,NASDAQ:MSFT`. The core watchlist is used when omitted.
- `INGESTION_EXPECTED_CADENCE_SECONDS`: bounded to 60–86,400 seconds; defaults to 300.
- `INGESTION_COLLECTION_MODE`: leave as `request_time` until the hosted schedule is confirmed, then set to `scheduled`.

Apply the checked-in D1 migration before the first tick. A tick fails closed when the schema or credentials are unavailable.

## Safety and recovery invariants

- Query fingerprints cover provider, symbols, exact start/end timestamps, page size, and ascending sort. A cursor cannot be reused with another query.
- The checkpoint window is frozen for all continuation pages. A new tick cannot skip ahead while a traversal is incomplete.
- Receipts are written before the cursor is advanced, under the same compare-and-swap lease. Replays are idempotent.
- Corrections use `providerUpdatedAt` for window validation while preserving the original `publishedAt`.
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

The request must carry the trusted authenticated identity injected by Sites, and that identity must equal `INGESTION_OPERATOR_USER_ID`. Client-supplied owner or partition arguments are rejected. Never expose this tool through an unauthenticated proxy.

For local verification, use the local Sites sign-in flow, configure a disposable operator user ID, call the tool once, then inspect `/api/health`. Run the focused suites with:

```text
pnpm exec vitest run tests/provider-resilience.test.ts tests/intelligence-ingestion.test.ts tests/ingestion-repository.test.ts tests/ingestion-mcp.test.ts tests/ingestion-health.test.ts
```

Authenticated inbox reads project the newest 100 matching global receipts before owner-state materialization and merge them with the request-time provider batch. Corrections use stable `provider:sourceEventId` identity, so they revise an event instead of duplicating it. The global page's `hasMore` flag is not converted into an owner catch-up loop because no per-owner global cursor exists yet; older collected history remains a documented alpha cap rather than repeatedly scheduling the same top page.

## Health contract

`/api/health` and `get_provider_status` expose only aggregate ingestion state: collection mode, explicit status, expected cadence, last success, latest evidence, and per-provider counts. They never expose partition keys, symbols, leases, cursors, raw payloads, errors, operator IDs, or credentials.

Status precedence is:

1. `unavailable` when aggregate state cannot be read.
2. `degraded` when a partition has an unresolved failure.
3. `delayed` when a declared schedule is more than two cadences past its last success.
4. `catching_up` when a partition is due, resuming, or actively running.
5. `idle` when no checkpoint exists.
6. `healthy` otherwise.
