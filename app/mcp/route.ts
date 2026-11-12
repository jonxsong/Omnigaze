import { z } from "zod";
import {
  getDefaultWatchlistDashboard,
  getOmnigazeView,
  searchSymbols,
  serviceMeta,
} from "@/lib/services/market-intelligence";
import { liveMarketData } from "@/lib/services/live-market-data";
import type { CanonicalSymbol } from "@/lib/market-types";

export const dynamic = "force-dynamic";

const MCP_VERSION = "2026-07-28";
const canonicalSymbolPattern = "^[A-Z0-9._-]+:[A-Z0-9._-]+$";

const tools = [
  {
    name: "search_symbols",
    description: "Find supported stocks by ticker or company name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 120 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_market_snapshot",
    description:
      "Return a timestamped market snapshot with provider and delay metadata.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: { type: "string", pattern: canonicalSymbolPattern },
      },
      required: ["symbol_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_intelligence_feed",
    description:
      "Return evidence-backed market events, optionally filtered to one symbol.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: { type: "string", pattern: canonicalSymbolPattern },
        minimum_materiality: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          default: "low",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        since: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_omnigaze_view",
    description:
      "Return Omnigaze's current interpretation with evidence and uncertainty.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: { type: "string", pattern: canonicalSymbolPattern },
      },
      required: ["symbol_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_watchlist_dashboard",
    description:
      "Return the authenticated user's watchlist dashboard and latest material events.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_provider_status",
    description:
      "Report which market, news, and filing providers are configured and healthy.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

const symbolSchema = z
  .string()
  .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
  .transform((value) => value as CanonicalSymbol);

const callSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
) {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function toolContent(data: unknown, meta: object = serviceMeta) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ data, meta }, null, 2),
      },
    ],
  };
}

function toolError(message: string, details?: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, details }, null, 2),
      },
    ],
    isError: true,
  };
}

function validationError(error: z.ZodError) {
  return toolError("Invalid tool arguments.", error.flatten());
}

async function callTool(name: string, args: Record<string, unknown>, request: Request) {
  try {
    switch (name) {
      case "search_symbols": {
        const parsed = z.object({ query: z.string().max(120) }).safeParse(args);
        return parsed.success
          ? toolContent(searchSymbols(parsed.data.query))
          : validationError(parsed.error);
      }
      case "get_market_snapshot": {
        const parsed = z.object({ symbol_id: symbolSchema }).safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const result = await liveMarketData.getSnapshot(parsed.data.symbol_id);
        return result.data
          ? toolContent(result.data, {
              ...result.meta,
              asOf: result.data.asOf,
              isDelayed: result.data.isDelayed,
              provider: result.data.provider,
            })
          : toolError("Symbol not found.");
      }
      case "get_intelligence_feed": {
        const parsed = z
          .object({
            symbol_id: symbolSchema.optional(),
            minimum_materiality: z
              .enum(["low", "medium", "high", "critical"])
              .optional()
              .default("low"),
            limit: z.number().int().min(1).max(100).optional().default(20),
            since: z.string().datetime({ offset: true }).optional(),
          })
          .safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const result = await liveMarketData.getIntelligenceFeed({
          symbols: parsed.data.symbol_id ? [parsed.data.symbol_id] : undefined,
          minimumMateriality: parsed.data.minimum_materiality,
          limit: parsed.data.limit,
          since:
            parsed.data.since ??
            new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
        });
        return toolContent(result.data, result.meta);
      }
      case "get_omnigaze_view": {
        const parsed = z.object({ symbol_id: symbolSchema }).safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const view = getOmnigazeView(parsed.data.symbol_id);
        return view ? toolContent(view) : toolError("Symbol not found.");
      }
      case "get_watchlist_dashboard": {
        const userId = request.headers.get("oai-authenticated-user-id") ?? "local-preview";
        return toolContent(getDefaultWatchlistDashboard(), {
          ownerScope: userId,
        });
      }
      case "get_provider_status": {
        return toolContent(await liveMarketData.getProviderStatus(), {
          generatedAt: new Date().toISOString(),
        });
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return toolError(
      "Tool execution failed.",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

export async function POST(request: Request) {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body?.id, -32600, "Invalid Request");
  }

  switch (body.method) {
    case "server/discover":
      return jsonRpcResult(body.id, {
        name: "omnigaze",
        title: "Omnigaze Market Intelligence",
        version: "0.1.0",
        supportedVersions: [MCP_VERSION],
        capabilities: { tools: {} },
      });
    case "tools/list":
      return jsonRpcResult(body.id, { tools });
    case "tools/call": {
      const parsed = callSchema.safeParse(body.params);
      if (!parsed.success) {
        return jsonRpcResult(body.id, validationError(parsed.error));
      }
      return jsonRpcResult(
        body.id,
        await callTool(
          parsed.data.name,
          parsed.data.arguments as Record<string, unknown>,
          request,
        ),
      );
    }
    default:
      return jsonRpcError(body.id, -32601, "Method not found");
  }
}
