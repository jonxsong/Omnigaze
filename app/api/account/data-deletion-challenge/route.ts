import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  DATA_DELETION_CHALLENGE_TTL_SECONDS,
  DATA_DELETION_CONFIRMATION,
  dataDeletionChallengeCookie,
  isSameOriginMutation,
} from "@/lib/account-data";
import { instrumentApiRoute } from "@/lib/api-telemetry";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function createDataDeletionChallenge(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);
  if (!isSameOriginMutation(request)) {
    return apiError("origin_required", "A same-origin request is required.", 403);
  }

  const challenge = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + DATA_DELETION_CHALLENGE_TTL_SECONDS * 1_000,
  ).toISOString();
  const headers = new Headers(noStore);
  headers.set(
    "Set-Cookie",
    dataDeletionChallengeCookie(request.url, challenge),
  );

  return Response.json(
    {
      data: {
        challenge,
        confirmationPhrase: DATA_DELETION_CONFIRMATION,
        expiresAt,
      },
      meta: {
        scope: "personal",
        identity: "authenticated",
        action: "erase_saved_data",
      },
    },
    { headers },
  );
}

export const POST = instrumentApiRoute(
  { operation: "api.account.data_challenge.post" },
  createDataDeletionChallenge,
);

