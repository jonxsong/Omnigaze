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
import {
  getProjectionReadiness,
  type ProjectionReadiness,
} from "@/lib/services/projection-health";

export const dynamic = "force-dynamic";

interface HealthDependencies {
  getProviderStatus: typeof liveMarketData.getProviderStatus;
  checkDatabaseReadiness: () => Promise<DatabaseReadiness>;
  getIngestionReadiness: () => Promise<IngestionReadiness>;
  getProjectionReadiness: () => Promise<ProjectionReadiness>;
}

export function createHealthHandler(
  dependencies: HealthDependencies = {
    getProviderStatus: () => liveMarketData.getProviderStatus(),
    checkDatabaseReadiness,
    getIngestionReadiness,
    getProjectionReadiness,
  },
) {
  return async function healthHandler() {
    const [
      providerStatus,
      databaseReadiness,
      ingestionReadiness,
      projectionReadiness,
    ] = await Promise.all([
      dependencies.getProviderStatus(),
      dependencies.checkDatabaseReadiness(),
      dependencies.getIngestionReadiness(),
      dependencies.getProjectionReadiness(),
    ]);
    const providerDegraded = providerStatus.providers.some(
      (provider) => provider.status === "degraded",
    );
    const status =
      providerDegraded ||
      databaseReadiness.status !== "ready" ||
      ["degraded", "delayed", "unavailable"].includes(
        ingestionReadiness.status,
      ) ||
      ["degraded", "delayed", "unavailable"].includes(
        projectionReadiness.status,
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
          "live-market-context-etf-proxies-v1",
          "deterministic-move-lens-v1",
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
          ...(projectionReadiness.mode === "scheduled"
            ? ["scheduled-owner-projection"]
            : []),
          "mcp-2026-07-28",
          "mcp-personal-state-writes-v1",
        ],
        checkedAt: providerStatus.checkedAt,
        readiness: {
          database: databaseReadiness,
          ingestion: ingestionReadiness,
          projection: projectionReadiness,
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
