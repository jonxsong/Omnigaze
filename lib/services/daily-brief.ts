import {
  assertGroundedDailyBrief,
  dailyBriefEnvelopeSchema,
  dailyBriefSchema,
  type DailyBrief,
  type DailyBriefAnalysis,
  type DailyBriefEnvelope,
} from "@/lib/ai/daily-brief-contract";
import {
  createDailyBriefCacheIdentity,
} from "@/lib/ai/daily-brief-fingerprint";
import {
  DailyBriefGenerationGuard,
  type DailyBriefGuardInput,
  type DailyBriefGuardResult,
} from "@/lib/ai/daily-brief-guard";
import {
  assertDailyBriefAnalysisLocale,
  assertDailyBriefAnalysisPolicy,
  dailyBriefPromptVersion,
} from "@/lib/ai/generate-daily-brief";
import type { AppLocale } from "@/lib/app-locale";
import { resolveOmnigazeModelConfig } from "@/lib/ai/omnigaze-view-guard";
import { extractCanonicalSymbols } from "@/lib/api/personal-intelligence";
import type { CanonicalSymbol } from "@/lib/market-types";
import { listUserWatchlists } from "@/lib/repositories/watchlists";
import {
  type OrchestratedIntelligenceFeed,
  liveMarketData,
} from "@/lib/services/live-market-data";
import {
  DAILY_BRIEF_WINDOW_HOURS,
  DailyBriefEvidenceError,
  dailyBriefEvidenceCoverage,
  selectDailyBriefEvidence,
  type DailyBriefEvidenceSelection,
} from "@/lib/services/personal-today-evidence";

export type DailyBriefServiceErrorCode =
  | "ai_unconfigured"
  | "empty_watchlist"
  | "live_evidence_required"
  | "fresh_evidence_required"
  | "insufficient_evidence"
  | "watchlists_unavailable"
  | "intelligence_unavailable";

const errors: Record<
  DailyBriefServiceErrorCode,
  { status: number; message: string }
> = {
  ai_unconfigured: {
    status: 503,
    message: "AI analysis is not configured in this environment.",
  },
  empty_watchlist: {
    status: 422,
    message: "Add a stock to your watchlists before generating a brief.",
  },
  live_evidence_required: {
    status: 422,
    message: "Live provider evidence is required for a Daily Brief.",
  },
  fresh_evidence_required: {
    status: 422,
    message: "Fresh provider evidence is required for a Daily Brief.",
  },
  insufficient_evidence: {
    status: 422,
    message: "No relevant evidence is available for a Daily Brief.",
  },
  watchlists_unavailable: {
    status: 503,
    message: "Your watchlists are temporarily unavailable.",
  },
  intelligence_unavailable: {
    status: 502,
    message: "Current watchlist intelligence is temporarily unavailable.",
  },
};

export class DailyBriefServiceError extends Error {
  readonly status: number;

  constructor(readonly code: DailyBriefServiceErrorCode) {
    super(errors[code].message);
    this.name = "DailyBriefServiceError";
    this.status = errors[code].status;
  }
}

type UserWatchlists = Awaited<ReturnType<typeof listUserWatchlists>>;

type DailyBriefGuard = {
  execute(
    input: DailyBriefGuardInput<DailyBrief>,
  ): Promise<DailyBriefGuardResult<DailyBrief>>;
};

type DailyBriefDependencies = {
  listWatchlists(ownerId: string): Promise<UserWatchlists>;
  getIntelligenceFeed(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
    minimumMateriality: "low";
  }): Promise<OrchestratedIntelligenceFeed>;
  analyze(input: {
    locale: AppLocale;
    briefDate: string;
    window: { since: string; through: string };
    trackedSymbols: readonly CanonicalSymbol[];
    evidence: DailyBriefEvidenceSelection["items"];
  }): Promise<DailyBriefAnalysis>;
  guard: DailyBriefGuard;
  modelConfig(): string;
  now(): Date;
  isAiConfigured(): boolean;
};

const dailyBriefCodec = {
  encode(value: DailyBrief) {
    return dailyBriefSchema.parse(value);
  },
  decode(value: unknown) {
    return dailyBriefSchema.parse(value);
  },
};

let defaultGuardInstance: DailyBriefGenerationGuard<DailyBrief> | null = null;
const defaultGuard: DailyBriefGuard = {
  async execute(input) {
    if (!defaultGuardInstance) {
      const { aiGuardrailsRepository } = await import(
        "@/lib/ai/guardrails-repository"
      );
      defaultGuardInstance = new DailyBriefGenerationGuard(
        aiGuardrailsRepository,
        dailyBriefCodec,
      );
    }
    return defaultGuardInstance.execute(input);
  },
};

const defaultDependencies: DailyBriefDependencies = {
  listWatchlists: listUserWatchlists,
  getIntelligenceFeed: (options) => liveMarketData.getIntelligenceFeed(options),
  analyze: async (input) => {
    const { generateDailyBriefAnalysis } = await import(
      "@/lib/ai/generate-daily-brief"
    );
    return generateDailyBriefAnalysis(input);
  },
  guard: defaultGuard,
  modelConfig: () => resolveOmnigazeModelConfig(process.env.OPENAI_MODEL),
  now: () => new Date(),
  isAiConfigured: () => Boolean(process.env.OPENAI_API_KEY),
};

