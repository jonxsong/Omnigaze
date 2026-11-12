import { describe, expect, it, vi } from "vitest";
import type {
  CompleteRunInput,
  EnsureCheckpointInput,
  IngestionLeaseIdentity,
  PersistPageInput,
  ProviderCheckpoint,
  ProviderCheckpointClaim,
  RawSourceEventReceipt,
} from "@/lib/ingestion/contracts";
import type { RawSourceEvent } from "@/lib/pipeline/contracts";
import type { PaginatedIntelligenceSourceProvider } from "@/lib/providers/contracts";
import {
  createBoundedProviderIngestionService,
  type IngestionRepositoryPort,
} from "@/lib/services/bounded-provider-ingestion";

const now = "2026-11-12T08:00:00.000Z";
const windowStart = "2026-11-11T08:00:00.000Z";

function claimFor(partitionKey: string): ProviderCheckpointClaim {
  const lease: IngestionLeaseIdentity = {
    provider: "sec-edgar",
    partitionKey,
    token: `lease-${partitionKey}`,
  };
  return {
    provider: "sec-edgar",
    partitionKey,
    lease,
    leaseExpiresAt: "2026-11-12T08:00:30.000Z",
    window: {
      start: windowStart,
      end: now,
      fingerprint: `fingerprint-${partitionKey}`,
    },
    resumeCursor: null,
    highWaterMark: null,
    nextDueAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    totalSuccesses: 0,
    totalFailures: 0,
  };
}

function repository(
  claimNextDue: IngestionRepositoryPort["claimNextDue"],
) {
  return {
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
    claimNextDue: vi.fn(claimNextDue),
    startRun: vi.fn(async () => "run-id"),
    persistPage: vi.fn(async (input: PersistPageInput) => ({
      receiptCount: input.receipts.length,
      insertedReceiptCount: input.receipts.length,
      linkedSymbolCount: input.receipts.reduce(
        (total, receipt) => total + receipt.symbolIds.length,
        0,
      ),
      nextCursor: input.nextCursor,
      highWaterMark: null,
    })),
    completeRun: vi.fn(async (input: CompleteRunInput) => {
      void input;
    }),
    failRun: vi.fn(async () => undefined),
    getAggregateStatus: vi.fn(async ({ now: generatedAt, since }) => ({
      generatedAt,
      since,
      providers: [],
    })),
  } satisfies IngestionRepositoryPort;
}

function provider(
  getEventPage: PaginatedIntelligenceSourceProvider["getEventPage"],
): PaginatedIntelligenceSourceProvider {
  return {
    name: "sec-edgar",
    getEventPage,
    getLatestEvents: vi.fn(async () => []),
    getHealth: vi.fn(async () => ({
      provider: "sec-edgar",
      status: "healthy" as const,
      checkedAt: now,
      latestObservedAt: null,
    })),
  };
}

function filing(sourceKind: RawSourceEvent["sourceKind"] = "sec_filing") {
  return {
    source: "sec-edgar",
    sourceKind,
    sourceEventId: "0001045810-26-000001",
    receivedAt: now,
    publishedAt: "2026-11-11T18:30:00.000Z",
    providerUpdatedAt: "2026-11-11T18:30:00.000Z",
    payload: { form: "8-K" },
  } satisfies RawSourceEvent;
}

function receipt(event: RawSourceEvent): RawSourceEventReceipt {
  return {
    sourceKind: event.sourceKind,
    sourceEventId: event.sourceEventId,
    publishedAt: event.publishedAt,
    observedAt: event.receivedAt,
    payloadPolicy: "minimal_redacted_v1",
    rawPayloadHash: "0".repeat(64),
    rawPayload: "{}",
    status: "observed",
    symbolIds: ["NASDAQ:NVDA"],
    providerRevisionAt: event.providerUpdatedAt ?? null,
  };
}

