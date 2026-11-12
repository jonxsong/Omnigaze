import { liveMarketData } from "@/lib/services/live-market-data";
import { getIngestionReadiness } from "@/lib/services/ingestion-health";
import { instrumentApiRoute } from "@/lib/api-telemetry";

export const dynamic = "force-dynamic";

async function getProviderStatus() {
  const [providerStatus, ingestion] = await Promise.all([
    liveMarketData.getProviderStatus(),
    getIngestionReadiness(),
  ]);
  return Response.json({ ...providerStatus, ingestion }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export const GET = instrumentApiRoute(
  { operation: "api.providers.status.get", slowMs: 3_000 },
  getProviderStatus,
);
