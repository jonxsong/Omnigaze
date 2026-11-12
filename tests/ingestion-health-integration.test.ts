import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAggregateStatus: vi.fn(),
}));

vi.mock("@/lib/ingestion/repository", () => ({
  ingestionRepository: {
    getAggregateStatus: mocks.getAggregateStatus,
  },
}));

import { getIngestionReadiness } from "@/lib/services/ingestion-health";

describe("multi-provider ingestion readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAggregateStatus.mockImplementation(
      async ({ provider, now, since }: { provider: string; now: string; since: string }) => ({
        generatedAt: now,
        since,
        providers:
          provider === "alpaca"
            ? [
                {
                  provider: "alpaca",
                  partitionCount: 1,
                  duePartitionCount: 0,
                  leasedPartitionCount: 0,
                  resumingPartitionCount: 0,
                  failingPartitionCount: 0,
                  totalSuccesses: 2,
                  totalFailures: 0,
                  lastAttemptAt: now,
                  lastSuccessAt: now,
                  lastFailureAt: null,
                  latestEvidenceAt: now,
                  runs: {
                    running: 0,
                    succeeded: 2,
                    failed: 0,
                    receipts: 10,
                    errors: 0,
                  },
                },
              ]
            : [],
      }),
    );
  });

  it("keeps a declared SEC schedule catching up until every expected lane initializes", async () => {
    const result = await getIngestionReadiness({
      SEC_DURABLE_INGESTION_ENABLED: "true",
      SEC_EDGAR_ENABLED: "true",
      SEC_USER_AGENT: "Omnigaze tests test@example.com",
      SEC_INGESTION_COLLECTION_MODE: "scheduled",
      SEC_INGESTION_SYMBOLS: "NASDAQ:NVDA,NASDAQ:MSFT",
    });

    expect(result).toMatchObject({
      mode: "scheduled",
      status: "catching_up",
      expectedCadenceSeconds: 300,
    });
    expect(result.providers).toEqual([
      expect.objectContaining({ provider: "alpaca", totalSuccesses: 2 }),
      expect.objectContaining({
        provider: "sec-edgar",
        partitionCount: 2,
        duePartitionCount: 2,
        totalSuccesses: 0,
      }),
    ]);
    expect(mocks.getAggregateStatus).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("partitionKey");
  });
});
