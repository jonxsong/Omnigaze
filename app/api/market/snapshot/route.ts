import { getMarketSnapshot, serviceMeta } from "@/lib/services/market-intelligence";
import type { CanonicalSymbol } from "@/lib/market-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  if (!symbol || !symbol.includes(":")) {
    return Response.json(
      { error: "A canonical symbol such as NASDAQ:NVDA is required." },
      { status: 400 },
    );
  }

  const snapshot = getMarketSnapshot(symbol as CanonicalSymbol);
  if (!snapshot) return Response.json({ error: "Symbol not found." }, { status: 404 });

  return Response.json({ data: snapshot, meta: serviceMeta });
}
