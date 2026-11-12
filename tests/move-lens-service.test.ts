import { describe, expect, it, vi } from "vitest";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { MoveLensSnapshotInput } from "@/lib/move-lens";
import {
  getMoveLens,
  MOVE_LENS_EVIDENCE_FETCH_LIMIT,
  type MoveLensDependencies,
} from "@/lib/services/move-lens";
import type { OrchestratedIntelligenceFeed } from "@/lib/services/live-market-data";
import type { ResolvedInstrument } from "@/lib/services/instrument-resolution";

const NOW = "2026-11-12T18:00:00.000Z";
const AS_OF = "2026-11-12T17:59:00.000Z";

function instrument(symbolId: CanonicalSymbol): ResolvedInstrument {
  const [exchange, ticker] = symbolId.split(":");
  return {
    id: symbolId,
    ticker,
    exchange,
    name: ticker,
    sector: null,
    currency: "USD",
    status: "active",
  };
}

function snapshot(
  symbolId: CanonicalSymbol,
  price = 101,
): MoveLensSnapshotInput {
  return {
    data: {
      symbolId,
      asOf: AS_OF,
      session: "regular",
      price,
      previousClose: 100,
      provider: "alpaca",
      isDelayed: false,
      delaySeconds: 0,
      marketCoverage: "consolidated",
    },
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "complete",
      coverage: "complete",
      freshness: { state: "fresh", asOf: AS_OF, ageSeconds: 60 },
    },
  };
}

function feed(): OrchestratedIntelligenceFeed {
  return {
    data: [
      {
        id: "alpaca:event-1",
        symbolIds: ["NASDAQ:NVDA"],
        source: "Reuters",
        sourceKind: "licensed_news",
        headline: "NVIDIA publishes a company update",
        summary: null,
        publishedAt: "2026-11-12T17:30:00.000Z",
        receivedAt: "2026-11-12T17:31:00.000Z",
        sourceUrl: "https://example.com/story",
        materiality: "medium",
        isLive: true,
        claimStatus: "reported",
        causalLink: "unassessed",
      },
    ],
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "complete",
      coverage: "complete",
      generatedAt: NOW,
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:30:00.000Z",
        ageSeconds: 1_800,
      },
      providers: [],
      notice: "Live provider evidence.",
    },
  };
}

function dependencies(
  overrides: Partial<MoveLensDependencies> = {},
): MoveLensDependencies {
  return {
    resolveInstrument: vi.fn(async (symbolId) => instrument(symbolId)),
    getSnapshots: vi.fn(async (symbols: CanonicalSymbol[]) =>
      new Map<CanonicalSymbol, MoveLensSnapshotInput>(
        symbols.map((symbol) => [symbol, snapshot(symbol)]),
      ),
    ),
    getIntelligence: vi.fn(async () => feed()),
    now: () => new Date(NOW),
    ...overrides,
  };
}

