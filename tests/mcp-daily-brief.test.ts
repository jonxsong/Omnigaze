import { beforeEach, describe, expect, it, vi } from "vitest";
import { OmnigazeAiGuardError } from "@/lib/ai/omnigaze-view-guard";

const mocks = vi.hoisted(() => {
  class MockDailyBriefServiceError extends Error {
    readonly status = 422;

    constructor(readonly code: string, message: string) {
      super(message);
      this.name = "DailyBriefServiceError";
    }
  }
  return {
    generatePersonalDailyBrief: vi.fn(),
    DailyBriefServiceError: MockDailyBriefServiceError,
  };
});

vi.mock("@/lib/services/personal-daily-brief", () => ({
  generatePersonalDailyBrief: mocks.generatePersonalDailyBrief,
  DailyBriefServiceError: mocks.DailyBriefServiceError,
}));

import { POST } from "@/app/mcp/route";

async function callBrief(
  authenticated = true,
  args: Record<string, unknown> = {},
) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated
          ? { "oai-authenticated-user-id": "daily-brief-owner" }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "daily-brief-test",
        method: "tools/call",
        params: { name: "get_daily_brief", arguments: args },
      }),
    }),
  );
  return response.json() as Promise<{
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: { data: unknown; meta: Record<string, unknown> };
    };
  }>;
}

describe("MCP personalized Daily Brief parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generatePersonalDailyBrief.mockResolvedValue({
      data: {
        headline: "Two tracked companies changed today",
        summary: "Fresh evidence changed the watchlist context.",
        developments: [],
        watchNext: ["Watch for company confirmation."],
        unknowns: ["The durability of the reaction remains unknown."],
        briefDate: "2026-11-12",
        window: {
          since: "2026-11-11T18:00:00.000Z",
          through: "2026-11-12T18:00:00.000Z",
        },
      },
      meta: {
        dataMode: "live",
        trackedSymbolCount: 3,
        includedSymbolCount: 2,
        omittedSymbolCount: 1,
        citations: [],
        cache: { state: "generated" },
      },
    });
  });

  it("requires trusted identity before any model work", async () => {
    const body = await callBrief(false);

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      error: "Authentication required.",
      details: { code: "auth_required" },
    });
    expect(mocks.generatePersonalDailyBrief).not.toHaveBeenCalled();
  });

  it("returns the personal brief with MCP scope and retry identity parity", async () => {
    const body = await callBrief(true, {
      request_id: "brief-request-1",
      locale: "zh-CN",
    });

    expect(mocks.generatePersonalDailyBrief).toHaveBeenCalledWith(
      "daily-brief-owner",
      { requestId: "brief-request-1", locale: "zh-CN" },
    );
    expect(body.result.structuredContent).toMatchObject({
      data: { headline: "Two tracked companies changed today" },
      meta: {
        dataMode: "live",
        trackedSymbolCount: 3,
        scope: "personal",
        identity: "authenticated",
        tradeExecutionAllowed: false,
      },
    });
  });

  it("preserves stable evidence-gate errors", async () => {
    mocks.generatePersonalDailyBrief.mockRejectedValue(
      new mocks.DailyBriefServiceError(
        "insufficient_evidence",
        "Fresh evidence is insufficient for a Daily Brief.",
      ),
    );

    const body = await callBrief();

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      details: { code: "insufficient_evidence" },
    });
  });

  it("preserves safe shared-budget retry metadata", async () => {
    mocks.generatePersonalDailyBrief.mockRejectedValue(
      new OmnigazeAiGuardError(
        "ai_rate_limited",
        "2026-11-12T18:02:00.000Z",
        120,
        "rolling_limit",
      ),
    );

    const body = await callBrief();

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      details: {
        code: "ai_rate_limited",
        retryAt: "2026-11-12T18:02:00.000Z",
        retryAfterSeconds: 120,
        budgetReason: "rolling_limit",
      },
    });
  });

  it("rejects malformed idempotency keys without invoking the service", async () => {
    const body = await callBrief(true, { request_id: "bad key" });

    expect(body.result.isError).toBe(true);
    expect(mocks.generatePersonalDailyBrief).not.toHaveBeenCalled();
  });
});
