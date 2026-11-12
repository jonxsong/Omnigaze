import type { AppLocale } from "@/lib/app-locale";

type Materiality = "low" | "medium" | "high" | "critical";

interface PersonalTodayCopy {
  dateLocale: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  noAi: string;
  gateTitle: string;
  gateBody: string;
  gateAction: string;
  loadingTitle: string;
  loadingBody: string;
  refreshing: string;
  refreshFailedTitle: string;
  refreshFailedBody: string;
  emptyWatchlistTitle: string;
  emptyWatchlistBody: string;
  emptyEventsTitle: string;
  emptyEventsBody: string;
  demoUnavailableTitle: string;
  errorTitle: string;
  retry: string;
  refresh: string;
  openInbox: string;
  openSource: string;
  sourceUnavailable: string;
  corrected: string;
  controversial: string;
  liveEvidence: string;
  retainedEvidence: string;
  currentOnly: string;
  boundedCoverage: string;
  demoEvidence: string;
  staleEvidence: string;
  unknownEvidence: string;
  liveDetail: string;
  retainedDetail: string;
  currentOnlyDetail: string;
  boundedDetail: string;
  demoDetail: string;
  staleDetail: string;
  unknownDetail: string;
  currentUnavailableTitle: string;
  currentUnavailableBody: string;
  nonCurrentDetail: string;
  provenanceLabel: string;
  sourceTextBoundary: string;
  researchBoundary: string;
  timeUnavailable: string;
  eventsShown: (shown: number, total: number) => string;
  symbolCoverage: (covered: number, tracked: number) => string;
  asOf: (value: string) => string;
  selectSymbol: (ticker: string) => string;
  errors: Record<string, string>;
  materiality: Record<Materiality, string>;
}

const english: PersonalTodayCopy = {
  dateLocale: "en-US",
  eyebrow: "WATCHLIST TODAY",
  title: "Today across your watchlist",
  subtitle: "A factual scan of recent evidence across the companies you track.",
  noAi: "No AI request",
  gateTitle: "Sign in to see your cross-watchlist Today feed",
  gateBody:
    "Today uses the watchlists saved to your account and does not run a model or create a recommendation.",
  gateAction: "Sign in for Today",
  loadingTitle: "Checking your watchlist evidence",
  loadingBody: "Merging current provider results with retained evidence.",
  refreshing: "Refreshing while the last verified view remains visible.",
  refreshFailedTitle: "Refresh delayed",
  refreshFailedBody: "The last verified Today view remains visible.",
  emptyWatchlistTitle: "Your Today feed starts with a watchlist",
  emptyWatchlistBody: "Add a company to your account watchlist to build this view.",
  emptyEventsTitle: "No recent matching evidence",
  emptyEventsBody:
    "No qualifying provider developments were found in the current 24-hour window.",
  demoUnavailableTitle: "Current evidence is unavailable",
  errorTitle: "Today is temporarily unavailable",
  retry: "Try again",
  refresh: "Refresh Today",
  openInbox: "Open intelligence inbox",
  openSource: "Open source",
  sourceUnavailable: "Source link unavailable",
  corrected: "Corrected",
  controversial: "Controversial",
  liveEvidence: "Provider evidence",
  retainedEvidence: "Retained provider evidence",
  currentOnly: "Current provider evidence",
  boundedCoverage: "Bounded evidence window",
  demoEvidence: "Illustrative demo",
  staleEvidence: "Stale provider evidence",
  unknownEvidence: "Freshness unavailable",
  liveDetail:
    "Current provider evidence is shown; retained evidence is included when available.",
  retainedDetail:
    "The current provider refresh failed. Collected live evidence remains visible with its original timestamps.",
  currentOnlyDetail:
    "Collected evidence was unavailable. Current provider evidence remains visible.",
  boundedDetail: "Older collected matches may be omitted from this bounded response.",
  demoDetail: "Live evidence is unavailable. Demo fixtures are illustrative and are not current.",
  staleDetail: "Evidence timestamps fall outside the current freshness window.",
  unknownDetail: "Omnigaze could not verify the evidence freshness timestamp.",
  currentUnavailableTitle: "Current evidence could not be verified",
  currentUnavailableBody:
    "The provider refresh failed and no retained matching evidence was available for this window.",
  nonCurrentDetail:
    "The response contained no current, non-demo provider evidence, so Omnigaze is not presenting it as current.",
  provenanceLabel: "Today feed provenance",
  sourceTextBoundary: "Headlines and source text remain in their original language.",
  researchBoundary: "Evidence only. No model request, market stance, or investment recommendation.",
  timeUnavailable: "Time unavailable",
  eventsShown: (shown, total) =>
    shown === total ? `${shown} developments` : `${shown} of ${total} developments`,
  symbolCoverage: (covered, tracked) => `${covered} of ${tracked} tracked symbols represented`,
  asOf: (value) => `As of ${value}`,
  selectSymbol: (ticker) => `Open ${ticker} in the market workspace`,
  errors: {
    auth_required: "Your session ended. Sign in again to load your Today feed.",
    invalid_query: "The Today request was invalid.",
    watchlists_unavailable: "Your saved watchlists are temporarily unavailable.",
    intelligence_unavailable: "Current and retained intelligence are temporarily unavailable.",
    response_invalid: "The Today response failed its integrity checks.",
    request_timeout: "The Today request timed out before a verified response arrived.",
    network_error: "The Today feed could not be reached.",
    fallback: "The Today feed could not be loaded.",
  },
  materiality: {
    low: "Low materiality",
    medium: "Medium materiality",
    high: "High materiality",
    critical: "Critical materiality",
  },
};

