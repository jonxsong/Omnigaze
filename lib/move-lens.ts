import type { MarketContextResult } from "@/lib/market-context";
import type {
  CanonicalSymbol,
  CausalLink,
  ClaimStatus,
  MarketSession,
  MarketSnapshot,
  Materiality,
} from "@/lib/market-types";
import { isCredentialFreePublicHttpUrl } from "@/lib/security/public-http-url";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";

const MICRO_SCALE = BigInt(1_000_000);
const BASIS_POINTS = BigInt(10_000);
const MAX_QUOTE_AGE_SECONDS = 1_200;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

export const MOVE_LENS_MAX_OBSERVATION_SKEW_SECONDS = 5 * 60;
export const MOVE_LENS_EVIDENCE_WINDOW_HOURS = 24;
export const MOVE_LENS_BENCHMARK_NOTICE =
  "SPY and QQQ are ETF proxies. Their prices are not index levels.";
export const MOVE_LENS_CAUSATION_NOTICE =
  "Related developments are symbol-linked evidence, not proof that they caused the price move.";

export const moveLensBenchmarks = [
  {
    key: "spy",
    symbolId: "ARCA:SPY",
    ticker: "SPY",
    label: "S&P 500 ETF proxy",
    assetType: "etf_proxy",
  },
  {
    key: "qqq",
    symbolId: "NASDAQ:QQQ",
    ticker: "QQQ",
    label: "Nasdaq-100 ETF proxy",
    assetType: "etf_proxy",
  },
] as const satisfies readonly {
  key: string;
  symbolId: CanonicalSymbol;
  ticker: string;
  label: string;
  assetType: "etf_proxy";
}[];

export type MoveLensBenchmark = (typeof moveLensBenchmarks)[number];
export type MoveLensBenchmarkKey = MoveLensBenchmark["key"];
export type MoveLensRelationship = "ahead" | "behind" | "equal";
export type MoveLensAggregateRelationship = MoveLensRelationship | "mixed";
export type MoveLensStatus = "complete" | "partial" | "unavailable";
export type MoveLensEvidenceReadStatus = "verified" | "unavailable";
export type MoveLensEvidenceStatus = "available" | "none" | "unavailable";
export type MoveLensCausalLink = Extract<
  CausalLink,
  "unassessed" | "temporal-only"
>;

export type MoveLensUnavailableReason =
  | "snapshot_unavailable"
  | "demo_suppressed"
  | "identity_mismatch"
  | "invalid_snapshot"
  | "freshness_unverified";

export type MoveLensComparisonUnavailableReason =
  | "selected_unavailable"
  | "benchmark_unavailable"
  | "session_mismatch"
  | "delay_mismatch"
  | "coverage_mismatch"
  | "observation_skew";

export type MoveLensMarketSnapshot = Pick<
  MarketSnapshot,
  | "symbolId"
  | "asOf"
  | "session"
  | "price"
  | "previousClose"
  | "isDelayed"
  | "delaySeconds"
  | "provider"
  | "marketCoverage"
>;

export interface MoveLensSnapshotInput {
  data: MoveLensMarketSnapshot | null;
  meta: {
    dataMode: "live" | "demo";
    mode: "live" | "demo";
    providerCoverage: "complete" | "partial" | "demo";
    coverage: "complete" | "partial" | "demo";
    freshness: {
      state: "fresh" | "stale" | "unknown" | "fixture";
      asOf: string | null;
      ageSeconds: number | null;
    };
  };
}

export interface MoveLensObservation {
  symbolId: CanonicalSymbol;
  price: number;
  previousClose: number;
  priceChange: number;
  absoluteMoveBps: number;
  asOf: string;
  session: MarketSession;
  provider: string;
  isDelayed: boolean;
  delaySeconds: number;
  marketCoverage: "limited-exchange" | "consolidated";
}

type MoveLensLegBase = {
  symbolId: CanonicalSymbol;
  ticker: string;
  label: string;
  assetType: "selected_security" | "etf_proxy";
};

export type MoveLensLeg =
  | (MoveLensLegBase & {
      status: "available";
      observation: MoveLensObservation;
    })
  | (MoveLensLegBase & {
      status: "unavailable";
      observation: null;
      reason: MoveLensUnavailableReason;
    });

