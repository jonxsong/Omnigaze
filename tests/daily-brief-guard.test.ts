import { describe, expect, it, vi } from "vitest";
import {
  DailyBriefGenerationGuard,
  type DailyBriefGuardInput,
  type DailyBriefGuardRepository,
} from "@/lib/ai/daily-brief-guard";
import { OmnigazeAiGuardError } from "@/lib/ai/omnigaze-view-guard";

const NOW = new Date("2026-11-12T18:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function repository(overrides: Partial<DailyBriefGuardRepository> = {}) {
  return {
    findCachedDailyBrief: vi.fn().mockResolvedValue(null),
    putCachedDailyBrief: vi.fn().mockResolvedValue(undefined),
    reserveBudget: vi.fn().mockResolvedValue({
      granted: true,
      reservationId: "reservation-brief-1",
      remaining: 18,
      limit: 20,
      resetAt: "2026-11-13T00:00:00.000Z",
    }),
    completeBudget: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies DailyBriefGuardRepository;
}

const codec = {
  encode(value: { headline: string }) {
    if (!value || typeof value.headline !== "string" || !value.headline) {
      throw new Error("invalid payload");
    }
    return { headline: value.headline };
  },
  decode(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { headline?: unknown }).headline !== "string"
    ) {
      throw new Error("invalid payload");
    }
    return { headline: (value as { headline: string }).headline };
  },
};

function request(
  generate: DailyBriefGuardInput<{ headline: string }>["generate"] = async () => ({
    headline: "Fresh brief",
  }),
): DailyBriefGuardInput<{ headline: string }> {
  return {
    ownerId: "owner-brief-1",
    requestId: "request-brief-1",
    identity: {
      cacheKey: HASH_A,
      briefDate: "2026-11-12",
      promptVersion: "2026-11-12.1",
      modelConfig: "test-model",
      watchlistFingerprint: HASH_B,
      evidenceFingerprint: HASH_C,
    },
    freshness: {
      state: "fresh",
      asOf: "2026-11-12T17:59:00.000Z",
      maximumAgeSeconds: 86_400,
    },
    generate,
  };
}

