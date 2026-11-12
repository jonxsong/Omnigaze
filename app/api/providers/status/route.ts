import { liveMarketData } from "@/lib/services/live-market-data";
import { getIngestionReadiness } from "@/lib/services/ingestion-health";

export const dynamic = "force-dynamic";

export async function GET() {
  const [providerStatus, ingestion] = await Promise.all([
    liveMarketData.getProviderStatus(),
    getIngestionReadiness(),
  ]);
  return Response.json({ ...providerStatus, ingestion }, {
    headers: { "Cache-Control": "no-store" },
  });
}
