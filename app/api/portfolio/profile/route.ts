import { getChatGPTUser } from "@/app/chatgpt-auth";
import { parsePortfolioProfileMutation } from "@/lib/portfolio/contracts";
import {
  PortfolioRepositoryError,
  putPortfolioProfile,
} from "@/lib/repositories/portfolio";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }

  const parsed = parsePortfolioProfileMutation(body);
  if (!parsed.success) {
    return apiError("invalid_request", "Portfolio profile is invalid.", 400);
  }

  try {
    return Response.json(
      {
        data: await putPortfolioProfile(user.userId, parsed.data),
        meta: {
          scope: "personal",
          identity: "authenticated",
          persistence: "server",
        },
      },
      { headers: noStore },
    );
  } catch (error) {
    if (
      error instanceof PortfolioRepositoryError &&
      error.code === "profile_version_conflict"
    ) {
      return apiError(
        "version_conflict",
        "Portfolio profile changed. Refresh before saving again.",
        409,
      );
    }
    return apiError(
      "profile_update_failed",
      "Portfolio profile could not be updated.",
      500,
    );
  }
}
