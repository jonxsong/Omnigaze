import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  accountDataExportFilename,
  parseAccountDataExportRequest,
} from "@/lib/account-data-export";
import { isSameOriginMutation } from "@/lib/account-data";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { buildAccountSavedDataSnapshot } from "@/lib/services/account-data-export";

export const dynamic = "force-dynamic";

function responseHeaders() {
  return new Headers({
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
}

function apiError(code: string, error: string, status: number) {
  return Response.json(
    { error, code },
    { status, headers: responseHeaders() },
  );
}

function isJsonRequest(request: Request) {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

async function exportAccountData(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);
  if (!isSameOriginMutation(request)) {
    return apiError("origin_required", "A same-origin request is required.", 403);
  }
  if (!isJsonRequest(request)) {
    return apiError(
      "json_content_type_required",
      "Content-Type must be application/json.",
      415,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }
  const parsed = parseAccountDataExportRequest(body);
  if (!parsed.success) {
    return apiError(
      "invalid_export_request",
      "Request body must contain only the supported JSON export format.",
      400,
    );
  }

  try {
    const snapshot = await buildAccountSavedDataSnapshot(user.userId);
    const headers = responseHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set(
      "Content-Disposition",
      `attachment; filename="${accountDataExportFilename(snapshot.exportedAt)}"`,
    );
    return new Response(JSON.stringify(snapshot, null, 2), { headers });
  } catch {
    return apiError(
      "data_export_failed",
      "Your Omnigaze saved-data snapshot could not be created.",
      503,
    );
  }
}

export const POST = instrumentApiRoute(
  { operation: "api.account.data_export.post" },
  exportAccountData,
);
