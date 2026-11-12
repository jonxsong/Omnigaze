import type { AppLocale } from "@/lib/app-locale";

type Direction = "positive" | "negative" | "mixed" | "unclear";
type Coverage = "limited" | "moderate" | "strong";
type ProviderCoverage = "complete" | "partial";

interface DailyBriefCopy {
  dateLocale: string;
  timeUnavailable: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  manualOnly: string;
  gateTitle: string;
  gateBody: string;
  gateAction: string;
  readyKicker: string;
  readyTitle: string;
  readyBody: string;
  buildAction: string;
  manualRequestNote: string;
  loadingTitle: string;
  loadingBody: string;
  unavailableTitle: string;
  rateLimitExplanation: string;
  signInAgain: string;
  resumeSafely: string;
  tryNew: string;
  liveEvidence: string;
  evidenceCoverage: string;
  notInvestmentConfidence: string;
  provenanceLabel: string;
  watchlistCoverage: string;
  evidence: string;
  aiRequest: string;
  cacheGenerated: string;
  cacheDeduplicated: string;
  cacheHit: string;
  noAdditionalRequest: string;
  developmentsEyebrow: string;
  developmentsTitle: string;
  watchNext: string;
  unknowns: string;
  verifiedEvidence: string;
  disclaimer: string;
  synthesisBoundary: string;
  refresh: string;
  direction: Record<Direction, string>;
  coverage: Record<Coverage, string>;
  providerCoverage: Record<ProviderCoverage, string>;
  errors: Record<string, string>;
  asOf(value: string): string;
  retryAt(value: string): string;
  symbolCoverage(included: number, tracked: number): string;
  omittedSymbols(count: number): string;
  evidenceSummary(evidence: number, sources: number): string;
  providerCoverageSummary(value: string): string;
  requestsRemain(remaining: number, limit: number, resetAt: string): string;
  citedThemes(count: number): string;
  sourcesFor(title: string): string;
  inspectSources(count: number): string;
  omittedTrackedSymbols(count: number): string;
  openSource(title: string): string;
}

