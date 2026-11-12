import type { AppLocale } from "@/lib/app-locale";

const en = {
  eyebrow: "Portfolio Pulse",
  title: "What moved your money today",
  description:
    "Live position values and contribution math from the holdings you saved. Omnigaze excludes quotes it cannot verify instead of treating them as zero.",
  marketValue: "Covered market value",
  todayChange: "Today’s change",
  unrealizedPnl: "Unrealized P&L",
  largestPosition: "Largest covered position",
  positions: "Position breakdown",
  quantity: "Shares",
  value: "Value",
  today: "Today",
  unrealized: "Unrealized",
  coverage: "{covered} of {total} positions covered",
  costCoverage: "Cost basis available for {covered} of {total}",
  partialCoverage: "Partial position coverage",
  completeCoverage: "All positions covered",
  coveredWeight: "{weight}% of covered value",
  waitingTitle: "Checking your live positions",
  waitingBody: "Portfolio Pulse will appear as verified quotes arrive.",
  emptyTitle: "Add a position to activate Portfolio Pulse",
  emptyBody:
    "Save the number of shares you own and an optional average cost. Omnigaze will calculate the impact without placing a trade.",
  addPosition: "Add a position",
  unavailableTitle: "Portfolio Pulse is temporarily unavailable",
  unavailableBody:
    "Your saved positions are unchanged. Missing quotes are not included in totals.",
  noVerifiedQuotesTitle: "No position has an eligible live quote yet",
  noVerifiedQuotesBody:
    "{count} saved positions were excluded. Omnigaze keeps each reason visible instead of manufacturing a portfolio total.",
  quoteExcluded: "Quote excluded",
  staleQuote: "Stale quote",
  demoQuote: "Demo quote",
  quoteUnavailable: "Quote unavailable",
  invalidHolding: "Holding unavailable",
  belowPrecision: "Value is below calculation precision",
  delayed: "{seconds}s delay",
  realTime: "No provider-reported delay",
  asOf: "As of {time}",
  provider: "{provider} quotes",
  noCostBasis: "No cost basis",
  selectPosition: "Select {ticker} in the dashboard",
  topContributor: "Top contributor",
  bottomContributor: "Largest detractor",
  noPositiveContributor: "No positive contributor",
  noNegativeContributor: "No negative contributor",
  showAllPositions: "Show all {count} position rows",
  showLessPositions: "Show fewer position rows",
  omittedPositions: "{count} additional positions were omitted by the 50-position safety bound",
  multipleProviders: "{count} quote providers",
  limitedExchange: "Limited-exchange coverage",
  consolidated: "Consolidated coverage",
  researchOnly:
    "Research context only. Values are estimates from available quotes and do not authorize or place orders.",
} as const;

export type PortfolioPulseCopyKey = keyof typeof en;

const zh: Record<PortfolioPulseCopyKey, string> = {
  eyebrow: "投资组合脉搏",
  title: "今天是什么推动了你的资产变化",
  description:
    "根据你保存的持仓，用实时行情计算仓位价值与当日贡献。无法核验的行情会被排除，不会被当作零处理。",
  marketValue: "已覆盖持仓市值",
  todayChange: "今日变化",
  unrealizedPnl: "未实现盈亏",
  largestPosition: "已覆盖持仓中的最大仓位",
  positions: "持仓明细",
  quantity: "股数",
  value: "市值",
  today: "今日",
  unrealized: "未实现",
  coverage: "已覆盖 {covered}/{total} 个持仓",
  costCoverage: "{total} 个持仓中有 {covered} 个含成本基础",
  partialCoverage: "持仓部分覆盖",
  completeCoverage: "所有持仓均已覆盖",
  coveredWeight: "占已覆盖市值的 {weight}%",
  waitingTitle: "正在核验实时持仓",
  waitingBody: "经过核验的行情到达后，投资组合脉搏会显示结果。",
  emptyTitle: "添加持仓以启用投资组合脉搏",
  emptyBody:
    "保存持股数量以及可选的平均成本。Omnigaze 会计算影响，但不会代表你下单。",
  addPosition: "添加持仓",
  unavailableTitle: "投资组合脉搏暂时不可用",
  unavailableBody: "你保存的持仓没有变化；缺失行情不会计入合计。",
  noVerifiedQuotesTitle: "目前没有持仓具备合格的实时行情",
  noVerifiedQuotesBody:
    "{count} 个已保存持仓被排除。Omnigaze 会显示每个原因，而不会虚构投资组合合计。",
  quoteExcluded: "行情已排除",
  staleQuote: "行情已过期",
  demoQuote: "演示行情",
  quoteUnavailable: "行情不可用",
  invalidHolding: "持仓不可用",
  belowPrecision: "该持仓价值低于计算精度",
  delayed: "延迟 {seconds} 秒",
  realTime: "供应商未报告延迟",
  asOf: "截至 {time}",
  provider: "{provider} 行情",
  noCostBasis: "无成本基础",
  selectPosition: "在仪表盘中选择 {ticker}",
  topContributor: "最大正贡献",
  bottomContributor: "最大负贡献",
  noPositiveContributor: "暂无正贡献持仓",
  noNegativeContributor: "暂无负贡献持仓",
  showAllPositions: "显示全部 {count} 个持仓行",
  showLessPositions: "收起持仓行",
  omittedPositions: "另有 {count} 个持仓因 50 个持仓的安全上限而被省略",
  multipleProviders: "{count} 个行情供应商",
  limitedExchange: "有限交易所覆盖",
  consolidated: "综合行情覆盖",
  researchOnly:
    "仅供研究参考。数值是基于可用行情的估算，不会授权或执行任何交易。",
};

export function formatPortfolioPulseCopy(
  locale: AppLocale,
  key: PortfolioPulseCopyKey,
  values: Record<string, string | number> = {},
) {
  const dictionary = locale === "zh-CN" ? zh : en;
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    dictionary[key],
  );
}
