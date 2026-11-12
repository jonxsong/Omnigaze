import { describe, expect, it } from "vitest";
import { parseMarketContextEnvelope } from "@/lib/api/market-context-client";
import { getMarketContext } from "@/lib/services/market-context";

const NOW = "2026-11-12T20:00:00.000Z";

async function validEnvelope() {
  return getMarketContext({
    getSnapshots: async () => new Map(),
    now: () => new Date(NOW),
  });
}

function clone(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe("market context browser contract", () => {
  it("accepts the strict server envelope", async () => {
    const envelope = await validEnvelope();
    expect(parseMarketContextEnvelope(envelope)).toEqual(envelope);
  });

  it("rejects unknown fields, proxy reordering, and summary drift", async () => {
    const envelope = await validEnvelope();

    const unknown = clone(envelope);
    unknown.rawProviderPayload = { key: "must not enter the client" };
    expect(() => parseMarketContextEnvelope(unknown)).toThrow();

    const reordered = clone(envelope) as unknown as {
      data: unknown[];
    };
    [reordered.data[0], reordered.data[1]] = [
      reordered.data[1],
      reordered.data[0],
    ];
    expect(() => parseMarketContextEnvelope(reordered)).toThrow();

    const drift = clone(envelope) as unknown as {
      meta: { unavailableCount: number };
    };
    drift.meta.unavailableCount = 5;
    expect(() => parseMarketContextEnvelope(drift)).toThrow();
  });

  it("rejects a snapshot whose identity does not match its configured proxy", async () => {
    const envelope = await validEnvelope();
    const forged = clone(envelope) as unknown as {
      data: Record<string, unknown>[];
      meta: Record<string, unknown>;
    };
    forged.data[0] = {
      key: "us-large-cap",
      symbolId: "ARCA:SPY",
      ticker: "SPY",
      label: "S&P 500 ETF proxy",
      assetType: "etf_proxy",
      status: "live",
      snapshot: {
        symbolId: "NASDAQ:QQQ",
        asOf: "2026-11-12T19:59:30.000Z",
        session: "regular",
        price: 250,
        previousClose: 245,
        change: 5,
        changePercent: 2.04,
        volume: 1_000,
        isDelayed: false,
        delaySeconds: 0,
        provider: "Alpaca iex",
        marketCoverage: "limited-exchange",
      },
    };
    forged.meta.status = "partial";
    forged.meta.liveCount = 1;
    forged.meta.unavailableCount = 5;
    forged.meta.availabilityCoverage = "partial";
    forged.meta.marketCoverage = "partial";

    expect(() => parseMarketContextEnvelope(forged)).toThrow();
  });

  it("rejects accidental data fields on a suppressed demo item", async () => {
    const envelope = await validEnvelope();
    const demo = clone(envelope) as unknown as {
      data: Record<string, unknown>[];
      meta: Record<string, unknown>;
    };
    demo.data[0] = {
      ...demo.data[0],
      status: "demo",
      reason: "demo_suppressed",
      snapshot: { price: 999 },
    };
    demo.meta.status = "demo";
    demo.meta.demoCount = 1;
    demo.meta.unavailableCount = 5;

    expect(() => parseMarketContextEnvelope(demo)).toThrow();
  });
});