const english: DailyBriefCopy = {
  dateLocale: "en-US",
  timeUnavailable: "Time unavailable",
  eyebrow: "PERSONAL MARKET INTELLIGENCE",
  title: "Daily Brief",
  subtitle: "One cited read across the companies you track.",
  manualOnly: "Manual only",
  gateTitle: "Sign in to brief your watchlist",
  gateBody:
    "Your brief uses only your saved symbols and fresh, cited market evidence. It never runs in the background.",
  gateAction: "Sign in for Daily Brief",
  readyKicker: "Ready when you are",
  readyTitle: "Turn today’s evidence into a clear market read.",
  readyBody:
    "Omnigaze checks fresh evidence across your tracked companies, explains the important developments, and links every included development to its evidence.",
  buildAction: "Build my Daily Brief",
  manualRequestNote:
    "Starts one explicit AI request. No scheduled or background generation.",
  loadingTitle: "Building your evidence-backed brief",
  loadingBody: "Checking watchlist coverage, freshness, and citation integrity.",
  unavailableTitle: "Daily Brief unavailable",
  rateLimitExplanation:
    "AI usage is temporarily at its limit. This budget manages model requests—it is not investment confidence or a market signal.",
  signInAgain: "Sign in again",
  resumeSafely: "Resume brief safely",
  tryNew: "Try a new brief",
  liveEvidence: "Live evidence",
  evidenceCoverage: "evidence coverage",
  notInvestmentConfidence: "not investment confidence",
  provenanceLabel: "Brief provenance and usage",
  watchlistCoverage: "WATCHLIST COVERAGE",
  evidence: "EVIDENCE",
  aiRequest: "AI REQUEST",
  cacheGenerated: "New analysis generated",
  cacheDeduplicated: "Joined an in-progress request",
  cacheHit: "Verified cached brief reused",
  noAdditionalRequest: "No additional model request used",
  developmentsEyebrow: "TODAY’S DEVELOPMENTS",
  developmentsTitle: "What changed across your watchlist",
  watchNext: "WATCH NEXT",
  unknowns: "WHAT REMAINS UNKNOWN",
  verifiedEvidence: "Verified evidence",
  disclaimer: "Research support only. This is not investment advice.",
  synthesisBoundary:
    "Evidence synthesis is not a return probability, recommendation, or substitute for your own research.",
  refresh: "Refresh brief",
  direction: {
    positive: "Positive",
    negative: "Negative",
    mixed: "Mixed",
    unclear: "Unclear",
  },
  coverage: {
    limited: "limited",
    moderate: "moderate",
    strong: "strong",
  },
  providerCoverage: {
    complete: "complete",
    partial: "partial",
  },
  errors: {
    auth_required: "Authentication is required to build your Daily Brief.",
    invalid_request: "The Daily Brief request is invalid.",
    ai_unconfigured: "AI analysis is not configured in this environment.",
    empty_watchlist: "Add a stock to your watchlist before generating a brief.",
    live_evidence_required: "Live provider evidence is required for a Daily Brief.",
    fresh_evidence_required: "Fresh provider evidence is required for a Daily Brief.",
    insufficient_evidence: "No relevant evidence is available for a Daily Brief.",
    watchlists_unavailable: "Your watchlists are temporarily unavailable.",
    intelligence_unavailable:
      "Current watchlist intelligence is temporarily unavailable.",
    ai_rate_limited: "The AI analysis budget is temporarily exhausted.",
    ai_guard_unavailable: "AI usage controls are temporarily unavailable.",
    analysis_failed: "The Daily Brief could not be completed.",
    request_timeout: "The brief timed out before a verified result was ready.",
    response_invalid:
      "The Daily Brief response failed its integrity checks. Please try again.",
    network_error: "Your Daily Brief is temporarily unavailable.",
    fallback: "Your Daily Brief is temporarily unavailable.",
  },
  asOf: (value) => `As of ${value}`,
  retryAt: (value) => `New model requests reset around ${value}.`,
  symbolCoverage: (included, tracked) => `${included} of ${tracked} symbols`,
  omittedSymbols: (count) =>
    `${count} not represented in this bounded brief`,
  evidenceSummary: (evidence, sources) =>
    `${evidence} citation${evidence === 1 ? "" : "s"} · ${sources} source${sources === 1 ? "" : "s"}`,
  providerCoverageSummary: (value) => `${value} provider coverage`,
  requestsRemain: (remaining, limit, resetAt) =>
    `${remaining} of ${limit} requests remain until ${resetAt}`,
  citedThemes: (count) => `${count} cited theme${count === 1 ? "" : "s"}`,
  sourcesFor: (title) => `Sources for ${title}`,
  inspectSources: (count) =>
    `Inspect ${count} cited source${count === 1 ? "" : "s"}`,
  omittedTrackedSymbols: (count) =>
    `${count} tracked symbol${count === 1 ? "" : "s"} omitted`,
  openSource: (title) => `Open source: ${title}`,
};

