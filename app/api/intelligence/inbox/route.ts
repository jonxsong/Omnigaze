import { getChatGPTUser } from "@/app/chatgpt-auth";
import { parseInboxQuery } from "@/lib/intelligence-inbox/contracts";
import { getIntelligenceInbox } from "@/lib/intelligence-inbox/service";
import { unexpectedApiError } from "@/lib/unexpected-failure";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  const query = parseInboxQuery(new URL(request.url).searchParams);
  if (!query.success) {
    return apiError("invalid_query", "Inbox query is invalid.", 400);
  }

  try {
    return Response.json(
      await getIntelligenceInbox(user.userId, query.data),
      { headers: noStore },
    );
  } catch (failure) {
    return unexpectedApiError({
      operation: "intelligence_inbox.list",
      failure,
      code: "inbox_unavailable",
      message: "The intelligence inbox is temporarily unavailable.",
      status: 503,
    });
  }
}
