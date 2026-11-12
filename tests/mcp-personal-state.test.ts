import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockInstrumentResolutionError extends Error {
    constructor(
      readonly code: "symbol_not_supported" | "asset_catalog_unavailable",
    ) {
      super(code);
    }
  }

  class MockWatchlistRepositoryError extends Error {
    constructor(readonly code: "watchlist_not_found" | "symbol_not_supported") {
      super(code);
    }
  }

  class MockPortfolioRepositoryError extends Error {
    constructor(
      readonly code:
        | "asset_catalog_unavailable"
        | "holding_not_found"
        | "holding_version_conflict"
        | "profile_version_conflict"
        | "symbol_not_supported",
    ) {
      super(code);
    }
  }

  class MockInboxRepositoryError extends Error {
    constructor(readonly code: "not_found" | "conflict") {
      super(code);
    }
  }

  return {
    addSymbolToWatchlist: vi.fn(),
    removeSymbolFromWatchlist: vi.fn(),
    resolveCanonicalInstrument: vi.fn(),
    putPortfolioHolding: vi.fn(),
    updateIntelligenceInboxState: vi.fn(),
    putAlertRule: vi.fn(),
    InstrumentResolutionError: MockInstrumentResolutionError,
    WatchlistRepositoryError: MockWatchlistRepositoryError,
    PortfolioRepositoryError: MockPortfolioRepositoryError,
    InboxRepositoryError: MockInboxRepositoryError,
  };
});

vi.mock("@/lib/services/instrument-resolution", () => ({
  resolveCanonicalInstrument: mocks.resolveCanonicalInstrument,
  InstrumentResolutionError: mocks.InstrumentResolutionError,
}));

vi.mock("@/lib/repositories/watchlists", () => ({
  addSymbolToWatchlist: mocks.addSymbolToWatchlist,
  removeSymbolFromWatchlist: mocks.removeSymbolFromWatchlist,
  WatchlistRepositoryError: mocks.WatchlistRepositoryError,
}));

vi.mock("@/lib/repositories/portfolio", () => ({
  putPortfolioHolding: mocks.putPortfolioHolding,
  PortfolioRepositoryError: mocks.PortfolioRepositoryError,
}));

vi.mock("@/lib/intelligence-inbox/service", () => ({
  updateIntelligenceInboxState: mocks.updateIntelligenceInboxState,
  putAlertRule: mocks.putAlertRule,
}));

vi.mock("@/lib/intelligence-inbox/repository", () => ({
  InboxRepositoryError: mocks.InboxRepositoryError,
}));

import { POST } from "@/app/mcp/route";

type ToolResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function callTool(
  name: string,
  args: Record<string, unknown>,
  userId?: string,
) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(userId ? { "oai-authenticated-user-id": userId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await response.json()) as { result: ToolResult };
  return {
    response,
    result: body.result,
    content: JSON.parse(body.result.content[0].text) as Record<string, unknown>,
  };
}

async function listTools() {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const body = (await response.json()) as {
    result: {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
    };
  };
  return body.result.tools;
}

const holdingInput = () => ({
  symbol_id: "nasdaq:nvda",
  quantity: "15",
  average_cost: "120.25",
  cost_currency: "USD",
  quantity_as_of: new Date(Date.now() - 60_000).toISOString(),
  expected_version: 0,
});

const inboxInput = {
  event_id: "alpaca:event-1",
  read: true,
  saved: true,
  dismissed: false,
  expected_version: 2,
  expected_event_revision: 1,
};

const alertInput = {
  symbol_id: "nasdaq:nvda",
  enabled: true,
  minimum_materiality: "high",
  include_controversy: true,
  expected_version: 0,
};

