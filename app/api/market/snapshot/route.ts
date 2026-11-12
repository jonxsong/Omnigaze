import type { CanonicalSymbol } from "@/lib/market-types";
import { liveMarketData } from "@/lib/services/live-market-data";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";

export const dynamic = "force-dynamic";

const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ code, error }, { status, headers: noStore });
}

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  if (!symbol || !canonicalSymbolPattern.test(symbol)) {
    return apiError(
      "invalid_symbol",
      "A canonical symbol such as NASDAQ:NVDA is required.",
      400,
    );
  }

  let verifiedSymbol: CanonicalSymbol;
  try {
    verifiedSymbol = (await resolveCanonicalInstrument(symbol as CanonicalSymbol)).id;
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

  const result = await liveMarketData.getSnapshot(verifiedSymbol);
  if (!result.data || result.data.symbolId !== verifiedSymbol) {
    return Response.json(
      {
        error: "Market data is unavailable for this symbol.",
        code: "market_data_unavailable",
        meta: result.meta,
      },
      { status: 503, headers: noStore },
    );
  }

  return Response.json(result, { headers: noStore });
}
