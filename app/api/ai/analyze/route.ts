import { z } from "zod";
import { getChatGPTUser } from "@/app/chatgpt-auth";
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
  })
  .strict();

export async function POST(request: Request) {
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
    const result = await generateOmnigazeView(symbolId);
    return Response.json(result, { headers: noStore });
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
    const requestId = crypto.randomUUID();
    console.error("Omnigaze analysis failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      {
        error: "Analysis could not be completed.",
        code: "analysis_failed",
        requestId,
      },
      { status: 502, headers: noStore },
    );
  }
}
