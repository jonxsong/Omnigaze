import { z } from "zod";
import {
  analyzeEvidence,
  OMNIGAZE_ANALYSIS_PROMPT_VERSION,
} from "@/lib/ai/analyze-evidence";
import { buildAnalysisContextFromFeed } from "@/lib/ai/build-analysis-context";
import { workspaceBySymbol } from "@/lib/demo-market-data";
import type { CanonicalSymbol } from "@/lib/market-types";
import { liveMarketData } from "@/lib/services/live-market-data";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  symbol_id: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/),
});

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

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      {
        error: "A canonical symbol such as NASDAQ:NVDA is required.",
        code: "invalid_request",
      },
      { status: 400 },
    );
  }

  const symbolId = parsed.data.symbol_id as CanonicalSymbol;

  const workspace = workspaceBySymbol.get(symbolId);
  if (!workspace) return Response.json({ error: "Symbol not found." }, { status: 404 });

  try {
    const feed = await liveMarketData.getIntelligenceFeed({
      symbols: [symbolId],
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
      limit: 30,
    });
    const context = buildAnalysisContextFromFeed({
      instrument: workspace.instrument,
      items: feed.data,
      meta: feed.meta,
    });

    if (context.evidence.length === 0) {
      return Response.json(
        {
          error: "No recent evidence is available for analysis.",
          code: "insufficient_evidence",
        },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }

    const analysis = await analyzeEvidence(context);

    return Response.json({
      data: analysis,
      meta: {
        symbolId,
        dataCutoff: context.dataCutoff,
        generatedAt: new Date().toISOString(),
        promptVersion: OMNIGAZE_ANALYSIS_PROMPT_VERSION,
        dataMode: context.sourceMode,
        providerCoverage: context.sourceMeta.providerCoverage,
        freshness: context.sourceMeta.freshness,
        evidenceCount: context.evidence.length,
        eventCount: context.events.length,
        sources: [...new Set(feed.data.map((item) => item.source))],
        disclaimer: "Research support only. This is not investment advice.",
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error("Omnigaze analysis failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      {
        error: "Analysis could not be completed.",
        code: "analysis_failed",
        requestId,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
