import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIntelligenceInbox: vi.fn(),
  getAlertRules: vi.fn(),
}));

vi.mock("@/lib/intelligence-inbox/service", () => ({
  getIntelligenceInbox: mocks.getIntelligenceInbox,
  getAlertRules: mocks.getAlertRules,
}));

import { POST } from "@/app/mcp/route";

async function callMcp(method: string, params?: unknown, userId?: string) {
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
  return {
    response,
    body: (await response.json()) as {
      result?: {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      };
    },
  };
}

async function callTool(
  name: "get_intelligence_inbox" | "get_alert_rules",
  args: Record<string, unknown>,
  userId?: string,
) {
  const result = await callMcp(
    "tools/call",
    { name, arguments: args },
    userId,
  );
  const toolResult = result.body.result!;
  return {
    response: result.response,
    result: toolResult,
    content: JSON.parse(toolResult.content[0].text) as Record<string, unknown>,
  };
}

describe("intelligence inbox MCP parity", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("advertises closed read-only inbox and alert-rule schemas", async () => {
    const { body } = await callMcp("tools/list");
    const tools = (body.result as unknown as {
      tools: Array<{
        name: string;
        inputSchema: Record<string, unknown>;
      }>;
    }).tools;

    const inbox = tools.find((tool) => tool.name === "get_intelligence_inbox");
    const rules = tools.find((tool) => tool.name === "get_alert_rules");

    expect(inbox?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        filter: { enum: ["all", "unread", "saved", "alerts"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    });
    expect(rules?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it.each(["get_intelligence_inbox", "get_alert_rules"] as const)(
    "requires trusted identity for %s",
    async (name) => {
      const response = await callTool(name, {});

      expect(response.result.isError).toBe(true);
      expect(response.content).toMatchObject({
        error: "Authentication required.",
        details: { code: "auth_required" },
      });
      expect(mocks.getIntelligenceInbox).not.toHaveBeenCalled();
      expect(mocks.getAlertRules).not.toHaveBeenCalled();
    },
  );

  it("returns the same inbox data and metadata as the domain service", async () => {
    const payload = {
      data: {
        items: [],
        counts: { all: 0, unread: 0, saved: 0, alerts: 0 },
        rules: [],
      },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        channel: "in_app",
        filter: "unread",
        limit: 12,
        sync: {
          status: "provider_unavailable",
          checkedAt: "2026-11-12T08:00:00.000Z",
          dataMode: null,
          freshness: null,
          providerCoverage: null,
          baselineApplied: false,
          hasMoreCandidates: false,
          newItemCount: 0,
          newDeliveryCount: 0,
          notice: "Stored intelligence is still available.",
        },
        generatedAt: "2026-11-12T08:00:00.000Z",
      },
    };
    mocks.getIntelligenceInbox.mockResolvedValue(payload);

    const response = await callTool(
      "get_intelligence_inbox",
      { filter: "unread", limit: 12 },
      "owner-a",
    );

    expect(mocks.getIntelligenceInbox).toHaveBeenCalledWith("owner-a", {
      filter: "unread",
      limit: 12,
    });
    expect(response.content).toEqual(payload);
    expect(response.result.structuredContent).toEqual(payload);
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(response.content)).not.toContain("owner-a");
  });

  it("uses the inbox service defaults when arguments are omitted", async () => {
    mocks.getIntelligenceInbox.mockResolvedValue({
      data: { items: [], counts: {}, rules: [] },
      meta: {},
    });

    await callTool("get_intelligence_inbox", {}, "owner-a");

    expect(mocks.getIntelligenceInbox).toHaveBeenCalledWith("owner-a", {
      filter: "all",
      limit: 50,
    });
  });

  it("returns the same alert rules data and metadata as the domain service", async () => {
    const payload = {
      data: {
        rules: [
          {
            symbol: {
              id: "NASDAQ:NVDA",
              ticker: "NVDA",
              exchange: "NASDAQ",
              name: "NVIDIA",
            },
            enabled: true,
            minimumMateriality: "high",
            includeControversy: true,
            channel: "in_app",
            version: 2,
            persisted: true,
            createdAt: "2026-11-12T08:00:00.000Z",
            updatedAt: "2026-11-12T08:01:00.000Z",
          },
        ],
      },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        channel: "in_app",
        generatedAt: "2026-11-12T08:02:00.000Z",
      },
    };
    mocks.getAlertRules.mockResolvedValue(payload);

    const response = await callTool("get_alert_rules", {}, "owner-a");

    expect(mocks.getAlertRules).toHaveBeenCalledWith("owner-a");
    expect(response.content).toEqual(payload);
    expect(response.result.structuredContent).toEqual(payload);
  });

  it.each([
    ["get_intelligence_inbox", { owner_id: "someone-else" }],
    ["get_intelligence_inbox", { filter: "dismissed" }],
    ["get_intelligence_inbox", { limit: "10" }],
    ["get_alert_rules", { owner_id: "someone-else" }],
  ] as const)("rejects undeclared or malformed arguments for %s", async (name, args) => {
    const response = await callTool(name, args, "owner-a");

    expect(response.result.isError).toBe(true);
    expect(response.content).toMatchObject({ error: "Invalid tool arguments." });
    expect(mocks.getIntelligenceInbox).not.toHaveBeenCalled();
    expect(mocks.getAlertRules).not.toHaveBeenCalled();
  });

  it("sanitizes service failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getIntelligenceInbox.mockRejectedValue(
      new Error("sensitive D1 binding details"),
    );

    const response = await callTool("get_intelligence_inbox", {}, "owner-a");

    expect(response.result.isError).toBe(true);
    expect(response.content).toMatchObject({
      error: "Tool execution failed.",
      details: {
        code: "tool_execution_failed",
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      },
    });
    expect(JSON.stringify(response.content)).not.toContain("sensitive");
    const requestId = (response.content.details as { requestId: string })
      .requestId;
    expect(errorSpy).toHaveBeenCalledWith(
      "omnigaze.unexpected_failure",
      expect.objectContaining({
        event: "omnigaze.unexpected_failure",
        operation: "mcp.get_intelligence_inbox",
        requestId,
        failureKind: "error",
      }),
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("sensitive");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("owner-a");
  });
});
