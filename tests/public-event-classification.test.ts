import { describe, expect, it } from "vitest";
import { classifyPublicEvent } from "@/lib/pipeline/classify-public-event";

describe("public-event classification", () => {
  it("surfaces an official CEO/board investigation as high-materiality governance", () => {
    expect(
      classifyPublicEvent({
        headline: "Board launches independent investigation involving CEO",
        summary: "The company announced the review after recent reporting.",
        sourceKind: "licensed_news",
      }),
    ).toMatchObject({
      category: "governance",
      materiality: "high",
      claimStatus: "official-investigation",
      causalLink: "unassessed",
      isControversial: true,
    });
  });

  it("labels allegations without converting them into confirmed facts", () => {
    expect(
      classifyPublicEvent({
        headline: "Executive accused in misconduct allegation",
        sourceKind: "licensed_news",
      }),
    ).toMatchObject({
      category: "executive",
      claimStatus: "allegation",
    });
  });

  it("preserves corrections and disputes as first-class states", () => {
    expect(
      classifyPublicEvent({
        headline: "Company issues correction to disputed report",
        sourceKind: "licensed_news",
      }).claimStatus,
    ).toBe("corrected");
  });

  it("does not mark ordinary product news as controversial", () => {
    expect(
      classifyPublicEvent({
        headline: "Company launches a new accelerator platform",
        sourceKind: "licensed_news",
      }),
    ).toMatchObject({
      category: "market",
      isControversial: false,
      claimStatus: "reported",
    });
  });
});
