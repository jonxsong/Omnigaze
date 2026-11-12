import type { CanonicalSymbol, Materiality } from "@/lib/market-types";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { intelligenceReadPlane } from "@/lib/services/intelligence-read-plane";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";

export const dynamic = "force-dynamic";

const materialities = new Set<Materiality>(["low", "medium", "high", "critical"]);
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ code, error }, { status, headers: noStore });
}

async function getIntelligence(request: Request) {
  const params = new URL(request.url).searchParams;
  const requestedSymbol = params.get("symbol")?.trim().toUpperCase();
  const requestedMateriality = params.get("minimum_materiality") as Materiality | null;
  const minimumMateriality =
    requestedMateriality && materialities.has(requestedMateriality)
      ? requestedMateriality
      : "low";
  const requestedLimit = Number(params.get("limit") ?? 20);
  const since = params.get("since") ?? new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

  let symbol: CanonicalSymbol | undefined;
  if (requestedSymbol) {
    if (!canonicalSymbolPattern.test(requestedSymbol)) {
      return apiError(
        "invalid_symbol",
        "A canonical symbol such as NASDAQ:NVDA is required.",
        400,
      );
    }
    try {
      symbol = (
        await resolveCanonicalInstrument(requestedSymbol as CanonicalSymbol)
      ).id;
    } catch (error) {
      if (error instanceof InstrumentResolutionError) {
        return error.code === "symbol_not_supported"
          ? apiError("symbol_not_supported", "Symbol is not supported.", 422)
          : apiError(
              "asset_catalog_unavailable",
              "The asset catalog is temporarily unavailable.",
              503,
            );
      }
      return apiError("symbol_resolution_failed", "Symbol could not be verified.", 503);
    }
  }

  const result = await intelligenceReadPlane.getIntelligenceFeed({
    symbols: symbol ? [symbol] : undefined,
    since,
    minimumMateriality,
    limit: Number.isFinite(requestedLimit) ? requestedLimit : 20,
  });

  return Response.json(
    symbol
      ? {
          ...result,
          data: result.data.filter((item) => item.symbolIds.includes(symbol!)),
        }
      : result,
    { headers: noStore },
  );
}

export const GET = instrumentApiRoute(
  { operation: "api.intelligence.get", slowMs: 5_000 },
  getIntelligence,
);
