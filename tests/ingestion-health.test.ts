import { describe, expect, it } from "vitest";
import type {
  IngestionAggregateStatus,
  IngestionProviderStatus,
} from "@/lib/ingestion/contracts";
import {
  summarizeIngestionReadiness,
  unavailableIngestionReadiness,
} from "@/lib/services/ingestion-health";

function provider(
  overrides: Partial<IngestionProviderStatus> = {},
): IngestionProviderStatus {
  return {
    provider: "alpaca",
    partitionCount: 1,
    duePartitionCount: 0,
    leasedPartitionCount: 0,
    resumingPartitionCount: 0,
    failingPartitionCount: 0,
    totalSuccesses: 2,
    totalFailures: 0,
    lastAttemptAt: "2026-11-12T07:59:00.000Z",
    lastSuccessAt: "2026-11-12T07:59:00.000Z",
    lastFailureAt: null,
    latestEvidenceAt: "2026-11-12T07:58:00.000Z",
    runs: {
      running: 0,
      succeeded: 2,
      failed: 0,
      receipts: 10,
      errors: 0,
    },
    ...overrides,
  };
}

function aggregate(
  providers: IngestionProviderStatus[],
): IngestionAggregateStatus {
  return {
    generatedAt: "2026-11-12T08:00:00.000Z",
    since: "2026-11-11T08:00:00.000Z",
    providers,
  };
}

describe("ingestion readiness summary", () => {
  it("reports a declared scheduled collector and evidence freshness explicitly", () => {
    expect(
      summarizeIngestionReadiness(aggregate([provider()]), {
        collectionMode: "scheduled",
        publiclyReportedCadenceSeconds: 300,
      }),
    ).toMatchObject({
      mode: "scheduled",
      status: "healthy",
      expectedCadenceSeconds: 300,
      lastSuccessAt: "2026-11-12T07:59:00.000Z",
      latestEvidenceAt: "2026-11-12T07:58:00.000Z",
    });
  });

  it("uses explicit operational precedence for failures, delay, and catch-up", () => {
    const config = {
      collectionMode: "scheduled" as const,
      publiclyReportedCadenceSeconds: 300,
    };
    expect(
      summarizeIngestionReadiness(
        aggregate([provider({ failingPartitionCount: 1, duePartitionCount: 1 })]),
        config,
      ).status,
    ).toBe("degraded");
    expect(
      summarizeIngestionReadiness(
        aggregate([
          provider({ lastSuccessAt: "2026-11-12T07:40:00.000Z" }),
        ]),
        config,
      ).status,
    ).toBe("delayed");
    expect(
      summarizeIngestionReadiness(
        aggregate([provider({ duePartitionCount: 1 })]),
        config,
      ).status,
    ).toBe("catching_up");
  });

  it("labels an uninitialized request-time collector idle without inventing cadence", () => {
    expect(
      summarizeIngestionReadiness(aggregate([]), {
        collectionMode: "request_time",
        publiclyReportedCadenceSeconds: null,
      }),
    ).toMatchObject({
      mode: "request_time",
      status: "idle",
      expectedCadenceSeconds: null,
      lastSuccessAt: null,
      latestEvidenceAt: null,
    });
  });

  it("returns a stable, detail-free unavailable contract", () => {
    expect(
      unavailableIngestionReadiness({
        now: "2026-11-12T08:00:00.000Z",
        since: "2026-11-11T08:00:00.000Z",
      }),
    ).toEqual({
      mode: "unavailable",
      status: "unavailable",
      expectedCadenceSeconds: null,
      lastSuccessAt: null,
      latestEvidenceAt: null,
      generatedAt: "2026-11-12T08:00:00.000Z",
      since: "2026-11-11T08:00:00.000Z",
      providers: [],
    });
  });
});
