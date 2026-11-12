import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import type {
  OrchestratedSnapshot,
  OrchestrationMeta,
} from "@/lib/services/live-market-data";
import { liveMarketData } from "@/lib/services/live-market-data";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";

export const dynamic = "force-dynamic";

const MAX_BATCH_SYMBOLS = 12;
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const noStore = { "Cache-Control": "no-store" };

export type MarketSnapshotBatchItem =
  | {
      symbolId: CanonicalSymbol;
      status: "ready";
      data: MarketSnapshot;
      meta: OrchestrationMeta;
    }
  | {
      symbolId: CanonicalSymbol;
      status: "error";
      code:
        | "symbol_not_supported"
        | "asset_catalog_unavailable"
        | "symbol_resolution_failed"
        | "market_data_unavailable";
      error: string;
    };

export interface MarketSnapshotBatchResponse {
  data: MarketSnapshotBatchItem[];
  meta: {
    requestedCount: number;
    readyCount: number;
    errorCount: number;
    partial: boolean;
    generatedAt: string;
  };
}

type Dependencies = {
  resolveInstrument: typeof resolveCanonicalInstrument;
  getSnapshots: (
    symbols: CanonicalSymbol[],
  ) => Promise<ReadonlyMap<CanonicalSymbol, OrchestratedSnapshot>>;
  now: () => Date;
};

type ResolutionOutcome =
  | {
      kind: "verified";
      symbolId: CanonicalSymbol;
      verified: CanonicalSymbol;
    }
  | {
      kind: "error";
      symbolId: CanonicalSymbol;
      error: MarketSnapshotBatchItem;
    };

const defaultDependencies: Dependencies = {
  resolveInstrument: resolveCanonicalInstrument,
  getSnapshots: (symbols) => liveMarketData.getSnapshots(symbols),
  now: () => new Date(),
};

function apiError(code: string, error: string, status: number) {
  return Response.json({ code, error }, { status, headers: noStore });
}

function parseSymbols(request: Request) {
  const value = new URL(request.url).searchParams.get("symbols");
  if (!value) return null;

  const entries = value.split(",").map((symbol) => symbol.trim().toUpperCase());
  if (
    entries.length === 0 ||
    entries.length > MAX_BATCH_SYMBOLS ||
    entries.some(
      (symbol) =>
        !symbol || symbol.length > 64 || !canonicalSymbolPattern.test(symbol),
    )
  ) {
    return null;
  }

  return [...new Set(entries)] as CanonicalSymbol[];
}

function resolutionError(
  symbolId: CanonicalSymbol,
  error: unknown,
): MarketSnapshotBatchItem {
  if (error instanceof InstrumentResolutionError) {
    return {
      symbolId,
      status: "error",
      code: error.code,
      error:
        error.code === "symbol_not_supported"
          ? "Symbol is not supported."
          : "The asset catalog is temporarily unavailable.",
    };
  }
  return {
    symbolId,
    status: "error",
    code: "symbol_resolution_failed",
    error: "Symbol could not be verified.",
  };
}

export function createMarketSnapshotsHandler(
  dependencies: Dependencies = defaultDependencies,
) {
  return async function GET(request: Request) {
    const symbols = parseSymbols(request);
    if (!symbols) {
      return apiError(
        "invalid_symbols",
        `Provide 1 to ${MAX_BATCH_SYMBOLS} comma-separated canonical symbols such as NASDAQ:NVDA,NYSE:IBM.`,
        400,
      );
    }

    const resolved: ResolutionOutcome[] = await Promise.all(
      symbols.map(async (symbolId) => {
        try {
          const instrument = await dependencies.resolveInstrument(symbolId);
          if (instrument.id !== symbolId) {
            throw new InstrumentResolutionError("symbol_not_supported");
          }
          return {
            kind: "verified" as const,
            symbolId,
            verified: instrument.id,
          };
        } catch (error) {
          return {
            kind: "error" as const,
            symbolId,
            error: resolutionError(symbolId, error),
          };
        }
      }),
    );

    const verifiedSymbols = resolved.flatMap((entry) =>
      entry.kind === "verified" ? [entry.verified] : [],
    );
    let snapshots: ReadonlyMap<CanonicalSymbol, OrchestratedSnapshot> = new Map();
    let batchFailed = false;
    if (verifiedSymbols.length > 0) {
      try {
        snapshots = await dependencies.getSnapshots(verifiedSymbols);
      } catch {
        batchFailed = true;
      }
    }

    const items = resolved.map((entry): MarketSnapshotBatchItem => {
      if (entry.kind === "error") return entry.error;
      const result = snapshots.get(entry.verified);
      if (
        batchFailed ||
        !result?.data ||
        result.data.symbolId !== entry.verified
      ) {
        return {
          symbolId: entry.symbolId,
          status: "error",
          code: "market_data_unavailable",
          error: "Market data is unavailable for this symbol.",
        };
      }
      return {
        symbolId: entry.symbolId,
        status: "ready",
        data: result.data,
        meta: result.meta,
      };
    });
    const readyCount = items.filter((item) => item.status === "ready").length;
    const errorCount = items.length - readyCount;
    const response: MarketSnapshotBatchResponse = {
      data: items,
      meta: {
        requestedCount: symbols.length,
        readyCount,
        errorCount,
        partial: errorCount > 0,
        generatedAt: dependencies.now().toISOString(),
      },
    };

    return Response.json(response, { headers: noStore });
  };
}

export const GET = createMarketSnapshotsHandler();
