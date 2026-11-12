import { getChatGPTUser } from "@/app/chatgpt-auth";
import { defaultWatchlist } from "@/lib/demo-market-data";
import { parseOnboardingDraft } from "@/lib/onboarding-draft";
import {
  parsePortfolioHoldingMutation,
  type PortfolioHoldingMutation,
} from "@/lib/portfolio/contracts";
import {
  getUserPortfolio,
  PortfolioRepositoryError,
  putPortfolioHolding,
} from "@/lib/repositories/portfolio";
import {
  addSymbolToWatchlist,
  ensureDefaultWatchlist,
  WatchlistRepositoryError,
} from "@/lib/repositories/watchlists";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";
import type { CanonicalSymbol } from "@/lib/market-types";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const MAX_DRAFT_LENGTH = 64 * 1024;

type HoldingPlan = {
  symbolId: CanonicalSymbol;
  mutation: PortfolioHoldingMutation;
};

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

function operationError(error: unknown) {
  if (error instanceof InstrumentResolutionError) {
    return error.code === "asset_catalog_unavailable"
      ? apiError(
          "asset_catalog_unavailable",
          "The asset catalog is temporarily unavailable.",
          503,
        )
      : apiError("symbol_not_supported", "Symbol is not supported.", 422);
  }

  if (error instanceof PortfolioRepositoryError) {
    if (error.code === "asset_catalog_unavailable") {
      return apiError(
        "asset_catalog_unavailable",
        "The asset catalog is temporarily unavailable.",
        503,
      );
    }
    if (error.code === "symbol_not_supported") {
      return apiError("symbol_not_supported", "Symbol is not supported.", 422);
    }
  }

  if (
    error instanceof WatchlistRepositoryError &&
    error.code === "symbol_not_supported"
  ) {
    return apiError("symbol_not_supported", "Symbol is not supported.", 422);
  }

  return apiError(
    "onboarding_sync_unavailable",
    "Account setup could not be synced. Retrying is safe.",
    503,
  );
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  let raw: string;
  try {
    raw = await request.text();
    if (raw.length > MAX_DRAFT_LENGTH) {
      return apiError(
        "invalid_onboarding_draft",
        "Onboarding draft is invalid.",
        400,
      );
    }
    JSON.parse(raw);
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }

  const serverNow = new Date().toISOString();
  const draft = parseOnboardingDraft(raw, defaultWatchlist, serverNow);
  if (
    !draft ||
    draft.currentStep !== 3 ||
    draft.highestStep !== 3 ||
    draft.symbols.length === 0
  ) {
    return apiError(
      "invalid_onboarding_draft",
      "Onboarding draft is invalid.",
      400,
    );
  }

  const holdingPlans: HoldingPlan[] = [];
  for (const position of draft.positions) {
    if (!position.owned) continue;

    const parsed = parsePortfolioHoldingMutation({
      quantity: position.shares,
      average_cost: position.averageCost || null,
      cost_currency: "USD",
      quantity_as_of: serverNow,
      expected_version: 0,
    });
    if (!parsed.success) {
      return apiError(
        "invalid_holdings",
        "One or more holdings are invalid.",
        400,
      );
    }
    holdingPlans.push({ symbolId: position.symbolId, mutation: parsed.data });
  }

  try {
    const resolvedEntries = await Promise.all(
      draft.symbols.map(async (symbolId) => {
        const instrument = await resolveCanonicalInstrument(symbolId);
        if (instrument.id !== symbolId) {
          throw new InstrumentResolutionError("symbol_not_supported");
        }
        return [symbolId, instrument] as const;
      }),
    );
    const resolvedBySymbol = new Map(resolvedEntries);

    const portfolio = await getUserPortfolio(user.userId);
    const existingHoldingIds = new Set(
      portfolio.holdings.map((holding) => holding.symbolId),
    );
    const defaultList = await ensureDefaultWatchlist(user.userId);

    for (const symbolId of draft.symbols) {
      const instrument = resolvedBySymbol.get(symbolId);
      if (!instrument) {
        throw new InstrumentResolutionError("symbol_not_supported");
      }
      await addSymbolToWatchlist(
        user.userId,
        defaultList.id,
        symbolId,
        instrument,
      );
    }

    let holdingsCreated = 0;
    let holdingsPreserved = 0;
    for (const plan of holdingPlans) {
      if (existingHoldingIds.has(plan.symbolId)) {
        holdingsPreserved += 1;
        continue;
      }

      try {
        await putPortfolioHolding(user.userId, plan.symbolId, plan.mutation);
        holdingsCreated += 1;
      } catch (error) {
        if (
          error instanceof PortfolioRepositoryError &&
          error.code === "holding_version_conflict"
        ) {
          holdingsPreserved += 1;
          continue;
        }
        throw error;
      }
    }

    return Response.json(
      {
        data: {
          symbolsAccepted: draft.symbols.length,
          watchlistSymbolsEnsured: draft.symbols.length,
          holdingsRequested: holdingPlans.length,
          holdingsCreated,
          holdingsPreserved,
        },
        meta: {
          scope: "personal",
          identity: "authenticated",
          persistence: "server",
          strategy: "additive",
          profileUpdated: false,
          completedAt: serverNow,
        },
      },
      { headers: noStore },
    );
  } catch (error) {
    return operationError(error);
  }
}
