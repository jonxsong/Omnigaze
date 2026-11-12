import { describe, expect, it } from "vitest";
import { parseMoveLensEnvelope } from "@/lib/api/move-lens-client";
import {
  buildMoveLens,
  type MoveLensSnapshotInput,
} from "@/lib/move-lens";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";

const NOW = "2026-11-12T20:00:00.000Z";
const AS_OF = "2026-11-12T19:59:30.000Z";

function snapshot(
  symbolId: CanonicalSymbol,
  price: number,
  previousClose = 100,
  overrides: Partial<NonNullable<MoveLensSnapshotInput["data"]>> = {},
): MoveLensSnapshotInput {
  return {
    data: {
      symbolId,
      price,
      previousClose,
      asOf: AS_OF,
      session: "regular",
      provider: "Alpaca iex",
      isDelayed: false,
      delaySeconds: 0,
      marketCoverage: "limited-exchange",
      ...overrides,
    },
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      freshness: {
        state: "fresh",
        asOf: overrides.asOf ?? AS_OF,
        ageSeconds: 30,
      },
    },
  };
}

function event(
  overrides: Partial<IntelligenceFeedItem> = {},
): IntelligenceFeedItem {
  return {
    id: "alpaca:event-1",
    symbolIds: ["NASDAQ:NVDA"],
    source: "alpaca",
    sourceKind: "licensed_news",
    headline: "NVIDIA publishes a company update",
    summary: "A symbol-linked development for evidence review.",
    publishedAt: "2026-11-12T19:00:00.000Z",
    receivedAt: "2026-11-12T19:00:01.000Z",
    providerUpdatedAt: "2026-11-12T19:05:00.000Z",
    sourceUrl: "https://example.test/story",
    materiality: "medium",
    isLive: true,
    category: "product",
    claimStatus: "reported",
    causalLink: "unassessed",
    topicTags: ["product"],
    isControversial: false,
    ...overrides,
  };
}

