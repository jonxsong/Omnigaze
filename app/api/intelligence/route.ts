import { getIntelligenceFeed, serviceMeta } from "@/lib/services/market-intelligence";
import type { CanonicalSymbol, Materiality } from "@/lib/market-types";

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

  const events = getIntelligenceFeed({
    symbolId: symbol,
    minimumMateriality,
    limit: Number.isFinite(requestedLimit) ? requestedLimit : 20,
  });

  return Response.json({ data: events, meta: serviceMeta });
}