export type MoveLensBenchmarkResult = MoveLensLeg & {
  key: MoveLensBenchmarkKey;
  relationship: MoveLensRelationship | null;
  relativeMoveBps: number | null;
  comparisonUnavailableReason: MoveLensComparisonUnavailableReason | null;
};

export interface MoveLensRelatedEvent {
  id: string;
  symbolIds: CanonicalSymbol[];
  source: string;
  sourceKind: IntelligenceFeedItem["sourceKind"];
  headline: string;
  summary: string | null;
  publishedAt: string;
  providerUpdatedAt: string | null;
  sourceUrl: string | null;
  materiality: Materiality;
  claimStatus: ClaimStatus | null;
  causalLink: MoveLensCausalLink | null;
  isControversial: boolean;
}

export interface MoveLensResult {
  data: {
    symbolId: CanonicalSymbol;
    status: MoveLensStatus;
    selected: MoveLensLeg;
    benchmarks: MoveLensBenchmarkResult[];
    aggregateRelationship: MoveLensAggregateRelationship | null;
    latestRelatedEvent: MoveLensRelatedEvent | null;
    causationAssessment: "not_assessed";
    modelUsed: false;
    tradeExecutionAllowed: false;
  };
  meta: {
    generatedAt: string;
    comparableBenchmarkCount: number;
    requestedBenchmarkCount: number;
    evidenceStatus: MoveLensEvidenceStatus;
    benchmarkNotice: typeof MOVE_LENS_BENCHMARK_NOTICE;
    causationNotice: typeof MOVE_LENS_CAUSATION_NOTICE;
  };
}

export interface BuildMoveLensInput {
  selectedSymbolId: CanonicalSymbol;
  selectedSnapshot: MoveLensSnapshotInput | undefined;
  benchmarkSnapshots: ReadonlyMap<CanonicalSymbol, MoveLensSnapshotInput>;
  evidence: readonly IntelligenceFeedItem[];
  evidenceReadStatus: MoveLensEvidenceReadStatus;
  evaluatedAt: string;
}

function tickerFor(symbolId: CanonicalSymbol) {
  return symbolId.split(":", 2)[1] ?? symbolId;
}

function safeText(value: unknown, maximum: number) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

function micros(value: number) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1e15) return null;
  const fixed = value.toFixed(6);
  const [whole, fraction = ""] = fixed.split(".");
  try {
    const result =
      BigInt(whole) * MICRO_SCALE + BigInt(fraction.padEnd(6, "0"));
    return result > BigInt(0) && result <= BigInt(Number.MAX_SAFE_INTEGER)
      ? result
      : null;
  } catch {
    return null;
  }
}

function roundedDivide(numerator: bigint, denominator: bigint) {
  if (denominator <= BigInt(0)) throw new RangeError("invalid denominator");
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / BigInt(2)) / denominator;
  return negative ? -rounded : rounded;
}

function asSafeNumber(value: bigint) {
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  return Number(value);
}

function validSession(value: unknown): value is MarketSession {
  return (
    value === "pre-market" ||
    value === "regular" ||
    value === "after-hours" ||
    value === "closed"
  );
}

function unavailableLeg(
  base: MoveLensLegBase,
  reason: MoveLensUnavailableReason,
): MoveLensLeg {
  return { ...base, status: "unavailable", observation: null, reason };
}

