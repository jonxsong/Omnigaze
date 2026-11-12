import { getChatGPTUser } from "@/app/chatgpt-auth";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { getUserPortfolio } from "@/lib/repositories/portfolio";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function getPortfolio() {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  try {
    return Response.json(
      {
        data: await getUserPortfolio(user.userId),
        meta: {
          scope: "personal",
          identity: "authenticated",
          persistence: "server",
          generatedAt: new Date().toISOString(),
        },
      },
      { headers: noStore },
    );
  } catch {
    return apiError(
      "portfolio_unavailable",
      "Portfolio is temporarily unavailable.",
      503,
    );
  }
}

export const GET = instrumentApiRoute(
  { operation: "api.portfolio.get" },
  getPortfolio,
);