describe("MCP authenticated personal-state parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCanonicalInstrument.mockResolvedValue({
      id: "NASDAQ:NVDA",
      ticker: "NVDA",
      exchange: "NASDAQ",
      name: "NVIDIA Corporation",
      sector: "Technology",
      currency: "USD",
      status: "active",
    });
  });

  it("advertises four closed, owner-derived, non-executing mutation tools", async () => {
    const tools = await listTools();
    const names = [
      "update_watchlist",
      "put_portfolio_holding",
      "update_intelligence_inbox_item",
      "put_alert_rule",
    ];

    for (const name of names) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(JSON.stringify(tool)).not.toContain("owner_id");
    }
    expect(
      tools.find((tool) => tool.name === "put_portfolio_holding")
        ?.description,
    ).toContain("never places an order");
  });

  it.each([
    [
      "update_watchlist",
      {
        operation: "add",
        watchlist_id: "core",
        symbol_id: "NASDAQ:NVDA",
      },
    ],
    ["put_portfolio_holding", holdingInput()],
    ["update_intelligence_inbox_item", inboxInput],
    ["put_alert_rule", alertInput],
  ])("requires trusted identity before %s", async (name, args) => {
    const response = await callTool(name, args as Record<string, unknown>);

    expect(response.result.isError).toBe(true);
    expect(response.content).toEqual({
      error: "Authentication required.",
      details: { code: "auth_required" },
    });
  });

  it("updates only the authenticated owner's verified watchlist", async () => {
    mocks.addSymbolToWatchlist.mockResolvedValue({
      watchlistId: "core",
      symbolId: "NASDAQ:NVDA",
    });

    const response = await callTool(
      "update_watchlist",
      {
        operation: "add",
        watchlist_id: "core",
        symbol_id: "nasdaq:nvda",
      },
      "owner-a",
    );

    expect(mocks.resolveCanonicalInstrument).toHaveBeenCalledWith(
      "NASDAQ:NVDA",
    );
    expect(mocks.addSymbolToWatchlist).toHaveBeenCalledWith(
      "owner-a",
      "core",
      "NASDAQ:NVDA",
      expect.objectContaining({ id: "NASDAQ:NVDA" }),
    );
    expect(response.content).toMatchObject({
      data: { watchlistId: "core", symbolId: "NASDAQ:NVDA" },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        operation: "add",
        tradeExecutionAllowed: false,
      },
    });
    expect(response.result.structuredContent).toEqual(response.content);
    expect(JSON.stringify(response.content)).not.toContain("owner-a");
  });

  it("removes a watchlist symbol without an unnecessary provider lookup", async () => {
    mocks.removeSymbolFromWatchlist.mockResolvedValue({
      watchlistId: "core",
      symbolId: "NASDAQ:NVDA",
    });

    await callTool(
      "update_watchlist",
      {
        operation: "remove",
        watchlist_id: "core",
        symbol_id: "NASDAQ:NVDA",
      },
      "owner-a",
    );

    expect(mocks.resolveCanonicalInstrument).not.toHaveBeenCalled();
    expect(mocks.removeSymbolFromWatchlist).toHaveBeenCalledWith(
      "owner-a",
      "core",
      "NASDAQ:NVDA",
    );
  });

  it("forwards exact holding decimals and optimistic version for the authenticated owner", async () => {
    const input = holdingInput();
    mocks.putPortfolioHolding.mockResolvedValue({
      symbolId: "NASDAQ:NVDA",
      quantity: "15",
      averageCost: "120.25",
      version: 1,
    });

    const response = await callTool(
      "put_portfolio_holding",
      input,
      "owner-a",
    );

    expect(mocks.putPortfolioHolding).toHaveBeenCalledWith(
      "owner-a",
      "NASDAQ:NVDA",
      {
        quantity: "15",
        average_cost: "120.25",
        cost_currency: "USD",
        quantity_as_of: input.quantity_as_of,
        expected_version: 0,
      },
    );
    expect(response.content).toMatchObject({
      data: { symbolId: "NASDAQ:NVDA", version: 1 },
      meta: {
        purpose: "portfolio_context",
        tradeExecutionAllowed: false,
      },
    });
    expect(JSON.stringify(response.content)).not.toContain("owner-a");
  });

  it("preserves durable inbox replay metadata and complete desired state", async () => {
    mocks.updateIntelligenceInboxState.mockResolvedValue({
      data: {
        eventId: "alpaca:event-1",
        eventRevision: 1,
        state: {
          read: true,
          saved: true,
          dismissed: false,
          version: 3,
        },
      },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        replayed: true,
      },
    });

    const response = await callTool(
      "update_intelligence_inbox_item",
      inboxInput,
      "owner-a",
    );

    expect(mocks.updateIntelligenceInboxState).toHaveBeenCalledWith(
      "owner-a",
      "alpaca:event-1",
      {
        read: true,
        saved: true,
        dismissed: false,
        expected_version: 2,
        expected_event_revision: 1,
      },
    );
    expect(response.content).toMatchObject({
      data: { eventId: "alpaca:event-1" },
      meta: { replayed: true, persistence: "server" },
    });
    expect(response.result.structuredContent).toEqual(response.content);
  });

  it("canonicalizes and persists an in-app controversy alert rule", async () => {
    mocks.putAlertRule.mockResolvedValue({
      data: {
        rule: {
          symbol: { id: "NASDAQ:NVDA" },
          enabled: true,
          includeControversy: true,
          version: 1,
        },
      },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        channel: "in_app",
        replayed: false,
      },
    });

    const response = await callTool(
      "put_alert_rule",
      alertInput,
      "owner-a",
    );

    expect(mocks.putAlertRule).toHaveBeenCalledWith(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "high",
        include_controversy: true,
        expected_version: 0,
      },
    );
    expect(response.content).toMatchObject({
      data: { rule: { enabled: true, version: 1 } },
      meta: { channel: "in_app", replayed: false },
    });
    expect(JSON.stringify(response.content)).not.toContain("owner-a");
  });

  it.each([
    [
      "update_watchlist",
      {
        operation: "add",
        watchlist_id: "core",
        symbol_id: "NASDAQ:NVDA",
        owner_id: "owner-b",
      },
    ],
    ["put_portfolio_holding", { ...holdingInput(), owner_id: "owner-b" }],
    [
      "update_intelligence_inbox_item",
      { ...inboxInput, owner_id: "owner-b" },
    ],
    ["put_alert_rule", { ...alertInput, owner_id: "owner-b" }],
  ])("rejects undeclared caller identity for %s", async (name, args) => {
    const response = await callTool(
      name,
      args as Record<string, unknown>,
      "owner-a",
    );

    expect(response.result.isError).toBe(true);
    expect(response.content).toMatchObject({
      error: "Invalid tool arguments.",
    });
    expect(mocks.addSymbolToWatchlist).not.toHaveBeenCalled();
    expect(mocks.putPortfolioHolding).not.toHaveBeenCalled();
    expect(mocks.updateIntelligenceInboxState).not.toHaveBeenCalled();
    expect(mocks.putAlertRule).not.toHaveBeenCalled();
  });

  it("maps optimistic conflicts and missing owner-scoped records without leaking internals", async () => {
    mocks.putPortfolioHolding.mockRejectedValueOnce(
      new mocks.PortfolioRepositoryError("holding_version_conflict"),
    );
    mocks.updateIntelligenceInboxState.mockRejectedValueOnce(
      new mocks.InboxRepositoryError("conflict"),
    );
    mocks.putAlertRule.mockRejectedValueOnce(
      new mocks.InboxRepositoryError("not_found"),
    );
    mocks.removeSymbolFromWatchlist.mockRejectedValueOnce(
      new mocks.WatchlistRepositoryError("watchlist_not_found"),
    );

    const responses = await Promise.all([
      callTool("put_portfolio_holding", holdingInput(), "owner-a"),
      callTool("update_intelligence_inbox_item", inboxInput, "owner-a"),
      callTool("put_alert_rule", alertInput, "owner-a"),
      callTool(
        "update_watchlist",
        {
          operation: "remove",
          watchlist_id: "missing",
          symbol_id: "NASDAQ:NVDA",
        },
        "owner-a",
      ),
    ]);

    expect(responses.map(({ content }) => content)).toEqual([
      {
        error: "Holding changed. Refresh before saving again.",
        details: { code: "version_conflict" },
      },
      {
        error: "Inbox item changed. Refresh before saving again.",
        details: { code: "version_conflict" },
      },
      {
        error: "Tracked symbol not found.",
        details: { code: "alert_rule_not_found" },
      },
      {
        error: "Watchlist not found.",
        details: { code: "watchlist_not_found" },
      },
    ]);
  });

  it("redacts unexpected mutation failures with a tool-scoped request id", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.putPortfolioHolding.mockRejectedValue(
      new Error("private database binding and provider credential"),
    );

    const response = await callTool(
      "put_portfolio_holding",
      holdingInput(),
      "owner-a",
    );

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
    expect(JSON.stringify(response.content)).not.toContain("credential");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("credential");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("owner-a");
    expect(errorSpy).toHaveBeenCalledWith(
      "omnigaze.unexpected_failure",
      expect.objectContaining({ operation: "mcp.put_portfolio_holding" }),
    );
    errorSpy.mockRestore();
  });
});