const chinese: DailyBriefCopy = {
  dateLocale: "zh-CN",
  timeUnavailable: "时间不可用",
  eyebrow: "个人市场情报",
  title: "每日简报",
  subtitle: "用一份带引证的简报读懂你关注的公司。",
  manualOnly: "仅手动生成",
  gateTitle: "登录后为自选股生成简报",
  gateBody:
    "简报只使用你保存的股票和最新、可引证的市场证据，绝不会在后台自动运行。",
  gateAction: "登录并生成每日简报",
  readyKicker: "随时可以开始",
  readyTitle: "把今天的证据整理成清晰的市场解读。",
  readyBody:
    "Omnigaze 会核查你关注公司中的最新证据，解释重要进展，并把每项进展链接到对应证据。",
  buildAction: "生成我的每日简报",
  manualRequestNote: "仅在你明确点击后发起一次 AI 请求，不会定时或在后台生成。",
  loadingTitle: "正在生成有证据支撑的简报",
  loadingBody: "正在核查自选股覆盖、时效性和引证完整性。",
  unavailableTitle: "每日简报暂不可用",
  rateLimitExplanation:
    "AI 使用额度暂时已达上限。该额度仅用于管理模型请求，并不代表投资信心或市场信号。",
  signInAgain: "重新登录",
  resumeSafely: "安全恢复简报请求",
  tryNew: "重新生成简报",
  liveEvidence: "实时证据",
  evidenceCoverage: "证据覆盖率",
  notInvestmentConfidence: "并非投资信心",
  provenanceLabel: "简报来源与 AI 使用情况",
  watchlistCoverage: "自选股覆盖",
  evidence: "证据",
  aiRequest: "AI 请求",
  cacheGenerated: "已生成新的分析",
  cacheDeduplicated: "已加入正在进行的请求",
  cacheHit: "已复用经验证的缓存简报",
  noAdditionalRequest: "未使用额外模型请求",
  developmentsEyebrow: "今日进展",
  developmentsTitle: "你的自选股发生了什么变化",
  watchNext: "接下来关注",
  unknowns: "仍待确认",
  verifiedEvidence: "经验证的证据",
  disclaimer: "仅用于研究辅助，不构成投资建议。",
  synthesisBoundary:
    "证据综合不代表收益概率或投资建议，也不能替代你自己的研究。",
  refresh: "刷新简报",
  direction: {
    positive: "正面",
    negative: "负面",
    mixed: "多空交织",
    unclear: "尚不明确",
  },
  coverage: {
    limited: "有限",
    moderate: "中等",
    strong: "充分",
  },
  providerCoverage: {
    complete: "完整",
    partial: "部分",
  },
  errors: {
    auth_required: "请先登录，再生成每日简报。",
    invalid_request: "每日简报请求无效。",
    ai_unconfigured: "当前环境尚未配置 AI 分析。",
    empty_watchlist: "请先向自选股添加股票，再生成简报。",
    live_evidence_required: "生成每日简报需要实时提供商证据。",
    fresh_evidence_required: "生成每日简报需要最新的提供商证据。",
    insufficient_evidence: "目前没有足够的相关证据可用于生成每日简报。",
    watchlists_unavailable: "你的自选股暂时不可用。",
    intelligence_unavailable: "当前自选股情报暂时不可用。",
    ai_rate_limited: "AI 分析额度暂时已用尽。",
    ai_guard_unavailable: "AI 使用控制暂时不可用。",
    analysis_failed: "无法完成每日简报。",
    request_timeout: "在取得可验证结果前，简报请求已超时。",
    response_invalid: "每日简报响应未通过完整性检查，请重试。",
    network_error: "每日简报暂时不可用。",
    fallback: "每日简报暂时不可用。",
  },
  asOf: (value) => `截至 ${value}`,
  retryAt: (value) => `新的模型请求预计可在 ${value} 左右恢复。`,
  symbolCoverage: (included, tracked) => `已覆盖 ${included} / ${tracked} 只股票`,
  omittedSymbols: (count) => `本次有限简报未覆盖 ${count} 只股票`,
  evidenceSummary: (evidence, sources) =>
    `${evidence} 条引证 · ${sources} 个来源`,
  providerCoverageSummary: (value) => `提供商覆盖：${value}`,
  requestsRemain: (remaining, limit, resetAt) =>
    `在 ${resetAt} 重置前，${limit} 次额度中还剩 ${remaining} 次`,
  citedThemes: (count) => `${count} 个有引证的主题`,
  sourcesFor: (title) => `${title} 的来源`,
  inspectSources: (count) => `查看 ${count} 条引证来源`,
  omittedTrackedSymbols: (count) => `已省略 ${count} 只关注股票`,
  openSource: (title) => `打开来源：${title}`,
};

export const dailyBriefCopy = {
  en: english,
  "zh-CN": chinese,
} satisfies Record<AppLocale, DailyBriefCopy>;

export function dailyBriefErrorMessage(
  locale: AppLocale,
  code: string | null,
) {
  const copy = dailyBriefCopy[locale];
  return (code && copy.errors[code]) || copy.errors.fallback;
}
