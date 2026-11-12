import { describe, expect, it } from "vitest";
import type { InboxProjectionAggregateStatus } from "@/lib/intelligence-inbox/projection-repository";
import {
  readProjectionRuntimeConfig,
  summarizeProjectionReadiness,
  unavailableProjectionReadiness,
} from "@/lib/services/projection-health";

function aggregate(
  overrides: Partial<InboxProjectionAggregateStatus> = {},
): InboxProjectionAggregateStatus {
  return {
    generatedAt: "2026-11-12T08:00:00.000Z",
    ownerCount: 2,
    pendingOwnerCount: 0,
    leasedOwnerCount: 0,
    failingOwnerCount: 0,
    lastAttemptAt: "2026-11-12T07:59:00.000Z",
    lastCompletedAt: "2026-11-12T07:59:00.000Z",
    ...overrides,
  };
}

describe("owner projection readiness", () => {
  it("defaults to request-time without inventing a background cadence", () => {
    expect(readProjectionRuntimeConfig({})).toEqual({
      collectionMode: "request_time",
      publiclyReportedCadenceSeconds: null,
    });
    expect(
      summarizeProjectionReadiness(aggregate(), readProjectionRuntimeConfig({})),
    ).toMatchObject({
      mode: "request_time",
      status: "healthy",
      expectedCadenceSeconds: null,
      hasProfiles: true,
      hasPendingWork: false,
      hasActiveLease: false,
      hasFailures: false,
    });
  });

  it("requires an exact schedule declaration and bounds its cadence", () => {
    expect(
      readProjectionRuntimeConfig({
        INBOX_PROJECTION_COLLECTION_MODE: "SCHEDULED",
        INBOX_PROJECTION_EXPECTED_CADENCE_SECONDS: "10",
      }),
    ).toEqual({
      collectionMode: "request_time",
      publiclyReportedCadenceSeconds: null,
    });
    expect(
      readProjectionRuntimeConfig({
        INBOX_PROJECTION_COLLECTION_MODE: "scheduled",
        INBOX_PROJECTION_EXPECTED_CADENCE_SECONDS: "3600",
      }),
    ).toEqual({
      collectionMode: "scheduled",
      publiclyReportedCadenceSeconds: 3600,
    });
    expect(
      readProjectionRuntimeConfig({
        INBOX_PROJECTION_COLLECTION_MODE: "scheduled",
        INBOX_PROJECTION_EXPECTED_CADENCE_SECONDS: "10",
      }).publiclyReportedCadenceSeconds,
    ).toBe(300);
  });

  it("uses explicit failure, delay, and catch-up precedence", () => {
    const scheduled = {
      collectionMode: "scheduled" as const,
      publiclyReportedCadenceSeconds: 300,
    };
    expect(
      summarizeProjectionReadiness(
        aggregate({ failingOwnerCount: 1, pendingOwnerCount: 1 }),
        scheduled,
      ).status,
    ).toBe("degraded");
    expect(
      summarizeProjectionReadiness(
        aggregate({ lastCompletedAt: "2026-11-12T07:40:00.000Z" }),
        scheduled,
      ).status,
    ).toBe("delayed");
    expect(
      summarizeProjectionReadiness(
        aggregate({ pendingOwnerCount: 1 }),
        {
          collectionMode: "request_time",
          publiclyReportedCadenceSeconds: null,
        },
      ).status,
    ).toBe("catching_up");
    expect(
      summarizeProjectionReadiness(
        aggregate({ leasedOwnerCount: 1 }),
        {
          collectionMode: "request_time",
          publiclyReportedCadenceSeconds: null,
        },
      ).status,
    ).toBe("catching_up");
  });

  it("keeps an empty projection population idle even for a declared schedule", () => {
    expect(
      summarizeProjectionReadiness(
        aggregate({
          ownerCount: 0,
          lastAttemptAt: null,
          lastCompletedAt: null,
        }),
        {
          collectionMode: "scheduled",
          publiclyReportedCadenceSeconds: 300,
        },
      ),
    ).toMatchObject({ status: "idle", hasProfiles: false });
  });

  it("returns a stable detail-free unavailable contract", () => {
    const result = unavailableProjectionReadiness(
      "2026-11-12T08:00:00.000Z",
    );
    expect(result).toEqual({
      mode: "unavailable",
      status: "unavailable",
      expectedCadenceSeconds: null,
      generatedAt: "2026-11-12T08:00:00.000Z",
      hasProfiles: null,
      hasPendingWork: null,
      hasActiveLease: null,
      hasFailures: null,
      lastAttemptAt: null,
      lastCompletedAt: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ownerId|ownerCount|pendingOwnerCount|leasedOwnerCount|failingOwnerCount|symbol|claim|sequence/,
    );
  });
});
