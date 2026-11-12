import { liveMarketData } from "@/lib/services/live-market-data";

export const dynamic = "force-dynamic";

export async function GET() {
  const providerStatus = await liveMarketData.getProviderStatus();
  const status = providerStatus.providers.some((provider) => provider.status === "degraded")
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
        "mcp-2026-07-28",
      ],
      checkedAt: providerStatus.checkedAt,
      providers: providerStatus.providers,
      liveCapabilities: providerStatus.liveCapabilities,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
