import { liveMarketData } from "@/lib/services/live-market-data";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import {
  checkDatabaseReadiness,
  type DatabaseReadiness,
} from "@/lib/services/database-readiness";
import {
  getIngestionReadiness,
  type IngestionReadiness,
} from "@/lib/services/ingestion-health";

export const dynamic = "force-dynamic";

interface HealthDependencies {
  getProviderStatus: typeof liveMarketData.getProviderStatus;
  checkDatabaseReadiness: () => Promise<DatabaseReadiness>;
  getIngestionReadiness: () => Promise<IngestionReadiness>;
}

export function createHealthHandler(
  dependencies: HealthDependencies = {
    getProviderStatus: () => liveMarketData.getProviderStatus(),
    checkDatabaseReadiness,
    getIngestionReadiness,
  },
) {
  return async function healthHandler() {
    const [providerStatus, databaseReadiness, ingestionReadiness] = await Promise.all([
      dependencies.getProviderStatus(),
      dependencies.checkDatabaseReadiness(),
      dependencies.getIngestionReadiness(),
    ]);
    const providerDegraded = providerStatus.providers.some(
      (provider) => provider.status === "degraded",
    );
    const status =
      providerDegraded ||
      databaseReadiness.status !== "ready" ||
      ["degraded", "delayed", "unavailable"].includes(
        ingestionReadiness.status,
      )
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
          "market-news-intelligence",
          "unified-intelligence-read-plane-v1",
          ...(providerStatus.liveCapabilities.includes("sec-filings")
            ? ["sec-filing-intelligence"]
            : []),
          "evidence-grounded-ai",
          "portfolio-v1",
          "portfolio-pulse-v1",
          "deterministic-decision-scenarios",
          "durable-intelligence-inbox",
          "bounded-cursor-ingestion",
          "durable-owner-projection-cursor-v1",
          "in-app-alert-rules",
          ...(ingestionReadiness.mode === "scheduled"
            ? ["scheduled-cursor-ingestion"]
            : []),
          "mcp-2026-07-28",
          "mcp-personal-state-writes-v1",
        ],
        checkedAt: providerStatus.checkedAt,
        readiness: {
          database: databaseReadiness,
          ingestion: ingestionReadiness,
        },
        providers: providerStatus.providers,
        liveCapabilities: providerStatus.liveCapabilities,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };
}

export const GET = instrumentApiRoute(
  { operation: "api.health.get", slowMs: 500 },
  createHealthHandler(),
);
