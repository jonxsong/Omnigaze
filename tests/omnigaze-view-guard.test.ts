import { describe, expect, it, vi } from "vitest";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  computeOmnigazeEvidenceFingerprint,
  OmnigazeAiGuard,
  OmnigazeAiGuardError,
  omnigazeAiGuardErrorHeaders,
  omnigazeAiGuardResultHeaders,
  OMNIGAZE_DEFAULT_MODEL_CONFIG,
  resolveOmnigazeModelConfig,
  type AiViewCacheRecord,
  type GuardedOmnigazeViewInput,
  type OmnigazeAiCacheCodec,
  type OmnigazeAiGuardRepository,
} from "@/lib/ai/omnigaze-view-guard";

const NOW = Date.parse("2026-11-12T18:00:00.000Z");
const SYMBOL = "NYSE:IBM" as CanonicalSymbol;

type View = { headline: string; confidence: number };

const codec: OmnigazeAiCacheCodec<View> = {
  encode: (value) => value,
  decode: (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { headline?: unknown }).headline !== "string" ||
      typeof (value as { confidence?: unknown }).confidence !== "number"
    ) {
      throw new Error("invalid cached view");
    }
    return value as View;
  },
};

function repository(
  overrides: Partial<OmnigazeAiGuardRepository> = {},
): OmnigazeAiGuardRepository {
  return {
    findCachedView: vi.fn().mockResolvedValue(null),
    putCachedView: vi.fn().mockResolvedValue(undefined),
    reserveBudget: vi.fn().mockResolvedValue({
      granted: true,
      reservationId: "reservation-1",
      remaining: 9,
      limit: 10,
      resetAt: "2026-11-13T00:00:00.000Z",
    }),
    completeBudget: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function request(
  generate: () => Promise<View> = vi
    .fn()
    .mockResolvedValue({ headline: "Evidence is mixed", confidence: 0.58 }),
  overrides: Partial<GuardedOmnigazeViewInput<View>> = {},
): GuardedOmnigazeViewInput<View> {
  return {
    ownerId: "account-user-1",
    symbolId: SYMBOL,
    promptVersion: "2026-11-12.1",
    modelConfig: "openai/gpt-5-mini",
    requestId: "request-1",
    freshness: {
      state: "fresh",
      asOf: "2026-11-12T17:59:00.000Z",
      maximumAgeSeconds: 600,
    },
    fingerprint: {
      dataCutoff: "2026-11-12T18:00:00.000Z",
      evidence: [
        {
          id: "evidence:alpaca:news-1",
          revisionAt: "2026-11-12T17:59:00.000Z",
          contentHash: "a".repeat(64),
        },
      ],
    },
    generate,
    ...overrides,
  };
}

function guard(
  repo: OmnigazeAiGuardRepository,
  options: ConstructorParameters<typeof OmnigazeAiGuard<View>>[2] = {},
) {
  return new OmnigazeAiGuard(repo, codec, {
    now: () => new Date(NOW),
    createRequestId: () => "generated-request-id",
    ...options,
  });
}

async function fingerprint() {
  return computeOmnigazeEvidenceFingerprint(request().fingerprint);
}

function cachedRecord(
  evidenceFingerprint: string,
  overrides: Partial<AiViewCacheRecord> = {},
): AiViewCacheRecord {
  return {
    symbolId: SYMBOL,
    promptVersion: "2026-11-12.1",
    modelConfig: "openai/gpt-5-mini",
    evidenceFingerprint,
    payload: { headline: "Cached evidence view", confidence: 0.61 },
    generatedAt: "2026-11-12T17:58:00.000Z",
    expiresAt: "2026-11-12T18:04:00.000Z",
    ...overrides,
  };
}

describe("Omnigaze AI evidence fingerprint", () => {
  it("uses an explicit model or a stable default cache identity", () => {
    expect(resolveOmnigazeModelConfig(" gpt-5-mini ")).toBe("gpt-5-mini");
    expect(resolveOmnigazeModelConfig()).toBe(OMNIGAZE_DEFAULT_MODEL_CONFIG);
    expect(() => resolveOmnigazeModelConfig("model with spaces")).toThrow(
      expect.objectContaining({ code: "invalid_guard_request" }),
    );
  });

  it("is a bare SHA-256 digest independent of evidence order and request time", async () => {
    const evidence = [
      {
        id: "evidence:alpaca:news-2",
        revisionAt: "2026-11-12T17:58:00.000Z",
        contentHash: "b".repeat(64),
      },
      {
        id: "evidence:alpaca:news-1",
        revisionAt: "2026-11-12T17:59:00.000Z",
        contentHash: "a".repeat(64),
      },
    ];

    const first = await computeOmnigazeEvidenceFingerprint({
      dataCutoff: "2026-11-12T18:00:00.000Z",
      evidence,
    });
    const second = await computeOmnigazeEvidenceFingerprint({
      dataCutoff: "2026-11-12T18:00:30.000Z",
      evidence: [...evidence].reverse(),
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("changes when a stable revision or content digest changes", async () => {
    const baseline = request().fingerprint;
    const first = await computeOmnigazeEvidenceFingerprint(baseline);
    const revised = await computeOmnigazeEvidenceFingerprint({
      ...baseline,
      evidence: baseline.evidence.map((item) => ({
        ...item,
        revisionAt: "2026-11-12T18:00:01.000Z",
      })),
    });
    const rehashed = await computeOmnigazeEvidenceFingerprint({
      ...baseline,
      evidence: baseline.evidence.map((item) => ({
        ...item,
        contentHash: "c".repeat(64),
      })),
    });

    expect(revised).not.toBe(first);
    expect(rehashed).not.toBe(first);
  });

  it("rejects non-SHA-256 content digests and duplicate evidence IDs", async () => {
    await expect(
      computeOmnigazeEvidenceFingerprint({
        evidence: [
          {
            id: "evidence:1",
            revisionAt: "2026-11-12T17:59:00.000Z",
            contentHash: "not-a-digest",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_guard_request" });
    await expect(
      computeOmnigazeEvidenceFingerprint({
        evidence: [
          {
            id: "evidence:1",
            revisionAt: "2026-11-12T17:59:00.000Z",
          },
          {
            id: "evidence:1",
            revisionAt: "2026-11-12T18:00:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_guard_request" });
  });
});

describe("OmnigazeAiGuard", () => {
  it("returns an exact cache hit without reserving budget or running the model", async () => {
    const evidenceFingerprint = await fingerprint();
    const repo = repository({
      findCachedView: vi
        .fn()
        .mockResolvedValue(cachedRecord(evidenceFingerprint)),
    });
    const generate = vi.fn();

    const result = await guard(repo).execute(request(generate));

    expect(result).toMatchObject({
      value: { headline: "Cached evidence view" },
      meta: {
        source: "cache",
        deduplicated: false,
        modelConfig: "openai/gpt-5-mini",
        evidenceFingerprint,
        budget: { charged: false },
      },
    });
    expect(repo.findCachedView).toHaveBeenCalledWith({
      symbolId: SYMBOL,
      promptVersion: "2026-11-12.1",
      modelConfig: "openai/gpt-5-mini",
      evidenceFingerprint,
    });
    expect(repo.reserveBudget).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify(result.meta)).not.toContain("account-user-1");
    expect(omnigazeAiGuardResultHeaders(result)).toEqual({
      "X-Omnigaze-AI-Cache": "hit",
      "X-Omnigaze-AI-Deduplicated": "false",
      "X-Omnigaze-AI-Budget-Charged": "false",
    });
  });

  it("does not reuse a view generated by a different effective model", async () => {
    const evidenceFingerprint = await fingerprint();
    const repo = repository({
      findCachedView: vi
        .fn()
        .mockResolvedValue(
          cachedRecord(evidenceFingerprint, { modelConfig: "gpt-4.1-mini" }),
        ),
    });
    const generate = vi
      .fn()
      .mockResolvedValue({ headline: "New model view", confidence: 0.64 });

    const result = await guard(repo).execute(request(generate));

    expect(result.meta.source).toBe("generated");
    expect(generate).toHaveBeenCalledOnce();
    expect(repo.reserveBudget).toHaveBeenCalledOnce();
  });

  it("uses the same cache entry across volatile feed timestamps", async () => {
    let stored: AiViewCacheRecord | null = null;
    const repo = repository({
      findCachedView: vi.fn(async (lookup) =>
        stored &&
        stored.symbolId === lookup.symbolId &&
        stored.promptVersion === lookup.promptVersion &&
        stored.modelConfig === lookup.modelConfig &&
        stored.evidenceFingerprint === lookup.evidenceFingerprint
          ? stored
          : null,
      ),
      putCachedView: vi.fn(async (record) => {
        stored = record;
      }),
    });
    const generate = vi
      .fn()
      .mockResolvedValue({ headline: "One model call", confidence: 0.55 });
    const service = guard(repo);

    const first = await service.execute(request(generate));
    const second = await service.execute(
      request(generate, {
        requestId: "request-2",
        fingerprint: {
          ...request().fingerprint,
          dataCutoff: "2026-11-12T18:00:45.000Z",
        },
      }),
    );

    expect(first.meta.source).toBe("generated");
    expect(second.meta.source).toBe("cache");
    expect(first.meta.evidenceFingerprint).toBe(second.meta.evidenceFingerprint);
    expect(generate).toHaveBeenCalledOnce();
    expect(repo.reserveBudget).toHaveBeenCalledOnce();
  });

  it("caps cache lifetime to evidence freshness instead of keying on freshness", async () => {
    const repo = repository();
    const generate = vi
      .fn()
      .mockResolvedValue({ headline: "Fresh view", confidence: 0.62 });

    const result = await guard(repo, { cacheTtlSeconds: 300 }).execute(
      request(generate, {
        freshness: {
          state: "fresh",
          asOf: "2026-11-12T17:59:50.000Z",
          maximumAgeSeconds: 40,
        },
      }),
    );

    expect(result.meta.cacheExpiresAt).toBe("2026-11-12T18:00:30.000Z");
    expect(repo.putCachedView).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: "2026-11-12T18:00:30.000Z",
      }),
    );
    const persisted = vi.mocked(repo.putCachedView).mock.calls[0][0];
    expect(persisted).not.toHaveProperty("freshnessAsOf");
    expect(persisted).not.toHaveProperty("freshnessExpiresAt");
    expect(omnigazeAiGuardResultHeaders(result)).toEqual({
      "X-Omnigaze-AI-Cache": "miss",
      "X-Omnigaze-AI-Deduplicated": "false",
      "X-Omnigaze-AI-Budget-Charged": "true",
      "X-Omnigaze-AI-Budget-Remaining": "9",
      "X-Omnigaze-AI-Budget-Limit": "10",
      "X-Omnigaze-AI-Budget-Reset": "2026-11-13T00:00:00.000Z",
    });
  });

  it("deduplicates concurrent cache misses before budget and model work", async () => {
    let release: (value: View) => void = () => undefined;
    const pending = new Promise<View>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn().mockReturnValue(pending);
    const repo = repository();
    const service = guard(repo);

    const first = service.execute(request(generate, { requestId: "request-a" }));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const second = service.execute(
      request(generate, {
        requestId: "request-b",
        freshness: {
          state: "fresh",
          asOf: "2026-11-12T17:59:50.000Z",
          maximumAgeSeconds: 40,
        },
      }),
    );
    await vi.waitFor(() => expect(repo.findCachedView).toHaveBeenCalledTimes(2));
    release({ headline: "Shared result", confidence: 0.6 });

    await expect(first).resolves.toMatchObject({
      meta: { source: "generated", deduplicated: false },
    });
    await expect(second).resolves.toMatchObject({
      meta: {
        source: "generated",
        deduplicated: true,
        cacheExpiresAt: "2026-11-12T18:00:30.000Z",
        budget: { charged: false },
      },
    });
    expect(repo.reserveBudget).toHaveBeenCalledOnce();
    expect(repo.putCachedView).toHaveBeenCalledOnce();
    expect(repo.completeBudget).toHaveBeenCalledOnce();
  });

  it("returns honest retry metadata when the per-owner budget is denied", async () => {
    const repo = repository({
      reserveBudget: vi.fn().mockResolvedValue({
        granted: false,
        reason: "rolling_limit",
        remaining: 0,
        limit: 10,
        retryAt: "2026-11-12T18:02:00.000Z",
      }),
    });
    const generate = vi.fn();

    const error = await guard(repo).execute(request(generate)).catch((caught) => caught);

    expect(error).toMatchObject({
      name: "OmnigazeAiGuardError",
      code: "ai_rate_limited",
      status: 429,
      retryAt: "2026-11-12T18:02:00.000Z",
      retryAfterSeconds: 120,
      budgetReason: "rolling_limit",
    });
    expect(omnigazeAiGuardErrorHeaders(error)).toEqual({
      "Retry-After": "120",
      "X-Omnigaze-AI-Budget-Retry-At": "2026-11-12T18:02:00.000Z",
      "X-Omnigaze-AI-Budget-Reason": "rolling_limit",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(repo.completeBudget).not.toHaveBeenCalled();
  });

  it("fails closed before model work when cache controls are unavailable", async () => {
    const repo = repository({
      findCachedView: vi
        .fn()
        .mockRejectedValue(new Error("database secret details")),
    });
    const generate = vi.fn();

    const error = await guard(repo).execute(request(generate)).catch((caught) => caught);

    expect(error).toBeInstanceOf(OmnigazeAiGuardError);
    expect(error).toMatchObject({ code: "ai_guard_unavailable", status: 503 });
    expect(String(error)).not.toContain("database secret details");
    expect(generate).not.toHaveBeenCalled();
    expect(repo.reserveBudget).not.toHaveBeenCalled();
  });

  it("fails closed on malformed cached payloads instead of invoking the model", async () => {
    const repo = repository({
      findCachedView: vi
        .fn()
        .mockResolvedValue(cachedRecord(await fingerprint(), { payload: {} })),
    });
    const generate = vi.fn();

    await expect(guard(repo).execute(request(generate))).rejects.toMatchObject({
      code: "ai_guard_unavailable",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(repo.reserveBudget).not.toHaveBeenCalled();
  });

  it("never writes a cache projection containing raw prompt fields", async () => {
    const unsafeCodec: OmnigazeAiCacheCodec<View> = {
      ...codec,
      encode: (value) => ({ ...value, system_prompt: "private model input" }),
    };
    const repo = repository();
    const generate = vi
      .fn()
      .mockResolvedValue({ headline: "Generated", confidence: 0.57 });
    const service = new OmnigazeAiGuard(repo, unsafeCodec, {
      now: () => new Date(NOW),
    });

    await expect(service.execute(request(generate))).rejects.toMatchObject({
      code: "ai_guard_unavailable",
    });
    expect(repo.putCachedView).not.toHaveBeenCalled();
    expect(repo.completeBudget).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "succeeded" }),
    );
  });

  it("marks the reservation failed when model generation throws", async () => {
    const repo = repository();
    const generate = vi.fn().mockRejectedValue(new Error("model unavailable"));

    await expect(guard(repo).execute(request(generate))).rejects.toThrow(
      "model unavailable",
    );
    expect(repo.completeBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation-1",
        outcome: "failed",
      }),
    );
    expect(repo.putCachedView).not.toHaveBeenCalled();
  });

  it("rejects stale evidence before reading cache or reserving budget", async () => {
    const repo = repository();

    await expect(
      guard(repo).execute(
        request(undefined, {
          freshness: {
            state: "fresh",
            asOf: "2026-11-12T17:58:59.000Z",
            maximumAgeSeconds: 60,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "fresh_evidence_required" });
    expect(repo.findCachedView).not.toHaveBeenCalled();
    expect(repo.reserveBudget).not.toHaveBeenCalled();
  });

  it("fails closed when reservation completion cannot be recorded", async () => {
    const repo = repository({
      completeBudget: vi
        .fn()
        .mockRejectedValue(new Error("completion write failed")),
    });

    await expect(guard(repo).execute(request())).rejects.toMatchObject({
      code: "ai_guard_unavailable",
    });
    expect(repo.putCachedView).toHaveBeenCalledOnce();
  });
});
