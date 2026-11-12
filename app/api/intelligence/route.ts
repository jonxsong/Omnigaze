import type { CanonicalSymbol, Materiality } from "@/lib/market-types";
import { liveMarketData } from "@/lib/services/live-market-data";

export const dynamic = "force-dynamic";

const materialities = new Set<Materiality>(["low", "medium", "high", "critical"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = params.get("symbol")?.toUpperCase() as CanonicalSymbol | undefined;
  const requestedMateriality = params.get("minimum_materiality") as Materiality | null;
  const minimumMateriality =
    requestedMateriality && materialities.has(requestedMateriality)
      ? requestedMateriality
      : "low";
  const requestedLimit = Number(params.get("limit") ?? 20);
  const since = params.get("since") ?? new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

  const result = await liveMarketData.getIntelligenceFeed({
    symbols: symbol ? [symbol] : undefined,
    since,
    minimumMateriality,
    limit: Number.isFinite(requestedLimit) ? requestedLimit : 20,
  });

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
