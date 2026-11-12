import { getChatGPTUser } from "@/app/chatgpt-auth";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import {
  canonicalInboxSymbolSchema,
  parseEmptyInboxQuery,
  parseAlertRuleMutation,
} from "@/lib/intelligence-inbox/contracts";
import { InboxRepositoryError } from "@/lib/intelligence-inbox/repository";
import { putAlertRule } from "@/lib/intelligence-inbox/service";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

type RouteContext = { params: Promise<{ symbol: string }> };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function parseSymbol(context: RouteContext) {
  const { symbol } = await context.params;
  try {
    return canonicalInboxSymbolSchema.safeParse(decodeURIComponent(symbol));
  } catch {
    return { success: false as const };
  }
}

async function putAlertRuleHandler(request: Request, context: RouteContext) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  const symbol = await parseSymbol(context);
  if (!symbol.success) {
    return apiError(
      "invalid_symbol",
      "A canonical symbol such as NASDAQ:NVDA is required.",
      400,
    );
  }
  if (!parseEmptyInboxQuery(new URL(request.url).searchParams).success) {
    return apiError("invalid_query", "Alert-rule query is invalid.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }
  const mutation = parseAlertRuleMutation(body);
  if (!mutation.success) {
    return apiError("invalid_request", "Alert rule request is invalid.", 400);
  }

  try {
    return Response.json(
      await putAlertRule(user.userId, symbol.data, mutation.data),
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof InboxRepositoryError) {
      return error.code === "not_found"
        ? apiError("alert_rule_not_found", "Tracked symbol not found.", 404)
        : apiError(
            "version_conflict",
            "Alert rule changed. Refresh before saving again.",
            409,
          );
    }
    throw error;
  }
}

export const PUT = instrumentApiRoute(
  {
    operation: "api.alert_rules.put",
    unexpectedError: {
      code: "alert_rule_update_failed",
      message: "Alert rule could not be updated.",
      status: 500,
    },
  },
  putAlertRuleHandler,
);
