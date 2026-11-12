import { analyzeEvidence } from "@/lib/ai/analyze-evidence";
import { workspaceBySymbol } from "@/lib/demo-market-data";
import type { CanonicalSymbol } from "@/lib/market-types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      {
        error: "AI analysis is not configured in this environment.",
        code: "ai_unconfigured",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    symbol_id?: string;
  } | null;
  const symbolId = body?.symbol_id?.toUpperCase() as CanonicalSymbol | undefined;
  if (!symbolId) {
    return Response.json({ error: "symbol_id is required." }, { status: 400 });
  }

  const workspace = workspaceBySymbol.get(symbolId);
  if (!workspace) return Response.json({ error: "Symbol not found." }, { status: 404 });

  try {
    const analysis = await analyzeEvidence({
      instrument: workspace.instrument,
      evidence: workspace.evidence,
      events: workspace.events,
      dataCutoff: workspace.view.dataCutoff,
    });

    return Response.json({
      data: analysis,
      meta: {
        symbolId,
        dataCutoff: workspace.view.dataCutoff,
        generatedAt: new Date().toISOString(),
        disclaimer: "Research support only. This is not investment advice.",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: "Analysis could not be completed.",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
}
