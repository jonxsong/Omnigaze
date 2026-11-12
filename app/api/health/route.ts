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
      mode: "foundation",
      capabilities: ["dashboard", "market-provider-boundary", "mcp-2026-07-28"],
      checkedAt: providerStatus.checkedAt,
      providers: providerStatus.providers,
      liveCapabilities: providerStatus.liveCapabilities,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