function classifySnapshot(
  base: MoveLensLegBase,
  resource: MoveLensSnapshotInput | undefined,
  evaluatedAtMs: number,
): MoveLensLeg {
  if (!resource?.data) {
    return unavailableLeg(
      base,
      resource?.meta.dataMode === "demo" ||
        resource?.meta.freshness.state === "fixture"
        ? "demo_suppressed"
        : "snapshot_unavailable",
    );
  }
  if (resource.data.symbolId !== base.symbolId) {
    return unavailableLeg(base, "identity_mismatch");
  }
  if (
    resource.meta.dataMode !== "live" ||
    resource.meta.mode !== "live" ||
    resource.meta.providerCoverage === "demo" ||
    resource.meta.coverage === "demo" ||
    resource.data.marketCoverage === "fixture"
  ) {
    return unavailableLeg(base, "demo_suppressed");
  }

  const snapshot = resource.data;
  const priceMicros = micros(snapshot.price);
  const previousCloseMicros = micros(snapshot.previousClose);
  const asOfMs = Date.parse(snapshot.asOf);
  if (
    priceMicros === null ||
    previousCloseMicros === null ||
    !Number.isFinite(asOfMs) ||
    !validSession(snapshot.session) ||
    !safeText(snapshot.provider, 64) ||
    typeof snapshot.isDelayed !== "boolean" ||
    !Number.isSafeInteger(snapshot.delaySeconds) ||
    snapshot.delaySeconds < 0 ||
    (snapshot.isDelayed && snapshot.delaySeconds === 0) ||
    (!snapshot.isDelayed && snapshot.delaySeconds !== 0) ||
    (snapshot.marketCoverage !== "limited-exchange" &&
      snapshot.marketCoverage !== "consolidated")
  ) {
    return unavailableLeg(base, "invalid_snapshot");
  }

  const actualAgeSeconds = Math.max(
    0,
    Math.round((evaluatedAtMs - asOfMs) / 1_000),
  );
  const maximumAgeSeconds = Math.max(
    MAX_QUOTE_AGE_SECONDS,
    snapshot.delaySeconds + 300,
  );
  const freshness = resource.meta.freshness;
  if (
    freshness.state !== "fresh" ||
    freshness.asOf !== snapshot.asOf ||
    !Number.isSafeInteger(freshness.ageSeconds) ||
    freshness.ageSeconds === null ||
    freshness.ageSeconds < 0 ||
    asOfMs > evaluatedAtMs + MAX_FUTURE_SKEW_SECONDS * 1_000 ||
    actualAgeSeconds > maximumAgeSeconds
  ) {
    return unavailableLeg(base, "freshness_unverified");
  }

  const changeMicros = priceMicros - previousCloseMicros;
  const moveBps = asSafeNumber(
    roundedDivide(changeMicros * BASIS_POINTS, previousCloseMicros),
  );
  const changeNumber = asSafeNumber(changeMicros);
  if (moveBps === null || changeNumber === null) {
    return unavailableLeg(base, "invalid_snapshot");
  }

  return {
    ...base,
    status: "available",
    observation: {
      symbolId: snapshot.symbolId,
      price: snapshot.price,
      previousClose: snapshot.previousClose,
      priceChange: changeNumber / Number(MICRO_SCALE),
      absoluteMoveBps: moveBps,
      asOf: new Date(asOfMs).toISOString(),
      session: snapshot.session,
      provider: snapshot.provider.trim(),
      isDelayed: snapshot.isDelayed,
      delaySeconds: snapshot.delaySeconds,
      marketCoverage: snapshot.marketCoverage,
    },
  };
}

function compatibilityReason(
  selected: MoveLensLeg,
  benchmark: MoveLensLeg,
): MoveLensComparisonUnavailableReason | null {
  if (selected.status !== "available") return "selected_unavailable";
  if (benchmark.status !== "available") return "benchmark_unavailable";
  if (selected.observation.session !== benchmark.observation.session) {
    return "session_mismatch";
  }
  if (
    selected.observation.isDelayed !== benchmark.observation.isDelayed ||
    selected.observation.delaySeconds !== benchmark.observation.delaySeconds
  ) {
    return "delay_mismatch";
  }
  if (
    selected.observation.marketCoverage !== benchmark.observation.marketCoverage
  ) {
    return "coverage_mismatch";
  }
  if (
    Math.abs(
      Date.parse(selected.observation.asOf) -
        Date.parse(benchmark.observation.asOf),
    ) >
    MOVE_LENS_MAX_OBSERVATION_SKEW_SECONDS * 1_000
  ) {
    return "observation_skew";
  }
  return null;
}

function relationshipFor(relativeMoveBps: number): MoveLensRelationship {
  return relativeMoveBps > 0
    ? "ahead"
    : relativeMoveBps < 0
      ? "behind"
      : "equal";
}

function aggregateRelationship(
  relationships: MoveLensRelationship[],
): MoveLensAggregateRelationship | null {
  if (relationships.length !== moveLensBenchmarks.length) return null;
  const directional = relationships.filter(
    (relationship) => relationship !== "equal",
  );
  if (directional.length === 0) return "equal";
  if (directional.every((relationship) => relationship === "ahead")) {
    return "ahead";
  }
  if (directional.every((relationship) => relationship === "behind")) {
    return "behind";
  }
  return "mixed";
}

