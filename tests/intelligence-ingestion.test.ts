import { describe, expect, it, vi } from "vitest";
import type {
  IngestionLeaseIdentity,
  ProviderCheckpointClaim,
} from "@/lib/ingestion/contracts";
import type { RawSourceEvent } from "@/lib/pipeline/contracts";
import type { PaginatedIntelligenceSourceProvider } from "@/lib/providers/contracts";
import {
  createIntelligenceIngestionService,
  readIngestionRuntimeConfig,
  type IngestionRepositoryPort,
  type IngestionRuntimeConfig,
} from "@/lib/services/intelligence-ingestion";

const lease: IngestionLeaseIdentity = {
  provider: "alpaca",
  partitionKey: "news:v1:test",
  token: "lease-token",
};

const claim: ProviderCheckpointClaim = {
  provider: "alpaca",
  partitionKey: lease.partitionKey,
  lease,
  leaseExpiresAt: "2026-11-12T08:00:30.000Z",
  window: {
    start: "2026-11-11T07:59:30.000Z",
    end: "2026-11-12T07:59:30.000Z",
    fingerprint: "frozen-fingerprint",
  },
  resumeCursor: null,
  highWaterMark: null,
  nextDueAt: "2026-11-12T08:00:00.000Z",
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  consecutiveFailures: 0,
  totalSuccesses: 0,
  totalFailures: 0,
};

const config: IngestionRuntimeConfig = {
  provider: "alpaca",
  partitionKey: lease.partitionKey,
  symbols: ["NASDAQ:NVDA"],
  pageSize: 50,
  cadenceSeconds: 300,
  publiclyReportedCadenceSeconds: null,
  collectionMode: "request_time",
};

function repository(overrides: Partial<IngestionRepositoryPort> = {}) {
  const calls: string[] = [];
  const value: IngestionRepositoryPort = {
    ensureCheckpoint: vi.fn(async () => {
      calls.push("ensure");
    }),
    claimNextDue: vi.fn(async () => {
      calls.push("claim");
      return claim;
    }),
    startRun: vi.fn(async () => {
      calls.push("start");
      return "run-id";
    }),
    persistPage: vi.fn(async (input) => {
      calls.push("persist");
      return {
        receiptCount: input.receipts.length,
        insertedReceiptCount: input.receipts.length,
        linkedSymbolCount: input.receipts.length,
        nextCursor: input.nextCursor,
        highWaterMark: input.highWaterMark,
      };
    }),
    completeRun: vi.fn(async () => {
      calls.push("complete");
    }),
    failRun: vi.fn(async () => {
      calls.push("fail");
    }),
    getAggregateStatus: vi.fn(async ({ now, since }) => ({
      generatedAt: now,
      since,
      providers: [],
    })),
    ...overrides,
  };
  return { value, calls };
}

function provider(
  getEventPage: PaginatedIntelligenceSourceProvider["getEventPage"],
): PaginatedIntelligenceSourceProvider {
  return {
    name: "alpaca",
    getEventPage,
    getLatestEvents: vi.fn(async () => []),
    getHealth: vi.fn(async () => ({
      provider: "alpaca",
      status: "healthy" as const,
      checkedAt: "2026-11-12T08:00:00.000Z",
      latestObservedAt: null,
    })),
  };
}

function event(overrides: Partial<RawSourceEvent> = {}): RawSourceEvent {
  return {
    source: "alpaca",
    sourceKind: "licensed_news",
    sourceEventId: "42",
    receivedAt: "2026-11-12T08:00:01.000Z",
    publishedAt: "2026-11-12T07:45:00.000Z",
    providerUpdatedAt: "2026-11-12T07:50:00.000Z",
    payload: {
      id: 42,
      headline: "NVIDIA update",
      symbols: ["NVDA"],
    },
    ...overrides,
  };
}

