export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    service: "omnigaze-web",
    status: "ok",
    version: "0.1.0",
    mode: "foundation",
    capabilities: ["dashboard", "market-provider-boundary", "mcp-2026-07-28"],
    checkedAt: new Date().toISOString(),
  });
}