const claimStatuses = new Set<ClaimStatus>([
  "confirmed",
  "official-investigation",
  "reported",
  "allegation",
  "disputed",
  "corrected",
]);
function safeMoveLensCausalLink(
  value: CausalLink | undefined,
): MoveLensCausalLink | null {
  if (value === "unassessed" || value === "temporal-only") return value;
  return value ? "unassessed" : null;
}

function latestRelatedEvent(
  symbolId: CanonicalSymbol,
  items: readonly IntelligenceFeedItem[],
  evaluatedAtMs: number,
): MoveLensRelatedEvent | null {
  const sinceMs =
    evaluatedAtMs - MOVE_LENS_EVIDENCE_WINDOW_HOURS * 60 * 60 * 1_000;
  const futureLimit = evaluatedAtMs + MAX_FUTURE_SKEW_SECONDS * 1_000;
  const candidates = items.flatMap((item) => {
    const publishedAtMs = Date.parse(item.publishedAt);
    const receivedAtMs = Date.parse(item.receivedAt);
    const providerUpdatedAtMs = item.providerUpdatedAt
      ? Date.parse(item.providerUpdatedAt)
      : null;
    const id = safeText(item.id, 256);
    const source = safeText(item.source, 200);
    const headline = safeText(item.headline, 500);
    if (
      !item.isLive ||
      item.sourceKind === "demo_fixture" ||
      !item.symbolIds.includes(symbolId) ||
      !id ||
      !source ||
      !headline ||
      !Number.isFinite(publishedAtMs) ||
      publishedAtMs < sinceMs ||
      publishedAtMs > futureLimit ||
      !Number.isFinite(receivedAtMs) ||
      receivedAtMs > futureLimit ||
      (providerUpdatedAtMs !== null &&
        (!Number.isFinite(providerUpdatedAtMs) ||
          providerUpdatedAtMs > futureLimit))
    ) {
      return [];
    }
    const effectiveAt = Math.max(
      publishedAtMs,
      providerUpdatedAtMs ?? Number.NEGATIVE_INFINITY,
    );
    const sourceUrlText = safeText(item.sourceUrl, 2_048);
    const sourceUrl =
      sourceUrlText && isCredentialFreePublicHttpUrl(sourceUrlText)
        ? new URL(sourceUrlText).toString()
        : null;
    const symbolIds = [
      ...new Set(
        item.symbolIds.filter((candidate): candidate is CanonicalSymbol =>
          /^[A-Z0-9._-]+:[A-Z0-9._-]+$/.test(candidate),
        ),
      ),
    ].sort();
    const related: MoveLensRelatedEvent = {
      id,
      symbolIds,
      source,
      sourceKind: item.sourceKind,
      headline,
      summary: safeText(item.summary, 2_000) || null,
      publishedAt: new Date(publishedAtMs).toISOString(),
      providerUpdatedAt:
        providerUpdatedAtMs === null
          ? null
          : new Date(providerUpdatedAtMs).toISOString(),
      sourceUrl,
      materiality: item.materiality,
      claimStatus:
        item.claimStatus && claimStatuses.has(item.claimStatus)
          ? item.claimStatus
          : null,
      // Move Lens is context-only. Stronger upstream causal classifications
      // remain available in the source intelligence feed, but are deliberately
      // downgraded at this boundary so HTTP and MCP consumers cannot mistake
      // them for a conclusion made by this comparison.
      causalLink: safeMoveLensCausalLink(item.causalLink),
      isControversial: item.isControversial === true,
    };
    return [{ event: related, effectiveAt }];
  });
  candidates.sort(
    (left, right) =>
      right.effectiveAt - left.effectiveAt ||
      right.event.publishedAt.localeCompare(left.event.publishedAt) ||
      left.event.id.localeCompare(right.event.id),
  );
  return candidates[0]?.event ?? null;
}

