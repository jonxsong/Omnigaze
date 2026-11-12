import type { CanonicalSymbol } from "@/lib/market-types";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { getMoveLens } from "@/lib/services/move-lens";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";

export const dynamic = "force-dynamic";

const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const noStore = { "Cache-Control": "no-store" };

type MoveLensReader = typeof getMoveLens;

function apiError(code: string, error: string, status: number) {
  return Response.json({ code, error }, { status, headers: noStore });
}

function parseSymbol(request: Request) {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll("symbol");
  if (
    keys.some((key) => key !== "symbol") ||
    values.length !== 1 ||
    values[0].trim().length > 64
  ) {
    return null;
  }
  const symbol = values[0].trim().toUpperCase();
  return canonicalSymbolPattern.test(symbol)
    ? (symbol as CanonicalSymbol)
    : null;
}

export function createMoveLensHandler(
  readMoveLens: MoveLensReader = getMoveLens,
) {
  return async function getMoveLensHandler(request: Request) {
    const symbolId = parseSymbol(request);
    if (!symbolId) {
      return apiError(
        "invalid_symbol",
        "A single canonical symbol such as NASDAQ:NVDA is required.",
        400,
      );
    }

    try {
      return Response.json(await readMoveLens(symbolId), { headers: noStore });
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
      return apiError(
        "move_lens_unavailable",
        "Move Lens is temporarily unavailable.",
        503,
      );
    }
  };
}

export const GET = instrumentApiRoute(
  { operation: "api.market.move_lens.get", slowMs: 5_000 },
  createMoveLensHandler(),
);
