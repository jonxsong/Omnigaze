import { describe, expect, it, vi } from "vitest";
import type { ProjectionChange } from "@/lib/ingestion/contracts";
import {
  IntelligenceProjectionTickError,
  runIntelligenceProjectionTick,
  type IntelligenceProjectionDependencies,
} from "@/lib/services/intelligence-projection";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const NOW = new Date("2026-11-12T09:00:00.000Z");

function change(
  sequence: number,
  sourceEventId: string,
  headline = `NVIDIA update ${sourceEventId}`,
): ProjectionChange {
  return {
    sequence,
    changedAt: `2026-11-12T08:40:${String(sequence).padStart(2, "0")}.000Z`,
    event: {
      receiptId: `src-${sequence}`,
      provider: "alpaca",
      sourceKind: "licensed_news",
      sourceEventId,
      publishedAt: "2026-11-12T08:30:00.000Z",
      observedAt: `2026-11-12T08:30:${String(sequence).padStart(2, "0")}.000Z`,
      providerRevisionAt: `2026-11-12T08:30:${String(sequence).padStart(2, "0")}.000Z`,
      effectiveAt: `2026-11-12T08:30:${String(sequence).padStart(2, "0")}.000Z`,
      lastSeenAt: `2026-11-12T08:31:${String(sequence).padStart(2, "0")}.000Z`,
      symbolIds: ["NASDAQ:NVDA"],
      payloadPolicy: "minimal_redacted_v1",
      envelope: {
        schema: "omnigaze.provider-receipt.v1",
        headline,
        summary: "A minimal retained provider event.",
        url: `https://example.test/${sourceEventId}`,
        contentDigest: sequence.toString(16).padStart(64, "0"),
      },
    },
  };
}

function dependencies(overrides: Partial<IntelligenceProjectionDependencies> = {}) {
  const claimNext = vi.fn(async () => ({
    ownerId: "owner-from-cursor",
    token: "lease-token",
    lastSequence: 0,
  }));
  const complete = vi.fn(async () => undefined);
  const fail = vi.fn(async () => undefined);
  const syncLiveItems = vi.fn(async () => ({
    baselineApplied: false,
    hasMoreCandidates: false,
    newItemCount: 1,
    newDeliveryCount: 1,
  }));
  const result: IntelligenceProjectionDependencies = {
    cursors: { claimNext, complete, fail },
    inbox: { syncLiveItems } as never,
    listWatchlists: vi.fn(async () =>
      [
        {
          items: [{ symbolId: "NASDAQ:NVDA" }],
        },
      ] as never,
    ),
    listChanges: vi.fn(async () => ({ items: [], hasMore: false })),
    now: () => NOW,
    ...overrides,
  };
  return { result, claimNext, complete, fail, syncLiveItems };
}

