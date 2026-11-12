import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockIngestionTickError extends Error {
    constructor(
      readonly code: string,
      readonly stage: string,
      readonly retryable: boolean,
    ) {
      super("safe ingestion failure");
      this.name = "IngestionTickError";
    }
  }
  return {
    runIntelligenceIngestionTick: vi.fn(),
    IngestionTickError: MockIngestionTickError,
  };
});

vi.mock("@/lib/services/intelligence-ingestion", () => ({
  runIntelligenceIngestionTick: mocks.runIntelligenceIngestionTick,
  IngestionTickError: mocks.IngestionTickError,
}));

import { POST } from "@/app/mcp/route";

async function rpc(method: string, params?: unknown, userId?: string) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(userId ? { "oai-authenticated-user-id": userId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return response.json() as Promise<{
    result?: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: unknown;
      tools?: Array<{
        name: string;
        inputSchema: Record<string, unknown>;
      }>;
    };
  }>;
}

async function callTick(args: Record<string, unknown>, userId?: string) {
  const response = await rpc(
    "tools/call",
    { name: "run_intelligence_ingestion_tick", arguments: args },
    userId,
  );
  const result = response.result!;
  return {
    result,
    content: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

describe("operator ingestion MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INGESTION_OPERATOR_USER_ID", "operator-user");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("advertises a closed, zero-argument operator tool", async () => {
    const response = await rpc("tools/list");
    const tool = response.result?.tools?.find(
      (candidate) => candidate.name === "run_intelligence_ingestion_tick",
    );
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("requires authenticated operator identity before invoking ingestion", async () => {
    await expect(callTick({})).resolves.toMatchObject({
      result: { isError: true },
      content: {
        error: "Authentication required.",
        details: { code: "auth_required" },
      },
    });
    await expect(callTick({}, "ordinary-user")).resolves.toMatchObject({
      result: { isError: true },
      content: {
        error: "Operator authorization required.",
        details: { code: "operator_required" },
      },
    });
    expect(mocks.runIntelligenceIngestionTick).not.toHaveBeenCalled();
  });

  it("fails closed when no deployment operator is configured", async () => {
    vi.stubEnv("INGESTION_OPERATOR_USER_ID", "");
    const response = await callTick({}, "operator-user");
    expect(response).toMatchObject({
      result: { isError: true },
      content: {
        error: "Ingestion operator is not configured.",
        details: { code: "ingestion_operator_unconfigured" },
      },
    });
    expect(mocks.runIntelligenceIngestionTick).not.toHaveBeenCalled();
  });

  it("rejects undeclared arguments even for the configured operator", async () => {
    const response = await callTick({ partition: "all" }, "operator-user");
    expect(response).toMatchObject({
      result: { isError: true },
      content: { error: "Invalid tool arguments." },
    });
    expect(mocks.runIntelligenceIngestionTick).not.toHaveBeenCalled();
  });

  it("runs one bounded page without reflecting the operator identity", async () => {
    mocks.runIntelligenceIngestionTick.mockResolvedValue({
      outcome: "processed",
      provider: "alpaca",
      runId: "run-safe-id",
      completedAt: "2026-11-12T08:00:00.000Z",
      hasMore: true,
      receiptCount: 50,
      insertedReceiptCount: 48,
      linkedSymbolCount: 70,
    });
    const response = await callTick({}, "operator-user");

    expect(mocks.runIntelligenceIngestionTick).toHaveBeenCalledOnce();
    expect(response.result.isError).not.toBe(true);
    expect(response.content).toMatchObject({
      data: {
        outcome: "processed",
        provider: "alpaca",
        hasMore: true,
        receiptCount: 50,
      },
      meta: {
        scope: "operator",
        boundedPages: 1,
        tradeExecutionAllowed: false,
      },
    });
    expect(JSON.stringify(response)).not.toContain("operator-user");
  });

  it("returns only the service's bounded safe failure fields", async () => {
    mocks.runIntelligenceIngestionTick.mockRejectedValue(
      new mocks.IngestionTickError("invalid_page_token", "provider_fetch", false),
    );
    const response = await callTick({}, "operator-user");

    expect(response).toMatchObject({
      result: { isError: true },
      content: {
        error: "Ingestion tick failed.",
        details: {
          code: "invalid_page_token",
          stage: "provider_fetch",
          retryable: false,
        },
      },
    });
  });
});
