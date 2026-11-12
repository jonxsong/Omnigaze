import { liveMarketData } from "@/lib/services/live-market-data";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await liveMarketData.getProviderStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
