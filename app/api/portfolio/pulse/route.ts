import { getChatGPTUser } from "@/app/chatgpt-auth";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { getPortfolioPulse } from "@/lib/services/portfolio-pulse";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

type PortfolioPulseRouteDependencies = {
  getUser: typeof getChatGPTUser;
  getPulse: typeof getPortfolioPulse;
  now: () => Date;
};

const defaultDependencies: PortfolioPulseRouteDependencies = {
  getUser: getChatGPTUser,
  getPulse: getPortfolioPulse,
  now: () => new Date(),
};

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

export function createPortfolioPulseHandler(
  dependencies: PortfolioPulseRouteDependencies = defaultDependencies,
) {
  return async function getPortfolioPulseRoute() {
    const user = await dependencies.getUser();
    if (!user) {
      return apiError("auth_required", "Authentication required.", 401);
    }

    try {
      const pulse = await dependencies.getPulse(user.userId);
      return Response.json(
        {
          data: pulse,
          meta: {
            scope: "personal",
            identity: "authenticated",
            purpose: "portfolio_pulse",
            tradeExecutionAllowed: false,
            generatedAt: pulse.calculatedAt,
          },
        },
        { headers: noStore },
      );
    } catch {
      return apiError(
        "portfolio_pulse_unavailable",
        "Portfolio pulse is temporarily unavailable.",
        503,
      );
    }
  };
}

export const GET = instrumentApiRoute(
  { operation: "api.portfolio.pulse.get", slowMs: 5_000 },
  createPortfolioPulseHandler(),
);