describe("Move Lens service orchestration", () => {
  it("resolves identity before starting one ordered batch and evidence read", async () => {
    let resolveInstrument!: (value: ResolvedInstrument) => void;
    const resolution = new Promise<ResolvedInstrument>((resolve) => {
      resolveInstrument = resolve;
    });
    const deps = dependencies({
      resolveInstrument: vi.fn(() => resolution),
    });

    const pending = getMoveLens("NASDAQ:NVDA", deps);
    expect(deps.getSnapshots).not.toHaveBeenCalled();
    expect(deps.getIntelligence).not.toHaveBeenCalled();

    resolveInstrument(instrument("NASDAQ:NVDA"));
    const result = await pending;

    expect(deps.getSnapshots).toHaveBeenCalledTimes(1);
    expect(deps.getSnapshots).toHaveBeenCalledWith([
      "NASDAQ:NVDA",
      "ARCA:SPY",
      "NASDAQ:QQQ",
    ]);
    expect(deps.getIntelligence).toHaveBeenCalledWith({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-11T18:00:00.000Z",
      limit: MOVE_LENS_EVIDENCE_FETCH_LIMIT,
      minimumMateriality: "low",
    });
    expect(result.data.status).toBe("complete");
    expect(result.data.latestRelatedEvent?.id).toBe("alpaca:event-1");
  });

  it.each([
    ["ARCA:SPY", ["ARCA:SPY", "NASDAQ:QQQ"]],
    ["NASDAQ:QQQ", ["NASDAQ:QQQ", "ARCA:SPY"]],
  ] as const)(
    "deduplicates the selected benchmark %s without changing order",
    async (selected, expected) => {
      const deps = dependencies();
      await getMoveLens(selected, deps);
      expect(deps.getSnapshots).toHaveBeenCalledWith(expected);
    },
  );

  it("starts snapshot and intelligence reads concurrently after resolution", async () => {
    let releaseSnapshots!: (
      value: ReadonlyMap<CanonicalSymbol, MoveLensSnapshotInput>,
    ) => void;
    let releaseEvidence!: (value: OrchestratedIntelligenceFeed) => void;
    const snapshots = new Promise<
      ReadonlyMap<CanonicalSymbol, MoveLensSnapshotInput>
    >((resolve) => {
      releaseSnapshots = resolve;
    });
    const evidence = new Promise<OrchestratedIntelligenceFeed>((resolve) => {
      releaseEvidence = resolve;
    });
    const deps = dependencies({
      getSnapshots: vi.fn(() => snapshots),
      getIntelligence: vi.fn(() => evidence),
    });

    const pending = getMoveLens("NASDAQ:NVDA", deps);
    await vi.waitFor(() => {
      expect(deps.getSnapshots).toHaveBeenCalledOnce();
      expect(deps.getIntelligence).toHaveBeenCalledOnce();
    });
    releaseSnapshots(
      new Map([
        ["NASDAQ:NVDA", snapshot("NASDAQ:NVDA")],
        ["ARCA:SPY", snapshot("ARCA:SPY")],
        ["NASDAQ:QQQ", snapshot("NASDAQ:QQQ")],
      ]),
    );
    releaseEvidence(feed());

    await expect(pending).resolves.toMatchObject({
      data: { status: "complete" },
    });
  });

  it("degrades provider reads independently without inventing output", async () => {
    const quoteFailure = dependencies({
      getSnapshots: vi.fn(async () => {
        throw new Error("provider secret");
      }),
    });
    const evidenceFailure = dependencies({
      getIntelligence: vi.fn(async () => {
        throw new Error("provider secret");
      }),
    });

    const unavailable = await getMoveLens("NASDAQ:NVDA", quoteFailure);
    const quotesOnly = await getMoveLens("NASDAQ:NVDA", evidenceFailure);

    expect(unavailable.data).toMatchObject({
      status: "unavailable",
      latestRelatedEvent: { id: "alpaca:event-1" },
    });
    expect(unavailable.data.selected).toMatchObject({
      status: "unavailable",
      observation: null,
    });
    expect(quotesOnly.data).toMatchObject({
      status: "complete",
      latestRelatedEvent: null,
    });
    expect(quotesOnly.meta.evidenceStatus).toBe("unavailable");
  });

  it("distinguishes a verified empty evidence read from an unavailable one", async () => {
    const liveFeed = feed();
    const demoFeed: OrchestratedIntelligenceFeed = {
      ...liveFeed,
      data: [],
      meta: {
        ...liveFeed.meta,
        dataMode: "demo",
        mode: "demo",
        providerCoverage: "demo",
        coverage: "demo",
      },
    };
    const verifiedEmpty = dependencies({
      getIntelligence: vi.fn(async () => ({ ...feed(), data: [] })),
    });
    const nonLive = dependencies({
      getIntelligence: vi.fn(async () => demoFeed),
    });

    const empty = await getMoveLens("NASDAQ:NVDA", verifiedEmpty);
    const unavailable = await getMoveLens("NASDAQ:NVDA", nonLive);

    expect(empty.meta.evidenceStatus).toBe("none");
    expect(unavailable.meta.evidenceStatus).toBe("unavailable");
  });
});
