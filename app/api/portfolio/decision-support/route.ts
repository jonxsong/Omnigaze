import { getChatGPTUser } from "@/app/chatgpt-auth";
import { parsePortfolioDecisionSupportRequest } from "@/lib/portfolio/contracts";
import { getPortfolioDecisionSupport } from "@/lib/services/portfolio-decision-support";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }
  const parsed = parsePortfolioDecisionSupportRequest(body);
  if (!parsed.success) {
    return apiError("invalid_request", "Decision-support request is invalid.", 400);
  }

  try {
    return Response.json(
      {
        data: await getPortfolioDecisionSupport(
          user.userId,
          parsed.data,
        ),
        meta: {
          scope: "personal",
          identity: "authenticated",
          purpose: "research_scenarios",
          tradeExecutionAllowed: false,
          generatedAt: new Date().toISOString(),
        },
      },
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof InstrumentResolutionError) {
      if (error.code === "symbol_not_supported") {
        return apiError("symbol_not_supported", "Symbol is not supported.", 422);
      }
      return apiError(
        "asset_catalog_unavailable",
        "The asset catalog is temporarily unavailable.",
        503,
      );
    }
    return apiError(
      "decision_support_unavailable",
      "Decision support is temporarily unavailable.",
      503,
    );
  }
}
