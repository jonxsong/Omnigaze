import { describe, expect, it } from "vitest";
import {
  personalTodayCopy,
  personalTodayErrorMessage,
} from "@/components/personal-today-copy";

describe("personal Today copy", () => {
  it("keeps the surface neutral when evidence is unavailable or retained", () => {
    expect(personalTodayCopy.en.eyebrow).toBe("WATCHLIST TODAY");
    expect(personalTodayCopy.en.retainedDetail).toContain("original timestamps");
    expect(personalTodayCopy.en.researchBoundary).toContain("No model request");
    expect(personalTodayCopy.en.researchBoundary).toContain("recommendation");
    expect(personalTodayCopy.en.demoDetail).toContain("not current");
    expect(personalTodayCopy.en.nonCurrentDetail).toContain("not presenting it as current");
  });

  it("localizes controls and safety states without translating ticker or source text", () => {
    expect(personalTodayCopy["zh-CN"].title).toContain("今日动态");
    expect(personalTodayCopy["zh-CN"].selectSymbol("NVDA")).toContain("NVDA");
    expect(personalTodayCopy["zh-CN"].sourceTextBoundary).toContain("原始语言");
    expect(personalTodayCopy["zh-CN"].materiality.critical).toContain("关键");
  });

  it("maps only stable application error codes and falls back safely", () => {
    expect(personalTodayErrorMessage("en", "watchlists_unavailable")).toContain(
      "watchlists",
    );
    expect(personalTodayErrorMessage("zh-CN", "unknown-upstream-message")).toBe(
      personalTodayCopy["zh-CN"].errors.fallback,
    );
  });
});