function validEnvelope() {
  return buildMoveLens({
    selectedSymbolId: "NASDAQ:NVDA",
    selectedSnapshot: snapshot("NASDAQ:NVDA", 102),
    benchmarkSnapshots: new Map([
      ["ARCA:SPY", snapshot("ARCA:SPY", 101)],
      ["NASDAQ:QQQ", snapshot("NASDAQ:QQQ", 99)],
    ]),
    evidence: [event()],
    evidenceReadStatus: "verified",
    evaluatedAt: NOW,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Move Lens browser contract", () => {
  it("accepts the exact deterministic server envelope", () => {
    const envelope = validEnvelope();

    expect(parseMoveLensEnvelope(envelope)).toEqual(envelope);
    expect(envelope).toMatchObject({
      data: {
        status: "complete",
        aggregateRelationship: "ahead",
        causationAssessment: "not_assessed",
        modelUsed: false,
        tradeExecutionAllowed: false,
      },
      meta: {
        comparableBenchmarkCount: 2,
        requestedBenchmarkCount: 2,
        evidenceStatus: "available",
      },
    });
  });

  it("permits independently named providers when comparison metadata matches", () => {
    const envelope = buildMoveLens({
      selectedSymbolId: "NASDAQ:NVDA",
      selectedSnapshot: snapshot("NASDAQ:NVDA", 102, 100, {
        provider: "Selected quote provider",
      }),
      benchmarkSnapshots: new Map([
        [
          "ARCA:SPY",
          snapshot("ARCA:SPY", 101, 100, {
            provider: "SPY quote provider",
          }),
        ],
        [
          "NASDAQ:QQQ",
          snapshot("NASDAQ:QQQ", 99, 100, {
            provider: "QQQ quote provider",
          }),
        ],
      ]),
      evidence: [],
      evidenceReadStatus: "verified",
      evaluatedAt: NOW,
    });

    expect(parseMoveLensEnvelope(envelope)).toEqual(envelope);
    expect(envelope.data.status).toBe("complete");
  });

  it("rejects unknown fields plus selected or proxy identity and order drift", () => {
    const unknown = clone(validEnvelope()) as typeof validEnvelope extends () => infer R
      ? R & { rawProviderPayload?: unknown }
      : never;
    unknown.rawProviderPayload = { secret: "must-not-cross" };
    expect(() => parseMoveLensEnvelope(unknown)).toThrow();

    const selected = clone(validEnvelope());
    selected.data.selected.label = "A different selected security";
    expect(() => parseMoveLensEnvelope(selected)).toThrow();

    const paddedIdentity = clone(validEnvelope());
    paddedIdentity.data.selected.label = " NVDA selected security ";
    expect(() => parseMoveLensEnvelope(paddedIdentity)).toThrow();

    const reordered = clone(validEnvelope());
    [reordered.data.benchmarks[0], reordered.data.benchmarks[1]] = [
      reordered.data.benchmarks[1],
      reordered.data.benchmarks[0],
    ];
    expect(() => parseMoveLensEnvelope(reordered)).toThrow();

    const observationIdentity = clone(validEnvelope());
    if (observationIdentity.data.benchmarks[0].status === "available") {
      observationIdentity.data.benchmarks[0].observation.symbolId =
        "NASDAQ:QQQ";
    }
    expect(() => parseMoveLensEnvelope(observationIdentity)).toThrow();
  });

  it("recomputes absolute and relative basis-point arithmetic and direction", () => {
    const priceChange = clone(validEnvelope());
    if (priceChange.data.selected.status === "available") {
      priceChange.data.selected.observation.priceChange = 999;
    }
    expect(() => parseMoveLensEnvelope(priceChange)).toThrow();

    const absoluteMove = clone(validEnvelope());
    if (absoluteMove.data.selected.status === "available") {
      absoluteMove.data.selected.observation.absoluteMoveBps = 201;
    }
    expect(() => parseMoveLensEnvelope(absoluteMove)).toThrow();

    const relativeMove = clone(validEnvelope());
    relativeMove.data.benchmarks[0].relativeMoveBps = 99;
    expect(() => parseMoveLensEnvelope(relativeMove)).toThrow();

    const direction = clone(validEnvelope());
    direction.data.benchmarks[0].relationship = "behind";
    expect(() => parseMoveLensEnvelope(direction)).toThrow();
  });

  it("accepts an honest partial result and rejects invented aggregate or count state", () => {
    const partial = buildMoveLens({
      selectedSymbolId: "NASDAQ:NVDA",
      selectedSnapshot: snapshot("NASDAQ:NVDA", 102),
      benchmarkSnapshots: new Map([
        ["ARCA:SPY", snapshot("ARCA:SPY", 101)],
        [
          "NASDAQ:QQQ",
          snapshot("NASDAQ:QQQ", 99, 100, {
            isDelayed: true,
            delaySeconds: 900,
          }),
        ],
      ]),
      evidence: [],
      evidenceReadStatus: "verified",
      evaluatedAt: NOW,
    });

    expect(parseMoveLensEnvelope(partial)).toEqual(partial);
    expect(partial).toMatchObject({
      data: { status: "partial", aggregateRelationship: null },
      meta: { comparableBenchmarkCount: 1, evidenceStatus: "none" },
    });

    const inventedAggregate = clone(partial);
    inventedAggregate.data.aggregateRelationship = "ahead";
    expect(() => parseMoveLensEnvelope(inventedAggregate)).toThrow();

    const drift = clone(validEnvelope());
    drift.meta.comparableBenchmarkCount = 1;
    drift.data.status = "partial";
    expect(() => parseMoveLensEnvelope(drift)).toThrow();

    const compatibility = clone(validEnvelope());
    if (compatibility.data.benchmarks[0].status === "available") {
      compatibility.data.benchmarks[0].observation.session = "after-hours";
    }
    expect(() => parseMoveLensEnvelope(compatibility)).toThrow();
  });

  it("rejects unsafe provenance, stale timestamps, and inconsistent delay metadata", () => {
    const credentialUrl = clone(validEnvelope());
    credentialUrl.data.latestRelatedEvent!.sourceUrl =
      "https://example.test/story?api_key=do-not-render";
    expect(() => parseMoveLensEnvelope(credentialUrl)).toThrow();

    const stale = clone(validEnvelope());
    if (stale.data.selected.status === "available") {
      stale.data.selected.observation.asOf = "2026-11-12T18:00:00.000Z";
    }
    expect(() => parseMoveLensEnvelope(stale)).toThrow();

    const provider = clone(validEnvelope());
    if (provider.data.selected.status === "available") {
      provider.data.selected.observation.provider = "\u0000raw-provider";
    }
    expect(() => parseMoveLensEnvelope(provider)).toThrow();

    const delay = clone(validEnvelope());
    if (delay.data.selected.status === "available") {
      delay.data.selected.observation.delaySeconds = 30;
    }
    expect(() => parseMoveLensEnvelope(delay)).toThrow();
  });

  it("keeps causation, model use, trading, evidence, and notices fail-closed", () => {
    const causation = clone(validEnvelope()) as unknown as {
      data: { causationAssessment: string };
    };
    causation.data.causationAssessment = "supported";
    expect(() => parseMoveLensEnvelope(causation)).toThrow();

    const nestedCausation = clone(validEnvelope()) as unknown as {
      data: { latestRelatedEvent: { causalLink: string } };
    };
    nestedCausation.data.latestRelatedEvent.causalLink =
      "plausible-contributor";
    expect(() => parseMoveLensEnvelope(nestedCausation)).toThrow();

    const nestedSupported = clone(validEnvelope()) as unknown as {
      data: { latestRelatedEvent: { causalLink: string } };
    };
    nestedSupported.data.latestRelatedEvent.causalLink = "supported";
    expect(() => parseMoveLensEnvelope(nestedSupported)).toThrow();

    const model = clone(validEnvelope()) as unknown as {
      data: { modelUsed: boolean };
    };
    model.data.modelUsed = true;
    expect(() => parseMoveLensEnvelope(model)).toThrow();

    const trading = clone(validEnvelope()) as unknown as {
      data: { tradeExecutionAllowed: boolean };
    };
    trading.data.tradeExecutionAllowed = true;
    expect(() => parseMoveLensEnvelope(trading)).toThrow();

    const evidenceStatus = clone(validEnvelope());
    evidenceStatus.meta.evidenceStatus = "none";
    expect(() => parseMoveLensEnvelope(evidenceStatus)).toThrow();

    const unavailableEvidence = clone(validEnvelope());
    unavailableEvidence.data.latestRelatedEvent = null;
    unavailableEvidence.meta.evidenceStatus = "unavailable";
    expect(parseMoveLensEnvelope(unavailableEvidence)).toEqual(
      unavailableEvidence,
    );

    const inventedAvailableEvidence = clone(unavailableEvidence);
    inventedAvailableEvidence.meta.evidenceStatus = "available";
    expect(() => parseMoveLensEnvelope(inventedAvailableEvidence)).toThrow();

    const unavailableWithEvent = clone(validEnvelope());
    unavailableWithEvent.meta.evidenceStatus = "unavailable";
    expect(() => parseMoveLensEnvelope(unavailableWithEvent)).toThrow();

    const outsideWindow = clone(validEnvelope());
    outsideWindow.data.latestRelatedEvent!.publishedAt =
      "2026-11-11T19:59:59.999Z";
    expect(() => parseMoveLensEnvelope(outsideWindow)).toThrow();

    const notice = clone(validEnvelope()) as unknown as {
      meta: { causationNotice: string };
    };
    notice.meta.causationNotice = "This event caused the move.";
    expect(() => parseMoveLensEnvelope(notice)).toThrow();
  });
});