describe("scheduled owner intelligence projection", () => {
  it("returns idle without reading owner state when no durable profile is due", async () => {
    const setup = dependencies({
      cursors: {
        claimNext: vi.fn(async () => null),
        complete: vi.fn(),
        fail: vi.fn(),
      },
    });

    await expect(runIntelligenceProjectionTick(setup.result)).resolves.toEqual({
      status: "idle",
      scannedChangeCount: 0,
      projectedItemCount: 0,
      newItemCount: 0,
      newDeliveryCount: 0,
      hasMore: false,
    });
    expect(setup.result.listWatchlists).not.toHaveBeenCalled();
    expect(setup.result.listChanges).not.toHaveBeenCalled();
  });

  it("never advances beyond the four-item inbox materialization bound", async () => {
    const changes = [1, 2, 3, 4, 5].map((sequence) =>
      change(sequence, `news-${sequence}`),
    );
    const setup = dependencies({
      listChanges: vi.fn(async () => ({ items: changes, hasMore: false })),
    });

    await expect(runIntelligenceProjectionTick(setup.result)).resolves.toEqual({
      status: "processed",
      scannedChangeCount: 4,
      projectedItemCount: 4,
      newItemCount: 1,
      newDeliveryCount: 1,
      hasMore: true,
    });
    expect(setup.syncLiveItems).toHaveBeenCalledWith(
      "owner-from-cursor",
      expect.arrayContaining([
        expect.objectContaining({ id: "alpaca:news-1" }),
        expect.objectContaining({ id: "alpaca:news-4" }),
      ]),
      NOW.toISOString(),
      { globalCursorDrained: false },
    );
    expect(setup.complete).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-from-cursor" }),
      NOW.toISOString(),
      4,
      true,
    );
  });

  it("collapses corrections to the newest stable event identity before advancing", async () => {
    const setup = dependencies({
      listChanges: vi.fn(async () => ({
        items: [
          change(1, "news-1", "Original NVIDIA report"),
          change(2, "news-1", "Corrected NVIDIA report"),
        ],
        hasMore: false,
      })),
    });

    await runIntelligenceProjectionTick(setup.result);
    const projected = (setup.syncLiveItems.mock.calls as unknown[][])[0]?.[1] as
      | Array<{ id: string; headline: string; providerUpdatedAt: string | null }>
      | undefined;
    expect(projected).toHaveLength(1);
    expect(projected?.[0]).toMatchObject({
      id: "alpaca:news-1",
      headline: "Corrected NVIDIA report",
      providerUpdatedAt: "2026-11-12T08:30:02.000Z",
      receivedAt: "2026-11-12T08:40:02.000Z",
    });
    expect(setup.complete).toHaveBeenCalledWith(
      expect.anything(),
      NOW.toISOString(),
      2,
      false,
    );
  });

  it("does not let a later-arriving older provider revision win the batch", async () => {
    const current = change(1, "news-1", "Current NVIDIA report");
    current.event.providerRevisionAt = "2026-11-12T08:45:00.000Z";
    current.event.effectiveAt = "2026-11-12T08:45:00.000Z";
    const lateOlder = change(2, "news-1", "Late older NVIDIA report");
    lateOlder.event.providerRevisionAt = "2026-11-12T08:15:00.000Z";
    lateOlder.event.effectiveAt = "2026-11-12T08:15:00.000Z";
    lateOlder.event.observedAt = "2026-11-12T08:50:00.000Z";
    const setup = dependencies({
      listChanges: vi.fn(async () => ({
        items: [current, lateOlder],
        hasMore: false,
      })),
    });

    await runIntelligenceProjectionTick(setup.result);
    const projected = (setup.syncLiveItems.mock.calls as unknown[][])[0]?.[1] as
      | Array<{ headline: string; providerUpdatedAt: string | null }>
      | undefined;
    expect(projected).toEqual([
      expect.objectContaining({
        headline: "Current NVIDIA report",
        providerUpdatedAt: "2026-11-12T08:45:00.000Z",
      }),
    ]);
    expect(setup.complete).toHaveBeenCalledWith(
      expect.anything(),
      NOW.toISOString(),
      2,
      false,
    );
  });

  it("fails closed without advancing when inbox materialization reports leftovers", async () => {
    const setup = dependencies({
      listChanges: vi.fn(async () => ({
        items: [change(1, "news-1")],
        hasMore: false,
      })),
      inbox: {
        syncLiveItems: vi.fn(async () => ({
          baselineApplied: false,
          hasMoreCandidates: true,
          newItemCount: 0,
          newDeliveryCount: 0,
        })),
      } as never,
    });

    await expect(
      runIntelligenceProjectionTick(setup.result),
    ).rejects.toBeInstanceOf(IntelligenceProjectionTickError);
    expect(setup.complete).not.toHaveBeenCalled();
    expect(setup.fail).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-from-cursor" }),
      NOW.toISOString(),
    );
  });

  it("syncs an empty drained page so the repository can close baseline", async () => {
    const syncLiveItems = vi.fn(async () => ({
      baselineApplied: false,
      hasMoreCandidates: false,
      newItemCount: 0,
      newDeliveryCount: 0,
    }));
    const setup = dependencies({
      inbox: { syncLiveItems } as never,
      listChanges: vi.fn(async () => ({ items: [], hasMore: false })),
    });

    await expect(runIntelligenceProjectionTick(setup.result)).resolves.toEqual({
      status: "processed",
      scannedChangeCount: 0,
      projectedItemCount: 0,
      newItemCount: 0,
      newDeliveryCount: 0,
      hasMore: false,
    });
    expect(syncLiveItems).toHaveBeenNthCalledWith(
      1,
      "owner-from-cursor",
      [],
      NOW.toISOString(),
      { globalCursorDrained: false },
    );
    expect(syncLiveItems).toHaveBeenNthCalledWith(
      2,
      "owner-from-cursor",
      [],
      NOW.toISOString(),
      { globalCursorDrained: true },
    );
    expect(setup.complete).toHaveBeenCalledWith(
      expect.anything(),
      NOW.toISOString(),
      0,
      false,
    );
    expect(setup.complete.mock.invocationCallOrder[0]).toBeLessThan(
      syncLiveItems.mock.invocationCallOrder[1]!,
    );
  });

  it("does not close baseline when the durable cursor completion loses its lease", async () => {
    const syncLiveItems = vi.fn(async () => ({
      baselineApplied: false,
      hasMoreCandidates: false,
      newItemCount: 0,
      newDeliveryCount: 0,
    }));
    const fail = vi.fn(async () => undefined);
    const setup = dependencies({
      inbox: { syncLiveItems } as never,
      cursors: {
        claimNext: vi.fn(async () => ({
          ownerId: "owner-from-cursor",
          token: "lost-lease",
          lastSequence: 0,
        })),
        complete: vi.fn(async () => {
          throw new Error("projection_lease_lost");
        }),
        fail,
      },
      listChanges: vi.fn(async () => ({ items: [], hasMore: false })),
    });

    await expect(
      runIntelligenceProjectionTick(setup.result),
    ).rejects.toBeInstanceOf(IntelligenceProjectionTickError);
    expect(syncLiveItems).toHaveBeenCalledTimes(1);
    expect(syncLiveItems).toHaveBeenCalledWith(
      "owner-from-cursor",
      [],
      NOW.toISOString(),
      { globalCursorDrained: false },
    );
    expect(fail).toHaveBeenCalledOnce();
  });
});
