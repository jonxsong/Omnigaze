import { getChatGPTUser } from "@/app/chatgpt-auth";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { parseEmptyInboxQuery } from "@/lib/intelligence-inbox/contracts";
import { getAlertRules } from "@/lib/intelligence-inbox/service";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function getAlertRulesHandler(request?: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);
  if (
    request &&
    !parseEmptyInboxQuery(new URL(request.url).searchParams).success
  ) {
    return apiError("invalid_query", "Alert-rules query is invalid.", 400);
  }

  return Response.json(await getAlertRules(user.userId), { headers: noStore });
}

export const GET = instrumentApiRoute(
  {
    operation: "api.alert_rules.get",
    unexpectedError: {
      code: "alert_rules_unavailable",
      message: "Alert rules are temporarily unavailable.",
      status: 503,
    },
  },
  getAlertRulesHandler,
);
