import { describe, expect, it } from "vitest";
import { portfolioWorkspaceCopy } from "@/components/portfolio-workspace-copy";

describe("portfolio workspace copy", () => {
  it("keeps complete English and Chinese dictionaries in lockstep", () => {
    expect(Object.keys(portfolioWorkspaceCopy["zh-CN"]).sort()).toEqual(
      Object.keys(portfolioWorkspaceCopy.en).sort(),
    );
  });

  it("localizes the safety boundary and validation paths", () => {
    const copy = portfolioWorkspaceCopy["zh-CN"];

    expect(copy.researchNotRecommendation).toContain("并非建议");
    expect(copy.researchOnly).toContain("不执行交易");
    expect(copy.invalidQuantity).toContain("六位小数");
    expect(copy.liveMarketRequired).toContain("演示价格");
    expect(copy.positionChanged).toContain("草稿仍已保留");
    expect(copy.consolidatedCoverage).toBe("综合市场覆盖");
    expect(copy.consolidatedCoverage).not.toContain("consolidated");
  });
});
