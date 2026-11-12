import { liveMarketData } from "@/lib/services/live-market-data";
import {
  checkDatabaseReadiness,
  type DatabaseReadiness,
} from "@/lib/services/database-readiness";

export const dynamic = "force-dynamic";

interface HealthDependencies {
  getProviderStatus: typeof liveMarketData.getProviderStatus;
  checkDatabaseReadiness: () => Promise<DatabaseReadiness>;
}

export function createHealthHandler(
  dependencies: HealthDependencies = {
    getProviderStatus: () => liveMarketData.getProviderStatus(),
    checkDatabaseReadiness,
  },
) {
  return async function healthHandler() {
    const [providerStatus, databaseReadiness] = await Promise.all([
      dependencies.getProviderStatus(),
      dependencies.checkDatabaseReadiness(),
    ]);
    const providerDegraded = providerStatus.providers.some(
      (provider) => provider.status === "degraded",
    );
    const status =
      providerDegraded || databaseReadiness.status !== "ready"
        ? "degraded"
        : "ok";

    return Response.json(
      {
        service: "omnigaze-web",
        status,
        version: "0.1.0",
        mode: "alpha",
        capabilities: [
          "personal-dashboard",
          "active-us-equity-search",
          "market-snapshots",
          "historical-bars",
          "news-and-sec-intelligence",
          "evidence-grounded-ai",
          "portfolio-v1",
          "deterministic-decision-scenarios",
          "durable-intelligence-inbox",
          "in-app-alert-rules",
          "mcp-2026-07-28",
        ],
        checkedAt: providerStatus.checkedAt,
        readiness: {
          database: databaseReadiness,
        },
        providers: providerStatus.providers,
        liveCapabilities: providerStatus.liveCapabilities,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };
}

export const GET = createHealthHandler();
