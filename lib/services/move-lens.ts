import {
  buildMoveLens,
  MOVE_LENS_EVIDENCE_WINDOW_HOURS,
  moveLensBenchmarks,
  type MoveLensResult,
  type MoveLensSnapshotInput,
} from "@/lib/move-lens";
import type { CanonicalSymbol } from "@/lib/market-types";
import { intelligenceReadPlane } from "@/lib/services/intelligence-read-plane";
import {
  liveMarketData,
  type IntelligenceFeedItem,
  type OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
  type ResolvedInstrument,
} from "@/lib/services/instrument-resolution";

export const MOVE_LENS_EVIDENCE_FETCH_LIMIT = 50;

export interface MoveLensDependencies {
  resolveInstrument(symbolId: CanonicalSymbol): Promise<ResolvedInstrument>;
  getSnapshots(
    symbols: CanonicalSymbol[],
  ): Promise<ReadonlyMap<CanonicalSymbol, MoveLensSnapshotInput>>;
  getIntelligence(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
    minimumMateriality: "low";
  }): Promise<OrchestratedIntelligenceFeed>;
  now(): Date;
}

const defaultDependencies: MoveLensDependencies = {
  resolveInstrument: resolveCanonicalInstrument,
  getSnapshots: (symbols) => liveMarketData.getSnapshots(symbols),
  getIntelligence: (options) =>
    intelligenceReadPlane.getIntelligenceFeed(options),
  now: () => new Date(),
};

function orderedSnapshotSymbols(selectedSymbolId: CanonicalSymbol) {
  return [
    ...new Set<CanonicalSymbol>([
      selectedSymbolId,
      ...moveLensBenchmarks.map((benchmark) => benchmark.symbolId),
    ]),
  ];
}

/**
 * Resolves the selected canonical identity before any provider read, then starts
 * one bounded snapshot batch and one unified evidence read concurrently.
 */
export async function getMoveLens(
  requestedSymbolId: CanonicalSymbol,
  dependencies: MoveLensDependencies = defaultDependencies,
): Promise<MoveLensResult> {
  const instrument = await dependencies.resolveInstrument(requestedSymbolId);
  if (instrument.id !== requestedSymbolId) {
    throw new InstrumentResolutionError("symbol_not_supported");
  }

  const evaluatedAt = dependencies.now();
  if (!Number.isFinite(evaluatedAt.getTime())) {
    throw new Error("invalid_move_lens_clock");
  }
  const symbols = orderedSnapshotSymbols(instrument.id);
  const since = new Date(
    evaluatedAt.getTime() -
      MOVE_LENS_EVIDENCE_WINDOW_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  const [snapshotResult, evidenceResult] = await Promise.allSettled([
    dependencies.getSnapshots(symbols),
    dependencies.getIntelligence({
      symbols: [instrument.id],
      since,
      limit: MOVE_LENS_EVIDENCE_FETCH_LIMIT,
      minimumMateriality: "low",
    }),
  ]);
  const snapshots: ReadonlyMap<CanonicalSymbol, MoveLensSnapshotInput> =
    snapshotResult.status === "fulfilled" ? snapshotResult.value : new Map();
  const evidenceReadVerified =
    evidenceResult.status === "fulfilled" &&
    evidenceResult.value.meta.dataMode === "live" &&
    evidenceResult.value.meta.mode === "live" &&
    evidenceResult.value.meta.providerCoverage !== "demo" &&
    evidenceResult.value.meta.coverage !== "demo";
  const evidence: readonly IntelligenceFeedItem[] = evidenceReadVerified
    ? evidenceResult.value.data
    : [];

  return buildMoveLens({
    selectedSymbolId: instrument.id,
    selectedSnapshot: snapshots.get(instrument.id),
    benchmarkSnapshots: snapshots,
    evidence,
    evidenceReadStatus: evidenceReadVerified ? "verified" : "unavailable",
    evaluatedAt: evaluatedAt.toISOString(),
  });
}
