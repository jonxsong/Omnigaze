import { beforeEach, describe, expect, it, vi } from "vitest";
import { OmnigazeAiGuardError } from "@/lib/ai/omnigaze-view-guard";

const mocks = vi.hoisted(() => {
  class MockOmnigazeViewError extends Error {
    readonly status = 422;

    constructor(readonly code: string, message: string) {
      super(message);
      this.name = "OmnigazeViewError";
    }
  }
  return {
    generateOmnigazeView: vi.fn(),
    OmnigazeViewError: MockOmnigazeViewError,
  };
});

vi.mock("@/lib/services/omnigaze-view", () => ({
  generateOmnigazeView: mocks.generateOmnigazeView,
  OmnigazeViewError: mocks.OmnigazeViewError,
}));

import { POST } from "@/app/mcp/route";

async function callView(
  authenticated = true,
  args: Record<string, unknown> = { symbol_id: "NYSE:IBM" },
) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated
          ? { "oai-authenticated-user-id": "trusted-user" }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_omnigaze_view",
          arguments: args,
        },
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

describe("MCP live Omnigaze View parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateOmnigazeView.mockResolvedValue({
      data: {
        stance: "mixed",
        confidence: 0.6,
        headline: "Evidence is mixed",
        summary: "Current evidence contains supportive and limiting signals.",
        whyNow: "A new source event changed the evidence set.",
        drivers: [
          {
            label: "Company update",
            direction: "mixed",
            explanation: "The update adds current context.",
            evidenceIds: ["evidence:alpaca:ibm-news-1"],
          },
        ],
        unknowns: ["Durability remains unknown."],
      },
      meta: {
        symbolId: "NYSE:IBM",
        dataMode: "live",
        freshness: {
          state: "fresh",
          asOf: "2026-11-12T17:59:00.000Z",
          ageSeconds: 60,
        },
        citations: [],
      },
    });
  });

  it("requires a trusted authenticated identity before model work", async () => {
    const body = await callView(false);

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      error: "Authentication required.",
      details: { code: "auth_required" },
    });
    expect(mocks.generateOmnigazeView).not.toHaveBeenCalled();
  });

  it("returns the same live view contract with authenticated MCP metadata", async () => {
    const body = await callView(true, {
      symbol_id: "NYSE:IBM",
      request_id: "mcp-request-1",
    });

    expect(mocks.generateOmnigazeView).toHaveBeenCalledWith("NYSE:IBM", {
      ownerId: "trusted-user",
      requestId: "mcp-request-1",
    });
    expect(body.result.structuredContent).toMatchObject({
      data: { stance: "mixed", confidence: 0.6 },
      meta: {
        symbolId: "NYSE:IBM",
        dataMode: "live",
        scope: "personal",
        identity: "authenticated",
      },
    });
  });

  it("preserves stable evidence-gate error codes", async () => {
    mocks.generateOmnigazeView.mockRejectedValue(
      new mocks.OmnigazeViewError(
        "fresh_evidence_required",
        "Fresh provider evidence is required for an Omnigaze View.",
      ),
    );

    const body = await callView();

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      details: { code: "fresh_evidence_required" },
    });
  });

  it("preserves safe budget retry metadata", async () => {
    mocks.generateOmnigazeView.mockRejectedValue(
      new OmnigazeAiGuardError(
        "ai_rate_limited",
        "2026-11-12T18:02:00.000Z",
        120,
        "rolling_limit",
      ),
    );

    const body = await callView();

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
});