function mapEvidenceError(error: DailyBriefEvidenceError): DailyBriefServiceError {
  if (error.code === "empty_watchlist") {
    return new DailyBriefServiceError("empty_watchlist");
  }
  if (error.code === "live_evidence_required") {
    return new DailyBriefServiceError("live_evidence_required");
  }
  if (error.code === "fresh_evidence_required") {
    return new DailyBriefServiceError("fresh_evidence_required");
  }
  return new DailyBriefServiceError("insufficient_evidence");
}

function citationSet(selection: DailyBriefEvidenceSelection) {
  return selection.items.map((item) => ({
    id: item.id,
    title: item.headline,
    publisher: item.source,
    publishedAt: item.publishedAt,
    url: item.sourceUrl,
    symbolIds: item.symbolIds,
    materiality: item.materiality,
    ...(item.claimStatus ? { claimStatus: item.claimStatus } : {}),
    isControversial: item.isControversial,
  }));
}

export interface GeneratePersonalDailyBriefRequest {
  requestId?: string;
  locale?: AppLocale;
}

export async function generatePersonalDailyBrief(
  ownerId: string,
  request: GeneratePersonalDailyBriefRequest = {},
  dependencies: Partial<DailyBriefDependencies> = {},
): Promise<DailyBriefEnvelope> {
  const deps = { ...defaultDependencies, ...dependencies };
  const locale: AppLocale = request.locale === "zh-CN" ? "zh-CN" : "en";
  const promptVersion = dailyBriefPromptVersion(locale);
  if (!deps.isAiConfigured()) {
    throw new DailyBriefServiceError("ai_unconfigured");
  }

  let watchlists: UserWatchlists;
  try {
    watchlists = await deps.listWatchlists(ownerId);
  } catch {
    throw new DailyBriefServiceError("watchlists_unavailable");
  }
  const symbols = extractCanonicalSymbols(watchlists);
  if (symbols.length === 0) {
    throw new DailyBriefServiceError("empty_watchlist");
  }

  const now = deps.now();
  let feed: OrchestratedIntelligenceFeed;
  try {
    feed = await deps.getIntelligenceFeed({
      symbols,
      since: new Date(
        now.getTime() - DAILY_BRIEF_WINDOW_HOURS * 60 * 60 * 1_000,
      ).toISOString(),
      limit: 100,
      minimumMateriality: "low",
    });
  } catch {
    throw new DailyBriefServiceError("intelligence_unavailable");
  }

  let selection: DailyBriefEvidenceSelection;
  try {
    selection = selectDailyBriefEvidence({
      trackedSymbols: symbols,
      feed,
      now,
    });
  } catch (error) {
    if (error instanceof DailyBriefEvidenceError) throw mapEvidenceError(error);
    throw error;
  }

  const briefDate = selection.window.through.slice(0, 10);
  const modelConfig = deps.modelConfig();
  const identity = await createDailyBriefCacheIdentity({
    promptVersion,
    modelKey: modelConfig,
    briefDate,
    trackedSymbols: selection.trackedSymbols,
    evidence: selection.items,
  });
  const guarded = await deps.guard.execute({
    ownerId,
    requestId: request.requestId,
    identity: {
      ...identity,
      briefDate,
      promptVersion,
      modelConfig,
    },
    freshness: {
      state: "fresh",
      asOf: selection.meta.freshness.asOf,
      maximumAgeSeconds: DAILY_BRIEF_WINDOW_HOURS * 60 * 60,
    },
    generate: async () => {
      const analysis = await deps.analyze({
        locale,
        briefDate,
        window: selection.window,
        trackedSymbols: selection.trackedSymbols,
        evidence: selection.items,
      });
      assertGroundedDailyBrief(analysis, selection.items);
      assertDailyBriefAnalysisPolicy(analysis);
      assertDailyBriefAnalysisLocale(analysis, locale);
      return dailyBriefSchema.parse({
        ...analysis,
        briefDate,
        window: selection.window,
      });
    },
  });

  assertGroundedDailyBrief(guarded.value, selection.items);
  assertDailyBriefAnalysisPolicy(guarded.value);
  assertDailyBriefAnalysisLocale(guarded.value, locale);
  const citations = citationSet(selection);
  const cacheState = guarded.meta.deduplicated
    ? "deduplicated"
    : guarded.meta.source === "cache"
      ? "hit"
      : "generated";
  return dailyBriefEnvelopeSchema.parse({
    data: guarded.value,
    meta: {
      dataMode: "live",
      providerCoverage: selection.meta.providerCoverage,
      freshness: selection.meta.freshness,
      trackedSymbolCount: selection.trackedSymbols.length,
      trackedSymbolIds: selection.trackedSymbols,
      includedSymbolCount: selection.includedSymbols.length,
      omittedSymbolCount: selection.omittedSymbols.length,
      evidenceCount: selection.items.length,
      sourceCount: new Set(selection.items.map((item) => item.source)).size,
      evidenceCoverage: dailyBriefEvidenceCoverage(selection),
      citations,
      promptVersion,
      generatedAt: guarded.meta.generatedAt,
      cache: {
        state: cacheState,
        cachedAt: guarded.meta.generatedAt,
        expiresAt: guarded.meta.cacheExpiresAt,
      },
      budget: guarded.meta.budget.charged
        ? {
            consumed: true,
            remaining: guarded.meta.budget.remaining,
            limit: guarded.meta.budget.limit,
            resetsAt: guarded.meta.budget.resetAt,
          }
        : {
            consumed: false,
            remaining: null,
            limit: null,
            resetsAt: null,
          },
      confidenceMeaning: "evidence_synthesis_not_return_probability",
      disclaimer: "Research support only. This is not investment advice.",
    },
  });
}
