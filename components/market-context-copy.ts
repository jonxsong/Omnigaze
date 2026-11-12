import type { AppLocale } from "@/lib/app-locale";
import type { MarketContextProxyKey } from "@/lib/market-context";

type MarketContextCopy = {
  ariaLabel: string;
  live: string;
  partial: string;
  stale: string;
  unavailable: string;
  checking: string;
  refreshDelayed: string;
  proxyNotice: string;
  asOf: string;
  checkedAt: string;
  limitedCoverage: string;
  consolidatedCoverage: string;
  mixedCoverage: string;
  delayed: string;
  staleItem: string;
  timestampUnavailable: string;
  labels: Record<MarketContextProxyKey, string>;
};

export const marketContextCopy: Record<AppLocale, MarketContextCopy> = {
  en: {
    ariaLabel: "Live market context from ETF proxies",
    live: "LIVE ETF PROXIES",
    partial: "PARTIAL ETF PROXIES",
    stale: "STALE ETF PROXIES",
    unavailable: "MARKET CONTEXT UNAVAILABLE",
    checking: "CHECKING MARKET CONTEXT",
    refreshDelayed: "REFRESH DELAYED",
    proxyNotice: "Provider-backed ETF prices · not index levels, yields, volatility, or spot commodities",
    asOf: "provider observation {time}",
    checkedAt: "checked {time}",
    limitedCoverage: "limited-exchange coverage",
    consolidatedCoverage: "consolidated coverage",
    mixedCoverage: "mixed exchange coverage",
    delayed: "delayed {minutes}m",
    staleItem: "stale",
    timestampUnavailable: "time unavailable",
    labels: {
      "us-large-cap": "S&P 500 ETF proxy",
      "us-growth": "Nasdaq-100 ETF proxy",
      "us-small-cap": "Russell 2000 ETF proxy",
      "long-treasury": "20+ year Treasury ETF proxy",
      oil: "Oil ETF proxy",
      gold: "Gold ETF proxy",
    },
  },
  "zh-CN": {
    ariaLabel: "ETF 代理提供的实时市场背景",
    live: "实时 ETF 代理",
    partial: "部分 ETF 代理可用",
    stale: "ETF 代理数据已过期",
    unavailable: "市场背景不可用",
    checking: "正在检查市场背景",
    refreshDelayed: "刷新延迟",
    proxyNotice: "供应商支持的 ETF 价格 · 不是指数点位、收益率、波动率或现货商品价格",
    asOf: "供应商观测时间 {time}",
    checkedAt: "检查于 {time}",
    limitedCoverage: "有限交易所覆盖",
    consolidatedCoverage: "综合市场覆盖",
    mixedCoverage: "混合交易所覆盖",
    delayed: "延迟 {minutes} 分钟",
    staleItem: "已过期",
    timestampUnavailable: "时间不可用",
    labels: {
      "us-large-cap": "标普 500 ETF 代理",
      "us-growth": "纳斯达克 100 ETF 代理",
      "us-small-cap": "罗素 2000 ETF 代理",
      "long-treasury": "20 年以上美国国债 ETF 代理",
      oil: "石油 ETF 代理",
      gold: "黄金 ETF 代理",
    },
  },
};