function config() {
  return {
    provider: "sec-edgar",
    partitions: [
      { partitionKey: "filings:a", symbols: ["NASDAQ:AMD" as const] },
      { partitionKey: "filings:b", symbols: ["NASDAQ:NVDA" as const] },
    ],
    sourceKinds: ["sec_filing" as const],
    pageSize: 50,
    cadenceSeconds: 300,
    settlingDelayMs: 0,
    lookbackMs: 24 * 60 * 60 * 1_000,
  };
}

describe("generic bounded provider ingestion", () => {
  it("claims the first due partition and processes only one provider page", async () => {
    const store = repository(async (input) =>
      input.partitionKey === "filings:b" ? claimFor("filings:b") : null,
    );
    const getEventPage = vi.fn(async () => ({
      events: [filing()],
      nextCursor: null,
      exhausted: true,
      queryFingerprint: "fingerprint-filings:b",
    }));
    const createQueryFingerprint = vi.fn(async ({ partition }) =>
      `fingerprint-${partition.partitionKey}`,
    );
    const service = createBoundedProviderIngestionService({
      repository: store,
      provider: provider(getEventPage),
      config: config(),
      adapter: {
        createQueryFingerprint,
        createReceipt: async (event) => receipt(event),
      },
      now: () => new Date(now),
    });

    await expect(service.runTick()).resolves.toMatchObject({
      outcome: "processed",
      provider: "sec-edgar",
      hasMore: false,
      receiptCount: 1,
    });
    expect(store.ensureCheckpoint).toHaveBeenCalledTimes(2);
    expect(store.claimNextDue).toHaveBeenCalledTimes(2);
    expect(createQueryFingerprint).toHaveBeenCalledTimes(2);
    expect(getEventPage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        symbols: ["NASDAQ:NVDA"],
        windowStart,
        windowEnd: now,
        pageSize: 50,
      }),
    );
    expect(store.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        highWaterMark: now,
        nextDueAt: "2026-11-12T08:05:00.000Z",
      }),
    );
  });

  it("chooses the oldest due checkpoint across ticks instead of starving later partitions", async () => {
    let clock = Date.parse(now);
    const due = new Map<string, string>();
    const store = repository(async (input) => {
      const nextDueAt = due.get(input.partitionKey!);
      if (!nextDueAt || Date.parse(nextDueAt) > Date.parse(input.claimedAt)) {
        return null;
      }
      const candidate = claimFor(input.partitionKey!);
      return {
        ...candidate,
        leaseExpiresAt: input.leaseExpiresAt,
        window: input.proposedWindow,
        nextDueAt,
      };
    });
    vi.mocked(store.ensureCheckpoint).mockImplementation(async (input) => {
      const nextDueAt = due.get(input.partitionKey) ?? input.nextDueAt;
      due.set(input.partitionKey, nextDueAt);
      return {
        provider: input.provider,
        partitionKey: input.partitionKey,
        leaseExpiresAt: null,
        window: null,
        resumeCursor: null,
        highWaterMark: null,
        nextDueAt,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        totalSuccesses: 0,
        totalFailures: 0,
      };
    });
    vi.mocked(store.completeRun).mockImplementation(async (input) => {
      due.set(input.lease.partitionKey, input.nextDueAt);
    });
    const requestedSymbols: string[] = [];
    const service = createBoundedProviderIngestionService({
      repository: store,
      provider: provider(async (input) => {
        requestedSymbols.push(input.symbols[0]);
        const partitionKey =
          input.symbols[0] === "NASDAQ:AMD" ? "filings:a" : "filings:b";
        return {
          events: [],
          nextCursor: null,
          exhausted: true,
          queryFingerprint: `fingerprint-${partitionKey}`,
        };
      }),
      config: config(),
      adapter: {
        createQueryFingerprint: async ({ partition }) =>
          `fingerprint-${partition.partitionKey}`,
        createReceipt: async (event) => receipt(event),
      },
      now: () => new Date(clock),
    });

    await service.runTick();
    clock += 5 * 60 * 1_000;
    await service.runTick();

    expect(requestedSymbols).toEqual(["NASDAQ:AMD", "NASDAQ:NVDA"]);
    expect(due.get("filings:a")).toBe("2026-11-12T08:05:00.000Z");
    expect(due.get("filings:b")).toBe("2026-11-12T08:10:00.000Z");
  });

  it("finishes a frozen continuation before an older non-resuming peer", async () => {
    const store = repository(async (input) => ({
      ...claimFor(input.partitionKey!),
      leaseExpiresAt: input.leaseExpiresAt,
      window: input.proposedWindow,
      resumeCursor:
        input.partitionKey === "filings:b" ? "continuation-token" : null,
    }));
    vi.mocked(store.ensureCheckpoint).mockImplementation(async (input) => ({
      provider: input.provider,
      partitionKey: input.partitionKey,
      leaseExpiresAt: null,
      window:
        input.partitionKey === "filings:b"
          ? {
              start: windowStart,
              end: now,
              fingerprint: "fingerprint-filings:b",
            }
          : null,
      resumeCursor:
        input.partitionKey === "filings:b" ? "continuation-token" : null,
      highWaterMark: null,
      nextDueAt:
        input.partitionKey === "filings:a"
          ? "2026-11-12T07:00:00.000Z"
          : "2026-11-12T07:30:00.000Z",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    }));
    const getEventPage = vi.fn(async () => ({
      events: [],
      nextCursor: null,
      exhausted: true,
      queryFingerprint: "fingerprint-filings:b",
    }));
    const service = createBoundedProviderIngestionService({
      repository: store,
      provider: provider(getEventPage),
      config: config(),
      adapter: {
        createQueryFingerprint: async ({ partition }) =>
          `fingerprint-${partition.partitionKey}`,
        createReceipt: async (event) => receipt(event),
      },
      now: () => new Date(now),
    });

    await service.runTick();

    expect(store.claimNextDue).toHaveBeenCalledTimes(1);
    expect(store.claimNextDue).toHaveBeenCalledWith(
      expect.objectContaining({ partitionKey: "filings:b" }),
    );
    expect(getEventPage).toHaveBeenCalledWith(
      expect.objectContaining({
        symbols: ["NASDAQ:NVDA"],
        cursor: {
          token: "continuation-token",
          queryFingerprint: "fingerprint-filings:b",
        },
      }),
    );
  });

  it("rejects an unconfigured source kind before persistence", async () => {
    const store = repository(async () => claimFor("filings:a"));
    const service = createBoundedProviderIngestionService({
      repository: store,
      provider: provider(
        vi.fn(async () => ({
          events: [filing("licensed_news")],
          nextCursor: null,
          exhausted: true,
          queryFingerprint: "fingerprint-filings:a",
        })),
      ),
      config: config(),
      adapter: {
        createQueryFingerprint: async ({ partition }) =>
          `fingerprint-${partition.partitionKey}`,
        createReceipt: async (event) => receipt(event),
      },
      now: () => new Date(now),
    });

    await expect(service.runTick()).rejects.toMatchObject({
      code: "provider_page_contract_invalid",
      stage: "page_validation",
      retryable: false,
    });
    expect(store.persistPage).not.toHaveBeenCalled();
    expect(store.failRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "provider_page_contract_invalid",
        }),
      }),
    );
  });

  it("rejects duplicate partitions before touching repository state", () => {
    const store = repository(async () => null);
    expect(() =>
      createBoundedProviderIngestionService({
        repository: store,
        provider: provider(vi.fn()),
        config: {
          ...config(),
          partitions: [
            { partitionKey: "duplicate", symbols: ["NASDAQ:NVDA"] },
            { partitionKey: "duplicate", symbols: ["NASDAQ:AMD"] },
          ],
        },
        adapter: {
          createQueryFingerprint: async () => "fingerprint",
          createReceipt: async (event) => receipt(event),
        },
      }),
    ).toThrow("invalid_bounded_ingestion_config");
    expect(store.ensureCheckpoint).not.toHaveBeenCalled();
  });
});
