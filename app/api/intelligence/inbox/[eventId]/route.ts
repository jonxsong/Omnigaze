import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  inboxEventIdSchema,
  parseEmptyInboxQuery,
  parseInboxStateMutation,
} from "@/lib/intelligence-inbox/contracts";
import { InboxRepositoryError } from "@/lib/intelligence-inbox/repository";
import {
  getIntelligenceInboxItem,
  updateIntelligenceInboxState,
} from "@/lib/intelligence-inbox/service";
import { unexpectedApiError } from "@/lib/unexpected-failure";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

type RouteContext = { params: Promise<{ eventId: string }> };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function parseEventId(context: RouteContext) {
  const { eventId } = await context.params;
  try {
    return inboxEventIdSchema.safeParse(decodeURIComponent(eventId));
  } catch {
    return { success: false as const };
  }
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  const eventId = await parseEventId(context);
  if (!eventId.success) {
    return apiError("invalid_event_id", "Event identifier is invalid.", 400);
  }
  if (!parseEmptyInboxQuery(new URL(request.url).searchParams).success) {
    return apiError("invalid_query", "Inbox item query is invalid.", 400);
  }

  try {
    return Response.json(
      await getIntelligenceInboxItem(user.userId, eventId.data),
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof InboxRepositoryError && error.code === "not_found") {
      return apiError("inbox_item_not_found", "Inbox item not found.", 404);
    }
    return unexpectedApiError({
      operation: "intelligence_inbox.item_read",
      failure: error,
      code: "inbox_item_unavailable",
      message: "Inbox item could not be loaded.",
      status: 503,
    });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  const eventId = await parseEventId(context);
  if (!eventId.success) {
    return apiError("invalid_event_id", "Event identifier is invalid.", 400);
  }
  if (!parseEmptyInboxQuery(new URL(request.url).searchParams).success) {
    return apiError("invalid_query", "Inbox state query is invalid.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }
  const mutation = parseInboxStateMutation(body);
  if (!mutation.success) {
    return apiError("invalid_request", "Inbox state request is invalid.", 400);
  }

  try {
    return Response.json(
      await updateIntelligenceInboxState(
        user.userId,
        eventId.data,
        mutation.data,
      ),
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof InboxRepositoryError) {
      return error.code === "not_found"
        ? apiError("inbox_item_not_found", "Inbox item not found.", 404)
        : apiError(
            "version_conflict",
            "Inbox item changed. Refresh before saving again.",
            409,
          );
    }
    return unexpectedApiError({
      operation: "intelligence_inbox.state_update",
      failure: error,
      code: "inbox_update_failed",
      message: "Inbox item could not be updated.",
      status: 500,
    });
  }
}
