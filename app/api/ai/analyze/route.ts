import { z } from "zod";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  OmnigazeAiGuardError,
  omnigazeAiGuardErrorHeaders,
  omnigazeAiGuardResultHeaders,
} from "@/lib/ai/omnigaze-view-guard";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  generateOmnigazeView,
  OmnigazeViewError,
} from "@/lib/services/omnigaze-view";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

const requestSchema = z
  .object({
    symbol_id: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/),
    request_id: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
  })
  .strict();

async function postAnalysis(request: Request) {
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
      {
        error: "A canonical symbol such as NASDAQ:NVDA is required.",
        code: "invalid_request",
      },
      { status: 400, headers: noStore },
    );
  }

  const symbolId = parsed.data.symbol_id as CanonicalSymbol;

  try {
    const result = await generateOmnigazeView(symbolId, {
      ownerId: user.userId,
      requestId: parsed.data.request_id,
    });
    return Response.json(result, {
      headers: {
        ...noStore,
        ...omnigazeAiGuardResultHeaders({
          value: result,
          meta: result.meta.ai,
        }),
      },
    });
  } catch (error) {
    if (error instanceof OmnigazeViewError) {
      return Response.json(
        {
          error: error.message,
          code: error.code,
        },
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
          headers: {
            ...noStore,
            ...omnigazeAiGuardErrorHeaders(error),
          },
        },
      );
    }
    throw error;
  }
}

export const POST = instrumentApiRoute(
  {
    operation: "api.ai.analyze.post",
    slowMs: 30_000,
    unexpectedError: {
      code: "analysis_failed",
      message: "Analysis could not be completed.",
      status: 502,
    },
  },
  postAnalysis,
);
