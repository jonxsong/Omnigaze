import { describe, expect, it } from "vitest";
import {
  formatMarketDashboardCopy,
  formatWatchlistSyncMessage,
  localizeDemoIntelligenceEvent,
  marketDashboardCopy,
} from "@/components/market-dashboard-copy";

describe("market dashboard localization", () => {
  it("keeps the English and Chinese dictionaries structurally aligned", () => {
    expect(Object.keys(marketDashboardCopy["zh-CN"]).sort()).toEqual(
      Object.keys(marketDashboardCopy.en).sort(),
    );
  });

  it("formats dynamic Chinese dashboard copy without leaving placeholders", () => {
    const message = formatMarketDashboardCopy("zh-CN", "openInboxUnread", {
      count: 12,
    });

    expect(message).toBe("打开情报收件箱，12 条未读");
    expect(message).not.toMatch(/[{}]/);
  });

  it("keeps ticker identifiers unchanged inside localized labels", () => {
    expect(
      formatMarketDashboardCopy("zh-CN", "noCrossCompanyQuote", {
        ticker: "NVDA",
      }),
    ).toContain("NVDA");
  });

  it("explains degraded intelligence provenance in both locales", () => {
    expect(formatMarketDashboardCopy("en", "retainedEvidenceTitle")).toBe(
      "Showing retained provider evidence",
    );
    expect(
      formatMarketDashboardCopy("zh-CN", "liveOnlyEvidenceDetail"),
    ).toContain("已保存的证据");
  });

  it("localizes only known application-owned demo intelligence", () => {
    const fixture = {
      id: "demo:NVDA-event-governance-scrutiny",
      headline: "Board investigation elevates executive and governance risk",
      summary: "Original bundled summary",
    };
    const provider = {
      id: "alpaca:provider-event",
      headline: "Provider headline remains original",
      summary: "Provider summary remains original",
    };

    expect(localizeDemoIntelligenceEvent("zh-CN", fixture)).toMatchObject({
      headline: "董事会调查加剧高管与治理风险",
    });
    expect(localizeDemoIntelligenceEvent("en", fixture)).toBe(fixture);
    expect(localizeDemoIntelligenceEvent("zh-CN", provider)).toBe(provider);
  });

  it("derives watchlist failures from stable codes in the active locale", () => {
    expect(formatWatchlistSyncMessage("en", "save_failed")).toBe(
      "Watchlist save failed. Your last change was rolled back.",
    );
    expect(formatWatchlistSyncMessage("zh-CN", "save_failed")).toBe(
      "自选股保存失败。 上一次更改已回退。",
    );
    expect(formatWatchlistSyncMessage("zh-CN", "account_unavailable")).toContain(
      "未应用此更改",
    );
  });
});
