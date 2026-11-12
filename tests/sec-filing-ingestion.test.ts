import { describe, expect, it, vi } from "vitest";
import type {
  EnsureCheckpointInput,
  IngestionLeaseIdentity,
  PersistPageInput,
  ProviderCheckpoint,
  ProviderCheckpointClaim,
} from "@/lib/ingestion/contracts";
import type { RawSourceEvent } from "@/lib/pipeline/contracts";
import type { PaginatedIntelligenceSourceProvider } from "@/lib/providers/contracts";
import type { SecFairAccessCoordinator } from "@/lib/providers/sec-fair-access";
import type { IngestionRepositoryPort } from "@/lib/services/bounded-provider-ingestion";
import {
  createSecFilingIngestionService,
  readSecFilingIngestionRuntimeConfig,
  runSecFilingIngestionTick,
  type SecFilingIngestionRuntimeConfig,
} from "@/lib/services/sec-filing-ingestion";

const lease: IngestionLeaseIdentity = {
  provider: "sec-edgar",
  partitionKey: "filings-recent:v1:test",
  token: "lease-token",
};

const config: SecFilingIngestionRuntimeConfig = {
  provider: "sec-edgar",
  enabled: true,
  partitions: [
    {
      partitionKey: lease.partitionKey,
      cik: "1045810",
      symbols: ["NASDAQ:NVDA"],
    },
  ],
  pageSize: 100,
  cadenceSeconds: 300,
  publiclyReportedCadenceSeconds: null,
  collectionMode: "request_time",
};

function repository() {
  let claim: ProviderCheckpointClaim | null = null;
  const value: IngestionRepositoryPort = {
    ensureCheckpoint: vi.fn(
      async (input: EnsureCheckpointInput): Promise<ProviderCheckpoint> => ({
        provider: input.provider,
        partitionKey: input.partitionKey,
        leaseExpiresAt: null,
        window: null,
        resumeCursor: null,
        highWaterMark: null,
        nextDueAt: input.nextDueAt,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        totalSuccesses: 0,
        totalFailures: 0,
      }),
    ),
    claimNextDue: vi.fn(async (input) => {
      claim = {
        provider: input.provider,
        partitionKey: input.partitionKey!,
        lease: {
          provider: input.provider,
          partitionKey: input.partitionKey!,
          token: "lease-token",
        },
        leaseExpiresAt: input.leaseExpiresAt,
        window: input.proposedWindow,
        resumeCursor: null,
        highWaterMark: null,
        nextDueAt: input.claimedAt,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        totalSuccesses: 0,
        totalFailures: 0,
      };
      return claim;
    }),
    startRun: vi.fn(async () => "run-id"),
    persistPage: vi.fn(async (input: PersistPageInput) => ({
      receiptCount: input.receipts.length,
      insertedReceiptCount: input.receipts.length,
      linkedSymbolCount: input.receipts.reduce(
        (count, receipt) => count + receipt.symbolIds.length,
        0,
      ),
      nextCursor: input.nextCursor,
      highWaterMark: null,
    })),
    completeRun: vi.fn(async () => undefined),
    failRun: vi.fn(async () => undefined),
    getAggregateStatus: vi.fn(async ({ now, since }) => ({
      generatedAt: now,
      since,
      providers: [],
    })),
  };
  return { value, getClaim: () => claim };
}

function filingEvent(overrides: Partial<RawSourceEvent> = {}): RawSourceEvent {
  return {
    source: "sec-edgar",
    sourceKind: "sec_filing",
    sourceEventId: "0001045810-26-000042",
    receivedAt: "2026-11-12T07:50:01.000Z",
    publishedAt: "2026-11-12T07:50:00.000Z",
    providerUpdatedAt: "2026-11-12T07:50:00.000Z",
    payload: {
      accessionNumber: "0001045810-26-000042",
      filingDate: "2026-11-12",
      acceptedAt: "2026-11-12T07:50:00.000Z",
      form: "8-K/A",
      primaryDocument: "report.htm",
      cik: "1045810",
      symbols: ["NASDAQ:NVDA"],
      headline: "8-K/A filed with the SEC",
      summary: "A new regulatory filing is available for evidence review.",
      url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000042/report.htm",
    },
    ...overrides,
  };
}

function provider(
  getEventPage: PaginatedIntelligenceSourceProvider["getEventPage"],
  health: "healthy" | "degraded" | "unconfigured" = "healthy",
): PaginatedIntelligenceSourceProvider {
  return {
    name: "sec-edgar",
    getEventPage,
    getLatestEvents: vi.fn(async () => []),
    getHealth: vi.fn(async () => ({
      provider: "sec-edgar",
      status: health,
      checkedAt: "2026-11-12T08:00:00.000Z",
      latestObservedAt: null,
    })),
  };
}

const coordinator = {
  acquire: vi.fn(async () => undefined),
  imposeCooldown: vi.fn(async () => undefined),
  getStatus: vi.fn(async () => ({
    status: "ready" as const,
    retryAfterSeconds: null,
  })),
} satisfies SecFairAccessCoordinator;

