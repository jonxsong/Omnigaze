import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMoveLens: vi.fn(),
}));

vi.mock("@/lib/services/move-lens", () => ({
  getMoveLens: mocks.getMoveLens,
}));

import { POST } from "@/app/mcp/route";
import { buildMoveLens } from "@/lib/move-lens";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";

const envelope = buildMoveLens({
  selectedSymbolId: "NASDAQ:NVDA",
  selectedSnapshot: undefined,
  benchmarkSnapshots: new Map(),
  evidence: [],
  evidenceReadStatus: "verified",
  evaluatedAt: "2026-11-12T18:00:00.000Z",
});

async function callMcp(method: string, params?: unknown) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
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

async function callTool(args: Record<string, unknown>) {
  const response = await callMcp("tools/call", {
    name: "get_move_lens",
    arguments: args,
  });
  const result = response.body.result!;
  return {
    ...response,
    result,
    content: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

describe("Move Lens MCP parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMoveLens.mockResolvedValue(envelope);
  });

  it("advertises a public, closed, owner-free tool schema", async () => {
    const { body } = await callMcp("tools/list");
    const tools = (body.result as unknown as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
    }).tools;
    const tool = tools.find((candidate) => candidate.name === "get_move_lens");

    expect(tool).toMatchObject({
      name: "get_move_lens",
      inputSchema: {
        type: "object",
        properties: {
          symbol_id: {
            type: "string",
            pattern: "^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$",
          },
        },
        required: ["symbol_id"],
        additionalProperties: false,
      },
    });
    expect(tool?.description).toContain("ETF proxies");
    expect(JSON.stringify(tool)).not.toContain("owner_id");
  });

  it("normalizes the symbol and returns exact content/structuredContent parity", async () => {
    const response = await callTool({ symbol_id: "nasdaq:nvda" });

    expect(mocks.getMoveLens).toHaveBeenCalledWith("NASDAQ:NVDA");
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    expect(response.content).toEqual(envelope);
    expect(response.result.structuredContent).toEqual(envelope);
    expect(response.result.isError).toBeUndefined();
  });

  it("rejects extra owner arguments before invoking the service", async () => {
    const response = await callTool({
      symbol_id: "NASDAQ:NVDA",
      owner_id: "owner-a",
    });

    expect(response.result.isError).toBe(true);
    expect(response.content).toMatchObject({ error: "Invalid tool arguments." });
    expect(mocks.getMoveLens).not.toHaveBeenCalled();
  });

  it("returns stable symbol-resolution failures without provider detail", async () => {
    mocks.getMoveLens.mockRejectedValueOnce(
      new InstrumentResolutionError("symbol_not_supported"),
    );
    const response = await callTool({ symbol_id: "NASDAQ:FAKE" });

    expect(response.result.isError).toBe(true);
    expect(response.content).toEqual({
      error: "Symbol is not supported.",
      details: { code: "symbol_not_supported" },
    });
  });
});
