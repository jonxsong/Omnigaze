import { instrumentApiRoute } from "@/lib/api-telemetry";
import { getMarketContext } from "@/lib/services/market-context";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

type MarketContextReader = typeof getMarketContext;

export function createMarketContextHandler(
  readMarketContext: MarketContextReader = getMarketContext,
) {
  return async function getMarketContextHandler() {
    try {
      return Response.json(await readMarketContext(), { headers: noStore });
    } catch {
      return Response.json(
        {
          code: "market_context_unavailable",
          error: "Market context is temporarily unavailable.",
        },
        { status: 503, headers: noStore },
      );
    }
  };
}

export const GET = instrumentApiRoute(
  { operation: "api.market.context.get", slowMs: 3_000 },
  createMarketContextHandler(),
);

