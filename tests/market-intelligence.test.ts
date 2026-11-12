import { describe, expect, it } from "vitest";
import {
  getIntelligenceFeed,
  getMarketSnapshot,
  getOmnigazeView,
  searchSymbols,
} from "@/lib/services/market-intelligence";
import { deduplicateEvents } from "@/lib/pipeline/deduplicate";
import type { NormalizedSourceEvent } from "@/lib/pipeline/contracts";

describe("market intelligence service", () => {
  it("resolves company names and tickers to canonical instruments", () => {
    expect(searchSymbols("nvidia")[0]?.instrument.id).toBe("NASDAQ:NVDA");
    expect(searchSymbols("AMD")[0]?.instrument.id).toBe("NASDAQ:AMD");
  });

  it("returns snapshots with explicit freshness metadata", () => {
    const snapshot = getMarketSnapshot("NASDAQ:NVDA");
    expect(snapshot).toMatchObject({
      symbolId: "NASDAQ:NVDA",
      isDelayed: true,
      delaySeconds: 900,
    });
    expect(snapshot?.asOf).toBeTruthy();
    expect(snapshot?.provider).toBeTruthy();
  });

  it("filters intelligence events by materiality", () => {
    const events = getIntelligenceFeed({ minimumMateriality: "high" });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => ["high", "critical"].includes(event.materiality))).toBe(true);
  });

  it("keeps Omnigaze interpretations tied to known evidence", () => {
    const result = getOmnigazeView("NASDAQ:MSFT");
    const evidenceIds = new Set(result?.evidence.map((item) => item.id));
    const citedIds = result?.view.drivers.flatMap((driver) => driver.evidenceIds) ?? [];
    expect(citedIds.length).toBeGreaterThan(0);
    expect(citedIds.every((id) => evidenceIds.has(id))).toBe(true);
  });
});

describe("pipeline deduplication", () => {
  it("removes replayed source events while preserving corrections", () => {
    const base: NormalizedSourceEvent = {
      id: "one",
      canonicalSymbol: "NASDAQ:NVDA",
      source: "provider",
      sourceKind: "licensed_news",
      sourceEventId: "external-1",
      receivedAt: "2026-11-11T10:01:00.000Z",
      publishedAt: "2026-11-11T10:00:00.000Z",
      classification: "fact",
      materiality: "medium",
      title: "Headline",
      summary: null,
      sourceUrl: null,
      rawPayloadHash: "hash-a",
    };

    const result = deduplicateEvents([
      base,
      { ...base, id: "duplicate" },
      { ...base, id: "correction", rawPayloadHash: "hash-b" },
    ]);

    expect(result.map((event) => event.id)).toEqual(["one", "correction"]);
  });
});