describe("bounded intelligence ingestion", () => {
  it("persists one page before advancing and completing its lease", async () => {
    const store = repository();
    const getEventPage = vi.fn(async () => ({
      events: [event()],
      nextCursor: null,
      exhausted: true,
      queryFingerprint: claim.window.fingerprint,
    }));
    const service = createIntelligenceIngestionService({
      repository: store.value,
      provider: provider(getEventPage),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).resolves.toMatchObject({
      outcome: "processed",
      provider: "alpaca",
      runId: "run-id",
      hasMore: false,
      receiptCount: 1,
      insertedReceiptCount: 1,
      linkedSymbolCount: 1,
    });

    expect(store.calls).toEqual([
      "ensure",
      "claim",
      "start",
      "persist",
      "complete",
    ]);
    expect(store.value.claimNextDue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "alpaca",
        partitionKey: lease.partitionKey,
        proposedWindow: expect.objectContaining({
          start: "2026-11-11T07:59:30.000Z",
          end: "2026-11-12T07:59:30.000Z",
        }),
      }),
    );
    expect(getEventPage).toHaveBeenCalledWith(
      expect.objectContaining({
        windowStart: claim.window.start,
        windowEnd: claim.window.end,
        cursor: null,
        pageSize: 50,
        signal: expect.any(AbortSignal),
      }),
    );
    const persisted = vi.mocked(store.value.persistPage).mock.calls[0][0];
    expect(persisted.lease).toBe(claim.lease);
    expect(persisted.receipts[0]).toMatchObject({
      sourceKind: "licensed_news",
      sourceEventId: "42",
      payloadPolicy: "minimal_redacted_v1",
      symbolIds: ["NASDAQ:NVDA"],
      providerRevisionAt: "2026-11-12T07:50:00.000Z",
    });
    expect(persisted.receipts[0].rawPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.receipts[0].rawPayload).not.toContain("lease-token");
    expect(JSON.parse(persisted.receipts[0].rawPayload)).toMatchObject({
      schema: "omnigaze.provider-receipt.v1",
      sourceEventId: "42",
      headline: "NVIDIA update",
      symbolIds: ["NASDAQ:NVDA"],
    });
    expect(store.value.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        hasMore: false,
        highWaterMark: claim.window.end,
        nextDueAt: "2026-11-12T08:05:00.000Z",
      }),
    );
  });

  it("resumes only the frozen query and leaves the next page immediately due", async () => {
    const resumedClaim = {
      ...claim,
      resumeCursor: "provider-page-2",
      highWaterMark: "2026-11-12T07:45:00.000Z",
    };
    const store = repository({
      claimNextDue: vi.fn(async () => resumedClaim),
    });
    const getEventPage = vi.fn(async () => ({
      events: [],
      nextCursor: {
        token: "provider-page-3",
        queryFingerprint: claim.window.fingerprint,
      },
      exhausted: false,
      queryFingerprint: claim.window.fingerprint,
    }));
    const service = createIntelligenceIngestionService({
      repository: store.value,
      provider: provider(getEventPage),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).resolves.toMatchObject({
      outcome: "processed",
      hasMore: true,
    });
    expect(getEventPage).toHaveBeenCalledWith(
      expect.objectContaining({
        windowStart: claim.window.start,
        windowEnd: claim.window.end,
        cursor: {
          token: "provider-page-2",
          queryFingerprint: claim.window.fingerprint,
        },
      }),
    );
    expect(store.value.persistPage).toHaveBeenCalledWith(
      expect.objectContaining({ nextCursor: "provider-page-3" }),
    );
    expect(store.value.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        hasMore: true,
        nextDueAt: "2026-11-12T08:00:00.000Z",
      }),
    );
  });

  it("returns idle without starting a run or calling the provider", async () => {
    const store = repository({
      claimNextDue: vi.fn(async () => null),
    });
    const getEventPage = vi.fn();
    const service = createIntelligenceIngestionService({
      repository: store.value,
      provider: provider(getEventPage),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).resolves.toEqual({
      outcome: "idle",
      provider: "alpaca",
      checkedAt: "2026-11-12T08:00:00.000Z",
    });
    expect(getEventPage).not.toHaveBeenCalled();
    expect(store.value.startRun).not.toHaveBeenCalled();
  });

  it("records only a bounded safe failure and never persists a bad page", async () => {
    const failRun = vi.fn(async () => undefined);
    const store = repository({ failRun });
    const service = createIntelligenceIngestionService({
      repository: store.value,
      provider: provider(
        vi.fn(async () => {
          throw new Error("upstream leaked-key-value");
        }),
      ),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).rejects.toMatchObject({
      code: "provider_request_failed",
      stage: "provider_fetch",
      retryable: true,
    });
    expect(store.value.persistPage).not.toHaveBeenCalled();
    expect(store.value.completeRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          code: "provider_request_failed",
          stage: "provider_fetch",
          message: "The ingestion tick failed without exposing upstream details.",
          retryable: true,
        },
        nextDueAt: "2026-11-12T08:01:00.000Z",
      }),
    );
    expect(JSON.stringify(failRun.mock.calls)).not.toContain("leaked-key-value");
  });

  it("fails closed when a provider returns an event outside the frozen window", async () => {
    const store = repository();
    const service = createIntelligenceIngestionService({
      repository: store.value,
      provider: provider(
        vi.fn(async () => ({
          events: [
            event({
              publishedAt: "2026-11-12T08:00:00.000Z",
              providerUpdatedAt: "2026-11-12T08:00:00.000Z",
            }),
          ],
          nextCursor: null,
          exhausted: true,
          queryFingerprint: claim.window.fingerprint,
        })),
      ),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).rejects.toMatchObject({
      code: "provider_page_contract_invalid",
      stage: "page_validation",
      retryable: false,
    });
    expect(store.value.persistPage).not.toHaveBeenCalled();
    expect(store.value.failRun).toHaveBeenCalledOnce();
  });

  it("accepts a correction to an old article when its provider revision is in-window", async () => {
    const store = repository();
    const service = createIntelligenceIngestionService({
      repository: store.value,
      provider: provider(
        vi.fn(async () => ({
          events: [
            event({
              publishedAt: "2026-10-01T08:00:00.000Z",
              providerUpdatedAt: "2026-11-12T07:50:00.000Z",
            }),
          ],
          nextCursor: null,
          exhausted: true,
          queryFingerprint: claim.window.fingerprint,
        })),
      ),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).resolves.toMatchObject({
      outcome: "processed",
      receiptCount: 1,
    });
    expect(store.value.persistPage).toHaveBeenCalledOnce();
  });

  it("rejects a repeated continuation token so the repository can reset traversal", async () => {
    const resumedClaim = { ...claim, resumeCursor: "stuck-token" };
    const store = repository({ claimNextDue: vi.fn(async () => resumedClaim) });
    const service = createIntelligenceIngestionService({
      repository: store.value,
      provider: provider(
        vi.fn(async () => ({
          events: [],
          nextCursor: {
            token: "stuck-token",
            queryFingerprint: claim.window.fingerprint,
          },
          exhausted: false,
          queryFingerprint: claim.window.fingerprint,
        })),
      ),
      config,
      now: () => new Date("2026-11-12T08:00:00.000Z"),
    });

    await expect(service.runTick()).rejects.toMatchObject({
      code: "invalid_cursor",
      stage: "page_validation",
      retryable: false,
    });
    expect(store.value.persistPage).not.toHaveBeenCalled();
    expect(store.value.failRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "invalid_cursor" }),
      }),
    );
  });

  it("reports scheduled cadence only when deployment configuration asserts it", async () => {
    const requestTime = await readIngestionRuntimeConfig({});
    expect(requestTime).toMatchObject({
      collectionMode: "request_time",
      publiclyReportedCadenceSeconds: null,
      cadenceSeconds: 300,
    });
    const scheduled = await readIngestionRuntimeConfig({
      INGESTION_COLLECTION_MODE: "scheduled",
      INGESTION_EXPECTED_CADENCE_SECONDS: "600",
      ALPACA_INGESTION_SYMBOLS: "NASDAQ:NVDA,NASDAQ:MSFT",
    });
    expect(scheduled).toMatchObject({
      collectionMode: "scheduled",
      publiclyReportedCadenceSeconds: 600,
      symbols: ["NASDAQ:MSFT", "NASDAQ:NVDA"],
    });
    expect(scheduled.partitionKey).toMatch(/^news:v1:[a-f0-9]{64}$/);
  });
});
