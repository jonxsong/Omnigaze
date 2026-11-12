import { describe, expect, it } from "vitest";
import {
  dailyBriefCopy,
  dailyBriefErrorMessage,
} from "@/components/daily-brief-copy";
import {
  omnigazeViewCopy,
  omnigazeViewErrorMessage,
} from "@/components/omnigaze-view-copy";

describe("AI surface localization copy", () => {
  it("keeps stable English labels while providing complete Chinese equivalents", () => {
    expect(dailyBriefCopy.en.title).toBe("Daily Brief");
    expect(dailyBriefCopy["zh-CN"].title).toBe("每日简报");
    expect(dailyBriefCopy["zh-CN"].direction.negative).toBe("负面");
    expect(dailyBriefCopy["zh-CN"].coverage.strong).toBe("充分");

    expect(omnigazeViewCopy.en.stance.bullish).toBe("Constructive");
    expect(omnigazeViewCopy["zh-CN"].stance.bullish).toBe("偏积极");
    expect(omnigazeViewCopy["zh-CN"].providerCoverage.partial).toBe("部分");
  });

  it("maps known errors to localized safe messages", () => {
    expect(dailyBriefErrorMessage("zh-CN", "empty_watchlist")).toContain(
      "自选股",
    );
    expect(
      omnigazeViewErrorMessage("zh-CN", "fresh_evidence_required"),
    ).toContain("最新");
  });

  it("uses a bounded localized fallback for unknown server codes", () => {
    const arbitraryCode = "do-not-reflect-provider-secret";

    expect(dailyBriefErrorMessage("zh-CN", arbitraryCode)).toBe(
      dailyBriefCopy["zh-CN"].errors.fallback,
    );
    expect(omnigazeViewErrorMessage("zh-CN", arbitraryCode)).toBe(
      omnigazeViewCopy["zh-CN"].errors.fallback,
    );
    expect(dailyBriefErrorMessage("zh-CN", arbitraryCode)).not.toContain(
      arbitraryCode,
    );
    expect(omnigazeViewErrorMessage("zh-CN", arbitraryCode)).not.toContain(
      arbitraryCode,
    );
  });

  it("localizes dynamic usage, citation, and accessibility labels", () => {
    expect(dailyBriefCopy["zh-CN"].evidenceSummary(3, 2)).toBe(
      "3 条引证 · 2 个来源",
    );
    expect(dailyBriefCopy["zh-CN"].openSource("NVIDIA filing")).toBe(
      "打开来源：NVIDIA filing",
    );
    expect(omnigazeViewCopy["zh-CN"].driverCount(2)).toBe(
      "2 个有依据的信号",
    );
    expect(
      omnigazeViewCopy["zh-CN"].footerSummary("部分", "2026/11/12"),
    ).toBe("实时 · 部分覆盖 · 证据截至 2026/11/12");
  });
});