describe("Daily Brief generation guard", () => {
  it("returns an owner-scoped cache hit without budget or model work", async () => {
    const repo = repository({
      findCachedDailyBrief: vi.fn().mockResolvedValue({
        ownerId: "owner-brief-1",
        cacheKey: HASH_A,
        payload: { headline: "Cached brief" },
        generatedAt: "2026-11-12T17:55:00.000Z",
        expiresAt: "2026-11-12T20:00:00.000Z",
      }),
    });
    const generate = vi.fn();
    const guard = new DailyBriefGenerationGuard(repo, codec, { now: () => NOW });

    const result = await guard.execute(request(generate));

    expect(result).toMatchObject({
      value: { headline: "Cached brief" },
      meta: {
        source: "cache",
        deduplicated: false,
        generatedAt: "2026-11-12T17:55:00.000Z",
        budget: { charged: false, remaining: null, limit: null, resetAt: null },
      },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(repo.reserveBudget).not.toHaveBeenCalled();
  });

  it("reserves the shared daily_brief budget, validates, caches, and completes", async () => {
    let tick = 0;
    const times = [
      NOW,
      NOW,
      new Date("2026-11-12T18:00:02.000Z"),
      new Date("2026-11-12T18:00:03.000Z"),
    ];
    const repo = repository();
    const guard = new DailyBriefGenerationGuard(repo, codec, {
      now: () => times[Math.min(tick++, times.length - 1)],
    });

    const result = await guard.execute(request());

    expect(repo.reserveBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-brief-1",
        operation: "daily_brief",
        operationKey: HASH_A,
        requestId: "request-brief-1",
        cost: 1,
      }),
    );
    expect(repo.putCachedDailyBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-brief-1",
        cacheKey: HASH_A,
        promptVersion: "2026-11-12.1",
        modelConfig: "test-model",
        watchlistFingerprint: HASH_B,
        evidenceFingerprint: HASH_C,
        payload: { headline: "Fresh brief" },
      }),
    );
    expect(repo.completeBudget).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "succeeded" }),
    );
    expect(result.meta).toMatchObject({
      source: "generated",
      deduplicated: false,
      budget: { charged: true, remaining: 18, limit: 20 },
    });
  });

  it("deduplicates concurrent generation without charging the waiter", async () => {
    let release: (value: { headline: string }) => void = () => undefined;
    const pending = new Promise<{ headline: string }>((resolve) => {
      release = resolve;
    });
    const repo = repository();
    const generate = vi.fn(() => pending);
    const guard = new DailyBriefGenerationGuard(repo, codec, { now: () => NOW });

    const first = guard.execute(request(generate));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const second = guard.execute({ ...request(generate), requestId: "request-brief-2" });
    release({ headline: "One generated brief" });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.meta).toMatchObject({
      deduplicated: false,
      budget: { charged: true },
    });
    expect(secondResult.meta).toMatchObject({
      deduplicated: true,
      budget: { charged: false, remaining: null },
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(repo.reserveBudget).toHaveBeenCalledOnce();
  });

  it("surfaces safe shared-budget retry metadata without model work", async () => {
    const repo = repository({
      reserveBudget: vi.fn().mockResolvedValue({
        granted: false,
        reason: "rolling_limit",
        remaining: 12,
        limit: 20,
        retryAt: "2026-11-12T18:00:45.000Z",
      }),
    });
    const generate = vi.fn();
    const guard = new DailyBriefGenerationGuard(repo, codec, { now: () => NOW });

    await expect(guard.execute(request(generate))).rejects.toMatchObject({
      name: "OmnigazeAiGuardError",
      code: "ai_rate_limited",
      retryAt: "2026-11-12T18:00:45.000Z",
      retryAfterSeconds: 45,
      budgetReason: "rolling_limit",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("marks model/validation failures as failed and never caches them", async () => {
    const repo = repository();
    const guard = new DailyBriefGenerationGuard(repo, codec, { now: () => NOW });

    await expect(
      guard.execute(request(async () => ({ headline: "" }))),
    ).rejects.toThrow("invalid payload");
    expect(repo.putCachedDailyBrief).not.toHaveBeenCalled();
    expect(repo.completeBudget).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("fails closed for stale state, malformed foreign cache, and invalid reset", async () => {
    const staleGuard = new DailyBriefGenerationGuard(repository(), codec, {
      now: () => NOW,
    });
    await expect(
      staleGuard.execute({
        ...request(),
        freshness: {
          state: "fresh",
          asOf: "2026-11-11T17:59:59.000Z",
          maximumAgeSeconds: 86_400,
        },
      }),
    ).rejects.toMatchObject({ code: "fresh_evidence_required" });

    const foreign = new DailyBriefGenerationGuard(
      repository({
        findCachedDailyBrief: vi.fn().mockResolvedValue({
          ownerId: "another-owner",
          cacheKey: HASH_A,
          payload: { headline: "Foreign brief" },
          generatedAt: NOW.toISOString(),
          expiresAt: "2026-11-12T19:00:00.000Z",
        }),
      }),
      codec,
      { now: () => NOW },
    );
    await expect(foreign.execute(request())).rejects.toMatchObject({
      code: "ai_guard_unavailable",
    });

    const invalidReset = new DailyBriefGenerationGuard(
      repository({
        reserveBudget: vi.fn().mockResolvedValue({
          granted: true,
          reservationId: "reservation-brief-2",
          remaining: 19,
          limit: 20,
          resetAt: NOW.toISOString(),
        }),
      }),
      codec,
      { now: () => NOW },
    );
    await expect(invalidReset.execute(request())).rejects.toMatchObject({
      code: "ai_guard_unavailable",
    });
  });

  it("maps repository failures to a stable unavailable error", async () => {
    const guard = new DailyBriefGenerationGuard(
      repository({
        findCachedDailyBrief: vi.fn().mockRejectedValue(new Error("D1 details")),
      }),
      codec,
      { now: () => NOW },
    );
    const error = await guard.execute(request()).catch((caught) => caught);
    expect(error).toBeInstanceOf(OmnigazeAiGuardError);
    expect(error).toMatchObject({ code: "ai_guard_unavailable" });
    expect(String(error)).not.toContain("D1 details");
  });
});
