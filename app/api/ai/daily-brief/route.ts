import { z } from "zod";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  OmnigazeAiGuardError,
  omnigazeAiGuardErrorHeaders,
} from "@/lib/ai/omnigaze-view-guard";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import {
  DailyBriefServiceError,
  generatePersonalDailyBrief,
} from "@/lib/services/personal-daily-brief";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const requestSchema = z
  .object({
    request_id: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
  })
  .strict();

function resultHeaders(result: Awaited<ReturnType<typeof generatePersonalDailyBrief>>) {
  const headers: Record<string, string> = {
    ...noStore,
    "X-Omnigaze-AI-Cache": result.meta.cache.state === "hit" ? "hit" : "miss",
    "X-Omnigaze-AI-Deduplicated": String(
      result.meta.cache.state === "deduplicated",
    ),
    "X-Omnigaze-AI-Budget-Charged": String(result.meta.budget.consumed),
  };
  if (result.meta.budget.consumed) {
    headers["X-Omnigaze-AI-Budget-Remaining"] = String(
      result.meta.budget.remaining,
    );
    headers["X-Omnigaze-AI-Budget-Limit"] = String(result.meta.budget.limit);
    headers["X-Omnigaze-AI-Budget-Reset"] = result.meta.budget.resetsAt;
  }
  return headers;
}

async function postDailyBrief(request: Request) {
  const user = await getChatGPTUser();
  if (!user) {
    return Response.json(
      { error: "Authentication required.", code: "auth_required" },
      { status: 401, headers: noStore },
    );
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "The Daily Brief request is invalid.", code: "invalid_request" },
      { status: 400, headers: noStore },
    );
  }

  try {
    const result = await generatePersonalDailyBrief(user.userId, {
      requestId: parsed.data.request_id,
    });
    return Response.json(result, { headers: resultHeaders(result) });
  } catch (error) {
    if (error instanceof DailyBriefServiceError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: noStore },
      );
    }
    if (error instanceof OmnigazeAiGuardError) {
      return Response.json(
        {
          error: error.message,
          code: error.code,
          ...(error.retryAt ? { retryAt: error.retryAt } : {}),
          ...(error.retryAfterSeconds
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
          ...(error.budgetReason ? { budgetReason: error.budgetReason } : {}),
        },
        {
          status: error.status,
          headers: { ...noStore, ...omnigazeAiGuardErrorHeaders(error) },
        },
      );
    }
    throw error;
  }
}

export const POST = instrumentApiRoute(
  {
    operation: "api.ai.daily_brief.post",
    slowMs: 30_000,
    unexpectedError: {
      code: "analysis_failed",
      message: "The Daily Brief could not be completed.",
      status: 502,
    },
  },
  postDailyBrief,
);
