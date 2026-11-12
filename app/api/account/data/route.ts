import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  DATA_DELETION_CHALLENGE_COOKIE,
  dataDeletionChallengeCookie,
  isSameOriginMutation,
  parseAccountDataDeletionRequest,
  readCookie,
} from "@/lib/account-data";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { deleteSavedAccountData } from "@/lib/services/account-data-deletion";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function deleteAccountData(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);
  if (!isSameOriginMutation(request)) {
    return apiError("origin_required", "A same-origin request is required.", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }

  const parsed = parseAccountDataDeletionRequest(body);
  if (!parsed.success) {
    return apiError(
      "confirmation_required",
      "The deletion challenge and confirmation phrase are required.",
      400,
    );
  }
  const cookieChallenge = readCookie(
    request.headers.get("cookie"),
    DATA_DELETION_CHALLENGE_COOKIE,
  );
  if (!cookieChallenge || cookieChallenge !== parsed.data.challenge) {
    return apiError(
      "challenge_invalid",
      "The deletion challenge is missing or expired.",
      403,
    );
  }

  try {
    const data = await deleteSavedAccountData(user.userId);
    const headers = new Headers(noStore);
    headers.set(
      "Set-Cookie",
      dataDeletionChallengeCookie(request.url, "", 0),
    );
    return Response.json(
      {
        data,
        meta: {
          scope: "personal",
          identity: "authenticated",
          action: "erase_saved_data",
        },
      },
      { headers },
    );
  } catch {
    return apiError(
      "data_deletion_failed",
      "Saved Omnigaze data could not be erased.",
      503,
    );
  }
}

export const DELETE = instrumentApiRoute(
  { operation: "api.account.data.delete" },
  deleteAccountData,
);

