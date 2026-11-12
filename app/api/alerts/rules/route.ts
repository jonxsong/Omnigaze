import { getChatGPTUser } from "@/app/chatgpt-auth";
import { parseEmptyInboxQuery } from "@/lib/intelligence-inbox/contracts";
import { getAlertRules } from "@/lib/intelligence-inbox/service";
import { unexpectedApiError } from "@/lib/unexpected-failure";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

export async function GET(request?: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);
  if (
    request &&
    !parseEmptyInboxQuery(new URL(request.url).searchParams).success
  ) {
    return apiError("invalid_query", "Alert-rules query is invalid.", 400);
  }

  try {
    return Response.json(await getAlertRules(user.userId), { headers: noStore });
  } catch (failure) {
    return unexpectedApiError({
      operation: "alert_rules.list",
      failure,
      code: "alert_rules_unavailable",
      message: "Alert rules are temporarily unavailable.",
      status: 503,
    });
  }
}
