import { describe, expect, it } from "vitest";
import { legalPageCopy, type LegalPageKind } from "@/components/legal/legal-copy";
import { DATA_DELETION_CONFIRMATION } from "@/lib/account-data";

const pageKinds: LegalPageKind[] = ["privacy", "terms", "data"];

function documentText(locale: "en" | "zh-CN", kind: LegalPageKind) {
  const document = legalPageCopy[locale].documents[kind];
  return [
    document.title,
    document.summary,
    document.status,
    ...document.sections.flatMap((section) => [
      section.title,
      ...section.paragraphs,
      ...(section.bullets ?? []),
    ]),
  ].join(" ");
}

describe("public policy copy", () => {
  it("keeps English and Chinese policy structures aligned", () => {
    for (const kind of pageKinds) {
      expect(
        legalPageCopy["zh-CN"].documents[kind].sections.map(({ id }) => id),
      ).toEqual(
        legalPageCopy.en.documents[kind].sections.map(({ id }) => id),
      );
    }
  });

  it("publishes the effective date and research-only boundary in both languages", () => {
    expect(legalPageCopy.en.effective).toContain("November 12, 2026");
    expect(legalPageCopy["zh-CN"].effective).toContain("2026年11月12日");
    expect(legalPageCopy.en.researchBoundary).toMatch(
      /does not provide personalized investment advice.*execute trades/i,
    );
    expect(legalPageCopy["zh-CN"].researchBoundary).toMatch(
      /不提供个性化投资建议.*不执行交易/,
    );
  });

  it("discloses actual providers, AI processing, retention, and deletion scope", () => {
    const privacy = documentText("en", "privacy");
    const deletion = documentText("en", "data");

    expect(privacy).toMatch(/Alpaca/);
    expect(privacy).toMatch(/SEC EDGAR/);
    expect(privacy).toMatch(/OpenAI Sites/);
    expect(privacy).toMatch(/configured OpenAI model/);
    expect(privacy).toMatch(/five minutes/);
    expect(privacy).toMatch(/six hours/);
    expect(deletion).toMatch(/does not remove/i);
    expect(deletion).toMatch(/ChatGPT identity and account/);
    expect(deletion).toMatch(/dedicated private support mailbox is not yet published/i);
  });

  it("uses the backend confirmation phrase and does not promise permanent closure", () => {
    expect(legalPageCopy.en.deletion.confirmationPlaceholder).toBe(
      DATA_DELETION_CONFIRMATION,
    );
    expect(legalPageCopy["zh-CN"].deletion.confirmationPlaceholder).toBe(
      DATA_DELETION_CONFIRMATION,
    );
    expect(legalPageCopy.en.deletion.body).toMatch(/not permanent account closure/i);
    expect(legalPageCopy["zh-CN"].deletion.body).toMatch(/不代表永久关闭账户/);
  });
});