export function buildMoveLens(input: BuildMoveLensInput): MoveLensResult {
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new Error("invalid_move_lens_evaluation_time");
  }
  const generatedAt = new Date(evaluatedAtMs).toISOString();
  const selected = classifySnapshot(
    {
      symbolId: input.selectedSymbolId,
      ticker: tickerFor(input.selectedSymbolId),
      label: `${tickerFor(input.selectedSymbolId)} selected security`,
      assetType: "selected_security",
    },
    input.selectedSnapshot,
    evaluatedAtMs,
  );

  const benchmarks = moveLensBenchmarks.map((benchmark) => {
    const leg = classifySnapshot(
      benchmark,
      input.benchmarkSnapshots.get(benchmark.symbolId),
      evaluatedAtMs,
    );
    const unavailableReason = compatibilityReason(selected, leg);
    if (
      unavailableReason ||
      selected.status !== "available" ||
      leg.status !== "available"
    ) {
      return {
        ...leg,
        key: benchmark.key,
        relationship: null,
        relativeMoveBps: null,
        comparisonUnavailableReason:
          unavailableReason ?? "benchmark_unavailable",
      } satisfies MoveLensBenchmarkResult;
    }
    const relativeMoveBps =
      selected.observation.absoluteMoveBps -
      leg.observation.absoluteMoveBps;
    return {
      ...leg,
      key: benchmark.key,
      relationship: relationshipFor(relativeMoveBps),
      relativeMoveBps,
      comparisonUnavailableReason: null,
    } satisfies MoveLensBenchmarkResult;
  });
  const relationships = benchmarks.flatMap((benchmark) =>
    benchmark.relationship ? [benchmark.relationship] : [],
  );
  const comparableBenchmarkCount = relationships.length;
  const status: MoveLensStatus =
    selected.status !== "available"
      ? "unavailable"
      : comparableBenchmarkCount === moveLensBenchmarks.length
        ? "complete"
        : "partial";
  const event =
    input.evidenceReadStatus === "verified"
      ? latestRelatedEvent(
          input.selectedSymbolId,
          input.evidence,
          evaluatedAtMs,
        )
      : null;

  return {
    data: {
      symbolId: input.selectedSymbolId,
      status,
      selected,
      benchmarks,
      aggregateRelationship: aggregateRelationship(relationships),
      latestRelatedEvent: event,
      causationAssessment: "not_assessed",
      modelUsed: false,
      tradeExecutionAllowed: false,
    },
    meta: {
      generatedAt,
      comparableBenchmarkCount,
      requestedBenchmarkCount: moveLensBenchmarks.length,
      evidenceStatus:
        input.evidenceReadStatus === "unavailable"
          ? "unavailable"
          : event
            ? "available"
            : "none",
      benchmarkNotice: MOVE_LENS_BENCHMARK_NOTICE,
      causationNotice: MOVE_LENS_CAUSATION_NOTICE,
    },
  };
}

/**
 * Adapts the strict public Market Context contract for browser-side Move Lens
 * reuse. No provider values are invented for suppressed or unavailable items.
 */
export function moveLensBenchmarkSnapshotsFromMarketContext(
  context: MarketContextResult,
  evaluatedAt: string,
): ReadonlyMap<CanonicalSymbol, MoveLensSnapshotInput> {
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new Error("invalid_move_lens_evaluation_time");
  }
  const snapshots = new Map<CanonicalSymbol, MoveLensSnapshotInput>();
  for (const benchmark of moveLensBenchmarks) {
    const item = context.data.find(
      (candidate) => candidate.symbolId === benchmark.symbolId,
    );
    if (item?.status === "live" || item?.status === "stale") {
      const asOfMs = Date.parse(item.snapshot.asOf);
      const ageSeconds = Number.isFinite(asOfMs)
        ? Math.max(0, Math.round((evaluatedAtMs - asOfMs) / 1_000))
        : null;
      snapshots.set(benchmark.symbolId, {
        data: item.snapshot,
        meta: {
          dataMode: "live",
          mode: "live",
          providerCoverage:
            item.snapshot.marketCoverage === "consolidated"
              ? "complete"
              : "partial",
          coverage:
            item.snapshot.marketCoverage === "consolidated"
              ? "complete"
              : "partial",
          freshness: {
            state: item.status === "live" ? "fresh" : "stale",
            asOf: item.snapshot.asOf,
            ageSeconds,
          },
        },
      });
      continue;
    }
    snapshots.set(benchmark.symbolId, {
      data: null,
      meta: {
        dataMode: item?.status === "demo" ? "demo" : "live",
        mode: item?.status === "demo" ? "demo" : "live",
        providerCoverage: item?.status === "demo" ? "demo" : "partial",
        coverage: item?.status === "demo" ? "demo" : "partial",
        freshness: {
          state: item?.status === "demo" ? "fixture" : "unknown",
          asOf: null,
          ageSeconds: null,
        },
      },
    });
  }
  return snapshots;
}
