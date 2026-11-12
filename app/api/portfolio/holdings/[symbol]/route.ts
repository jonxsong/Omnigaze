import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  parsePortfolioHoldingDeleteQuery,
  parsePortfolioHoldingMutation,
  portfolioCanonicalSymbolSchema,
} from "@/lib/portfolio/contracts";
import {
  deletePortfolioHolding,
  PortfolioRepositoryError,
  putPortfolioHolding,
} from "@/lib/repositories/portfolio";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

type RouteContext = {
  params: Promise<{ symbol: string }>;
};

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function parseSymbol(context: RouteContext) {
  const { symbol } = await context.params;
  let decoded = symbol;
  try {
    decoded = decodeURIComponent(symbol);
  } catch {
    return { success: false as const };
  }
  return portfolioCanonicalSymbolSchema.safeParse(decoded);
}

function repositoryError(error: PortfolioRepositoryError) {
  switch (error.code) {
    case "asset_catalog_unavailable":
      return apiError(
        "asset_catalog_unavailable",
        "The asset catalog is temporarily unavailable.",
        503,
      );
    case "holding_not_found":
      return apiError("holding_not_found", "Holding not found.", 404);
    case "symbol_not_supported":
      return apiError("symbol_not_supported", "Symbol is not supported.", 422);
    case "holding_version_conflict":
      return apiError(
        "version_conflict",
        "Holding changed. Refresh before saving again.",
        409,
      );
    default:
      return apiError("holding_update_failed", "Holding update failed.", 500);
  }
}

export async function PUT(request: Request, context: RouteContext) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }

  const parsed = parsePortfolioHoldingMutation(body);
  if (!parsed.success) {
    return apiError("invalid_request", "Holding request is invalid.", 400);
  }

  try {
    return Response.json(
      {
        data: await putPortfolioHolding(user.userId, symbol.data, parsed.data),
        meta: {
          scope: "personal",
          identity: "authenticated",
          persistence: "server",
        },
      },
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof PortfolioRepositoryError) {
      return repositoryError(error);
    }
    return apiError("holding_update_failed", "Holding update failed.", 500);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
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

  const query = parsePortfolioHoldingDeleteQuery(
    new URL(request.url).searchParams,
  );
  if (!query.success) {
    return apiError(
      "invalid_query",
      "A valid expected_version is required.",
      400,
    );
  }

  try {
    return Response.json(
      {
        data: await deletePortfolioHolding(
          user.userId,
          symbol.data,
          query.data.expected_version,
        ),
        meta: {
          scope: "personal",
          identity: "authenticated",
          persistence: "server",
        },
      },
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof PortfolioRepositoryError) {
      return repositoryError(error);
    }
    return apiError("holding_delete_failed", "Holding could not be deleted.", 500);
  }
}
