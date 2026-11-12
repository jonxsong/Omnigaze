import { liveMarketData } from "@/lib/services/live-market-data";
import { getIngestionReadiness } from "@/lib/services/ingestion-health";
import { getProjectionReadiness } from "@/lib/services/projection-health";
import { instrumentApiRoute } from "@/lib/api-telemetry";

export const dynamic = "force-dynamic";

async function getProviderStatus() {
  const [providerStatus, ingestion, projection] = await Promise.all([
    liveMarketData.getProviderStatus(),
    getIngestionReadiness(),
    getProjectionReadiness(),
  ]);
  return Response.json({ ...providerStatus, ingestion, projection }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export const GET = instrumentApiRoute(
  { operation: "api.providers.status.get", slowMs: 3_000 },
  getProviderStatus,
);