const chinese: PersonalTodayCopy = {
  dateLocale: "zh-CN",
  eyebrow: "自选股今日",
  title: "自选股今日动态",
  subtitle: "查看你关注公司近期出现的事实性证据。",
  noAi: "不发起 AI 请求",
  gateTitle: "登录后查看跨自选股的今日动态",
  gateBody:
    "“今日动态”仅使用你账户中保存的自选股，不运行模型，也不生成投资建议。",
  gateAction: "登录查看今日动态",
  loadingTitle: "正在核查自选股证据",
  loadingBody: "正在合并当前提供商结果与已留存证据。",
  refreshing: "正在刷新；上一次经验证的视图仍保持可见。",
  refreshFailedTitle: "刷新延迟",
  refreshFailedBody: "上一次经验证的今日动态仍保持可见。",
  emptyWatchlistTitle: "请先建立自选股列表",
  emptyWatchlistBody: "向账户自选股添加公司后，即可生成此视图。",
  emptyEventsTitle: "暂无近期匹配证据",
  emptyEventsBody: "当前 24 小时窗口内没有符合条件的提供商动态。",
  demoUnavailableTitle: "当前证据不可用",
  errorTitle: "今日动态暂不可用",
  retry: "重试",
  refresh: "刷新今日动态",
  openInbox: "打开情报收件箱",
  openSource: "打开来源",
  sourceUnavailable: "来源链接不可用",
  corrected: "已修正",
  controversial: "争议性事件",
  liveEvidence: "提供商证据",
  retainedEvidence: "已留存的提供商证据",
  currentOnly: "当前提供商证据",
  boundedCoverage: "有限证据窗口",
  demoEvidence: "示例数据",
  staleEvidence: "已过期的提供商证据",
  unknownEvidence: "无法确认时效性",
  liveDetail: "显示当前提供商证据；如有已留存证据，也会一并纳入。",
  retainedDetail:
    "当前提供商刷新失败；仍显示已收集的实时证据，并保留其原始时间戳。",
  currentOnlyDetail: "已收集证据暂不可用；仍显示当前提供商证据。",
  boundedDetail: "此有限响应可能省略较早的已收集匹配项。",
  demoDetail: "实时证据不可用；示例数据仅用于演示，并非当前信息。",
  staleDetail: "证据时间戳已超出当前时效窗口。",
  unknownDetail: "Omnigaze 无法验证证据的时效时间戳。",
  currentUnavailableTitle: "无法验证当前证据",
  currentUnavailableBody: "提供商刷新失败，且此窗口内没有可用的已留存匹配证据。",
  nonCurrentDetail:
    "响应中没有当前且非示例的提供商证据，因此 Omnigaze 不会将其标示为当前信息。",
  provenanceLabel: "今日动态来源说明",
  sourceTextBoundary: "标题与来源文字保留原始语言。",
  researchBoundary: "仅展示证据，不发起模型请求，不提供市场立场或投资建议。",
  timeUnavailable: "时间不可用",
  eventsShown: (shown, total) =>
    shown === total ? `${shown} 条动态` : `显示 ${shown} / ${total} 条动态`,
  symbolCoverage: (covered, tracked) =>
    `${tracked} 只关注股票中有 ${covered} 只出现相关证据`,
  asOf: (value) => `截至 ${value}`,
  selectSymbol: (ticker) => `在市场工作区打开 ${ticker}`,
  errors: {
    auth_required: "登录状态已结束，请重新登录后加载今日动态。",
    invalid_query: "今日动态请求无效。",
    watchlists_unavailable: "你保存的自选股暂不可用。",
    intelligence_unavailable: "当前与已留存的情报暂不可用。",
    response_invalid: "今日动态响应未通过完整性检查。",
    request_timeout: "在收到可验证响应前，请求已超时。",
    network_error: "暂时无法连接今日动态。",
    fallback: "无法加载今日动态。",
  },
  materiality: {
    low: "低重要性",
    medium: "中等重要性",
    high: "高重要性",
    critical: "关键重要性",
  },
};

export const personalTodayCopy = {
  en: english,
  "zh-CN": chinese,
} satisfies Record<AppLocale, PersonalTodayCopy>;

export function personalTodayErrorMessage(locale: AppLocale, code: string | null) {
  const copy = personalTodayCopy[locale];
  return (code && copy.errors[code]) || copy.errors.fallback;
}
