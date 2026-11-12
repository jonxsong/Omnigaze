import { describe, expect, it } from "vitest";
import {
  buildDailyBriefCacheKey,
  createDailyBriefCacheIdentity,
  fingerprintDailyBriefEvidence,
  fingerprintDailyBriefWatchlist,
} from "@/lib/ai/daily-brief-fingerprint";
import type { DailyBriefEvidenceItem } from "@/lib/services/personal-today-evidence";

function evidence(
  id: string,
  symbolId = "NASDAQ:NVDA" as const,
): DailyBriefEvidenceItem {
  return {
    id: `evidence:${id}`,
    eventId: id,
    symbolIds: [symbolId],
    source: "alpaca",
    sourceKind: "licensed_news",
    headline: `Headline ${id}`,
    summary: `Summary ${id}`,
    publishedAt: "2026-11-12T17:00:00.000Z",
    providerUpdatedAt: null,
    sourceUrl: `https://example.test/${id}`,
    materiality: "high",
    category: "market",
    claimStatus: "reported",
    causalLink: "unassessed",
    topicTags: ["update"],
    isControversial: false,
  };
}

describe("Daily Brief cache fingerprints", () => {
  it("is stable across watchlist, evidence, symbol, and tag ordering", async () => {
    const first = evidence("one");
    first.symbolIds = ["NASDAQ:NVDA", "NASDAQ:MSFT"];
    first.topicTags = ["governance", "executive"];
    const reordered = { ...first };
    reordered.symbolIds = ["NASDAQ:MSFT", "NASDAQ:NVDA"];
    reordered.topicTags = ["executive", "governance"];

    await expect(
      fingerprintDailyBriefWatchlist(["NASDAQ:NVDA", "NASDAQ:MSFT"]),
    ).resolves.toBe(
      await fingerprintDailyBriefWatchlist(["NASDAQ:MSFT", "NASDAQ:NVDA"]),
    );
    await expect(
      fingerprintDailyBriefEvidence([first, evidence("two")]),
    ).resolves.toBe(
      await fingerprintDailyBriefEvidence([evidence("two"), reordered]),
    );
  });

  it("invalidates on a correction, watchlist change, prompt change, or model change", async () => {
    const baseEvidence = evidence("one");
    const corrected = {
      ...baseEvidence,
      headline: "Corrected headline",
      providerUpdatedAt: "2026-11-12T17:30:00.000Z",
      claimStatus: "corrected" as const,
    };
    expect(await fingerprintDailyBriefEvidence([corrected])).not.toBe(
      await fingerprintDailyBriefEvidence([baseEvidence]),
    );
    expect(await fingerprintDailyBriefWatchlist(["NASDAQ:NVDA"])).not.toBe(
      await fingerprintDailyBriefWatchlist(["NASDAQ:NVDA", "NASDAQ:MSFT"]),
    );

    const identity = await createDailyBriefCacheIdentity({
      promptVersion: "brief-v1",
      modelKey: "gpt-default-v1",
      briefDate: "2026-11-12",
      trackedSymbols: ["NASDAQ:NVDA"],
      evidence: [baseEvidence],
    });
    const promptChanged = await buildDailyBriefCacheKey({
      ...identity,
      promptVersion: "brief-v2",
      modelKey: "gpt-default-v1",
      briefDate: "2026-11-12",
    });
    const modelChanged = await buildDailyBriefCacheKey({
      ...identity,
      promptVersion: "brief-v1",
      modelKey: "gpt-new-model",
      briefDate: "2026-11-12",
    });
    expect(promptChanged).not.toBe(identity.cacheKey);
    expect(modelChanged).not.toBe(identity.cacheKey);
  });

  it("returns only opaque SHA-256 identities without raw evidence content", async () => {
    const secretLikeHeadline = "Material update with private-looking text";
    const item = { ...evidence("one"), headline: secretLikeHeadline };
    const identity = await createDailyBriefCacheIdentity({
      promptVersion: "brief-v1",
      modelKey: "gpt-default-v1",
      briefDate: "2026-11-12",
      trackedSymbols: ["NASDAQ:NVDA"],
      evidence: [item],
    });

    for (const value of Object.values(identity)) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
      expect(value).not.toContain(secretLikeHeadline);
    }
  });

  it("rejects empty/duplicate evidence and malformed identity inputs", async () => {
    await expect(fingerprintDailyBriefEvidence([])).rejects.toThrow(
      "invalid_evidence",
    );
    await expect(
      fingerprintDailyBriefEvidence([evidence("one"), evidence("one")]),
    ).rejects.toThrow("invalid_evidence");
    await expect(fingerprintDailyBriefWatchlist([])).rejects.toThrow(
      "invalid_watchlist",
    );
    await expect(
      fingerprintDailyBriefEvidence([
        { ...evidence("one"), sourceUrl: "javascript:alert(1)" },
      ]),
    ).rejects.toThrow("invalid_evidence");
    await expect(
      buildDailyBriefCacheKey({
        promptVersion: "brief-v1",
        modelKey: "gpt-default-v1",
        briefDate: "not-a-date",
        watchlistFingerprint: "x",
        evidenceFingerprint: "y",
      }),
    ).rejects.toThrow("invalid_cache_identity");
  });
});
