import type { CanonicalSymbol } from "@/lib/market-types";
import { liveMarketData } from "@/lib/services/live-market-data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  if (!symbol || !symbol.includes(":")) {
    return Response.json(
      { error: "A canonical symbol such as NASDAQ:NVDA is required." },
      { status: 400 },
    );
  }

  const result = await liveMarketData.getSnapshot(symbol as CanonicalSymbol);
  if (!result.data) {
    return Response.json(
      {
        error: "Market data is unavailable for this symbol.",
        meta: result.meta,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