describe("durable SEC filing ingestion", () => {
  it("builds stable per-CIK partitions and reports a schedule only when declared", async () => {
    const requestTime = await readSecFilingIngestionRuntimeConfig({});
    expect(requestTime).toMatchObject({
      enabled: false,
      collectionMode: "request_time",
      publiclyReportedCadenceSeconds: null,
      pageSize: 100,
    });
    expect(requestTime.partitions).toHaveLength(5);
    expect(
      requestTime.partitions.every((partition) =>
        /^filings-recent:v1:[a-f0-9]{64}$/u.test(partition.partitionKey),
      ),
    ).toBe(true);

    const scheduled = await readSecFilingIngestionRuntimeConfig({
      SEC_DURABLE_INGESTION_ENABLED: "true",
      SEC_INGESTION_COLLECTION_MODE: "scheduled",
      SEC_INGESTION_EXPECTED_CADENCE_SECONDS: "600",
      SEC_INGESTION_SYMBOLS: "NASDAQ:NVDA,NASDAQ:MSFT",
    });
    expect(scheduled).toMatchObject({
      enabled: true,
      collectionMode: "scheduled",
      publiclyReportedCadenceSeconds: 600,
      cadenceSeconds: 600,
    });
    expect(
      scheduled.partitions
        .map((partition) => partition.symbols)
        .flat()
        .sort(),
    ).toEqual(["NASDAQ:MSFT", "NASDAQ:NVDA"]);
  });

  it("rejects unknown or duplicate durable symbols", async () => {
    await expect(
      readSecFilingIngestionRuntimeConfig({
        SEC_INGESTION_SYMBOLS: "NYSE:UNKNOWN",
      }),
    ).rejects.toThrow("invalid_sec_ingestion_symbols");
    await expect(
      readSecFilingIngestionRuntimeConfig({
        SEC_INGESTION_SYMBOLS: "NASDAQ:NVDA,NASDAQ:NVDA",
      }),
    ).rejects.toThrow("invalid_sec_ingestion_symbols");
  });

  it("persists a minimal SEC receipt before advancing the cursor", async () => {
    const store = repository();
    const getEventPage = vi.fn(async () => {
      const claim = store.getClaim();
      if (!claim) throw new Error("missing claim");
      return {
        events: [filingEvent()],
        nextCursor: null,
        exhausted: true,
        queryFingerprint: claim.window.fingerprint,
      };
    });
    const service = createSecFilingIngestionService({
      repository: store.value,
      provider: provider(getEventPage),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).resolves.toMatchObject({
      outcome: "processed",
      provider: "sec-edgar",
      receiptCount: 1,
      insertedReceiptCount: 1,
      linkedSymbolCount: 1,
    });
    const persisted = vi.mocked(store.value.persistPage).mock.calls[0][0];
    expect(persisted.receipts[0]).toMatchObject({
      sourceKind: "sec_filing",
      sourceEventId: "0001045810-26-000042",
      symbolIds: ["NASDAQ:NVDA"],
      providerRevisionAt: "2026-11-12T07:50:00.000Z",
      payloadPolicy: "minimal_redacted_v1",
    });
    expect(JSON.parse(persisted.receipts[0].rawPayload)).toMatchObject({
      schema: "omnigaze.provider-receipt.v1",
      headline: "8-K/A filed with the SEC",
      symbolIds: ["NASDAQ:NVDA"],
      url: expect.stringContaining("www.sec.gov/Archives/edgar/data/"),
    });
    expect(persisted.receipts[0].rawPayload).not.toContain("lease-token");
    expect(store.value.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        hasMore: false,
        nextDueAt: "2026-11-12T08:05:00.000Z",
      }),
    );
  });

  it("rejects a filing that does not belong to its CIK partition", async () => {
    const store = repository();
    const service = createSecFilingIngestionService({
      repository: store.value,
      provider: provider(async () => {
        const claim = store.getClaim();
        if (!claim) throw new Error("missing claim");
        return {
          events: [
            filingEvent({
              payload: {
                ...(filingEvent().payload as Record<string, unknown>),
                cik: "789019",
              },
            }),
          ],
          nextCursor: null,
          exhausted: true,
          queryFingerprint: claim.window.fingerprint,
        };
      }),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).rejects.toMatchObject({
      code: "provider_payload_invalid",
      stage: "page_validation",
      retryable: false,
    });
    expect(store.value.persistPage).not.toHaveBeenCalled();
    expect(store.value.failRun).toHaveBeenCalledOnce();
  });

  it("creates no checkpoint and performs no provider work when either activation gate is off", async () => {
    const store = repository();
    const getHealth = vi.fn();
    const dormantProvider = {
      ...provider(vi.fn()),
      getHealth,
    };
    await expect(
      runSecFilingIngestionTick(
        {
          SEC_EDGAR_ENABLED: "true",
          SEC_USER_AGENT: "Omnigaze tests test@example.com",
        },
        { provider: dormantProvider, repository: store.value, coordinator },
      ),
    ).rejects.toMatchObject({ code: "provider_unconfigured" });
    await expect(
      runSecFilingIngestionTick(
        {
          SEC_DURABLE_INGESTION_ENABLED: "true",
          SEC_USER_AGENT: "Omnigaze tests test@example.com",
        },
        { provider: dormantProvider, repository: store.value, coordinator },
      ),
    ).rejects.toMatchObject({ code: "provider_unconfigured" });
    expect(getHealth).not.toHaveBeenCalled();
    expect(store.value.ensureCheckpoint).not.toHaveBeenCalled();
  });

  it("preflights coordinator health before creating a checkpoint", async () => {
    const store = repository();
    const degraded = provider(vi.fn(), "degraded");
    await expect(
      runSecFilingIngestionTick(
        {
          SEC_DURABLE_INGESTION_ENABLED: "true",
          SEC_EDGAR_ENABLED: "true",
          SEC_USER_AGENT: "Omnigaze tests test@example.com",
        },
        { provider: degraded, repository: store.value, coordinator },
      ),
    ).rejects.toMatchObject({
      code: "sec_fair_access_unavailable",
      stage: "claim",
      retryable: true,
    });
    expect(store.value.ensureCheckpoint).not.toHaveBeenCalled();
  });
});
