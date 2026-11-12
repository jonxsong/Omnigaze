import { describe, expect, it } from "vitest";
import { intelligenceInboxCopy } from "@/components/intelligence-inbox-copy";

describe("intelligence inbox locale copy", () => {
  it("keeps every top-level English and Chinese section aligned", () => {
    expect(Object.keys(intelligenceInboxCopy["zh-CN"]).sort()).toEqual(
      Object.keys(intelligenceInboxCopy.en).sort(),
    );
  });

  it("localizes dynamic status, accessibility, and time labels", () => {
    const chinese = intelligenceInboxCopy["zh-CN"];

    expect(chinese.tabs.inboxUnread(3)).toBe("收件箱，3 条未读");
    expect(chinese.rules.enableAria("NVDA")).toContain("NVDA");
    expect(chinese.time.minutesAgo(5)).toBe("5 分钟前");
    expect(chinese.errors.inboxRefresh(503)).toContain("503");
    expect(chinese.event.controversy).toBe("争议事件");
  });

  it("retains source-domain labels as explicit localized classifications", () => {
    const chinese = intelligenceInboxCopy["zh-CN"];

    expect(chinese.category.governance).toBe("公司治理");
    expect(chinese.claimStatus["official-investigation"]).toBe("官方调查中");
    expect(chinese.materiality.critical).toBe("重大影响");
  });
});
