import { z } from "zod";
import {
  getOmnigazeView,
  serviceMeta,
} from "@/lib/services/market-intelligence";
import { liveMarketData } from "@/lib/services/live-market-data";
import {
  extractCanonicalSymbols,
  filterFeedToSymbols,
  summarizeWatchlists,
} from "@/lib/api/personal-intelligence";
import type { CanonicalSymbol } from "@/lib/market-types";
import { parsePortfolioDecisionSupportRequest } from "@/lib/portfolio/contracts";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";

export const dynamic = "force-dynamic";

const MCP_VERSION = "2026-07-28";
const canonicalSymbolPattern = "^[A-Z0-9._-]+:[A-Z0-9._-]+$";
const canonicalSymbolInputPattern = "^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$";

const tools = [
  {
    name: "search_symbols",
    description:
      "Search the current active US-equity catalog by ticker or company name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 64 } },
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
  {
    name: "get_portfolio",
    description:
      "Return the authenticated user's saved portfolio profile and holdings. Quantities and cost basis are decimal strings.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_decision_support",
    description:
      "Return deterministic, evidence-gated research scenarios for an authenticated user's symbol. This tool never places an order; confidence means evidence coverage, not return probability.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: {
          type: "string",
          pattern: canonicalSymbolInputPattern,
          description: "Canonical exchange:ticker symbol; normalized to uppercase.",
        },
        horizon: {
          type: "string",
          enum: ["near_term", "long_term"],
        },
        preset: {
          type: "string",
          enum: ["tight", "balanced", "wide"],
        },
        budget: {
          anyOf: [
            {
              type: "string",
              maxLength: 32,
              pattern:
                "^(?=.*[1-9])(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$",
            },
            { type: "null" },
          ],
          description:
            "Optional positive USD scenario budget as a decimal string; never an order amount.",
        },
      },
      required: ["symbol_id", "horizon", "preset"],
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
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
) {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function toolContent(data: unknown, meta: object = serviceMeta) {
  const envelope = { data, meta };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(envelope, null, 2),
      },
    ],
    structuredContent: envelope,
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

async function resolveToolSymbol(symbolId: CanonicalSymbol) {
  try {
    return {
      success: true as const,
      symbolId: (await resolveCanonicalInstrument(symbolId)).id,
    };
  } catch (error) {
    if (error instanceof InstrumentResolutionError) {
      return {
        success: false as const,
        error:
          error.code === "symbol_not_supported"
            ? toolError("Symbol is not supported.", {
                code: "symbol_not_supported",
              })
            : toolError("The asset catalog is temporarily unavailable.", {
                code: "asset_catalog_unavailable",
              }),
      };
    }
    return {
      success: false as const,
      error: toolError("Symbol could not be verified.", {
        code: "symbol_resolution_failed",
      }),
    };
  }
}

async function callTool(name: string, args: Record<string, unknown>, request: Request) {
  try {
    switch (name) {
      case "search_symbols": {
        const parsed = z
          .object({ query: z.string().trim().min(1).max(64) })
          .strict()
          .safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const { getAssetSearchService } = await import(
          "@/lib/services/asset-search"
        );
        const result = await getAssetSearchService().search(parsed.data.query, 20);
        return toolContent(result.data, result.meta);
      }
      case "get_market_snapshot": {
        const parsed = z.object({ symbol_id: symbolSchema }).strict().safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const verified = await resolveToolSymbol(parsed.data.symbol_id);
        if (!verified.success) return verified.error;
        const result = await liveMarketData.getSnapshot(verified.symbolId);
        return result.data && result.data.symbolId === verified.symbolId
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
          .strict()
          .safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const verified = parsed.data.symbol_id
          ? await resolveToolSymbol(parsed.data.symbol_id)
          : null;
        if (verified && !verified.success) return verified.error;
        const verifiedSymbol = verified?.success ? verified.symbolId : undefined;
        const result = await liveMarketData.getIntelligenceFeed({
          symbols: verifiedSymbol ? [verifiedSymbol] : undefined,
          minimumMateriality: parsed.data.minimum_materiality,
          limit: parsed.data.limit,
          since:
            parsed.data.since ??
            new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
        });
        return toolContent(
          verifiedSymbol
            ? result.data.filter((item) => item.symbolIds.includes(verifiedSymbol))
            : result.data,
          result.meta,
        );
      }
      case "get_omnigaze_view": {
        const parsed = z.object({ symbol_id: symbolSchema }).safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const view = getOmnigazeView(parsed.data.symbol_id);
        return view ? toolContent(view) : toolError("Symbol not found.");
      }
      case "get_watchlist_dashboard": {
        const userId = request.headers.get("oai-authenticated-user-id");
        if (!userId) {
          return toolError("Authentication required.", { code: "auth_required" });
        }

        const { listUserWatchlists } = await import(
          "@/lib/repositories/watchlists"
        );
        const watchlists = await listUserWatchlists(userId);
        const symbols = extractCanonicalSymbols(watchlists);
        const publicWatchlists = summarizeWatchlists(watchlists);
        if (symbols.length === 0) {
          return toolContent(
            { watchlists: publicWatchlists, symbols: [], events: [] },
            {
              scope: "personal",
              identity: "authenticated",
              persistence: "server",
              status: "empty",
              generatedAt: new Date().toISOString(),
            },
          );
        }

        const feed = await liveMarketData.getIntelligenceFeed({
          symbols,
          limit: 50,
          minimumMateriality: "low",
          since: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
        });
        return toolContent(
          {
            watchlists: publicWatchlists,
            symbols,
            events: filterFeedToSymbols(feed.data, symbols),
          },
          {
            ...feed.meta,
            scope: "personal",
            identity: "authenticated",
            persistence: "server",
            status: "ready",
          },
        );
      }
      case "get_provider_status": {
        return toolContent(await liveMarketData.getProviderStatus(), {
          generatedAt: new Date().toISOString(),
        });
      }
      case "get_portfolio": {
        const parsed = z.object({}).strict().safeParse(args);
        if (!parsed.success) return validationError(parsed.error);
        const userId = request.headers.get("oai-authenticated-user-id");
        if (!userId) {
          return toolError("Authentication required.", { code: "auth_required" });
        }
        const { getUserPortfolio } = await import("@/lib/repositories/portfolio");
        return toolContent(await getUserPortfolio(userId), {
          scope: "personal",
          identity: "authenticated",
          persistence: "server",
          generatedAt: new Date().toISOString(),
        });
      }
      case "get_decision_support": {
        const userId = request.headers.get("oai-authenticated-user-id");
        if (!userId) {
          return toolError("Authentication required.", { code: "auth_required" });
        }
        const parsed = parsePortfolioDecisionSupportRequest(args);
        if (!parsed.success) return validationError(parsed.error);
        const { getPortfolioDecisionSupport } = await import(
          "@/lib/services/portfolio-decision-support"
        );
        try {
          return toolContent(
            await getPortfolioDecisionSupport(userId, parsed.data),
            {
              scope: "personal",
              identity: "authenticated",
              purpose: "research_scenarios",
              tradeExecutionAllowed: false,
              generatedAt: new Date().toISOString(),
            },
          );
        } catch (error) {
          if (error instanceof InstrumentResolutionError) {
            return error.code === "symbol_not_supported"
              ? toolError("Symbol is not supported.", {
                  code: "symbol_not_supported",
                })
              : toolError("The asset catalog is temporarily unavailable.", {
                  code: "asset_catalog_unavailable",
                });
          }
          throw error;
        }
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch {
    return toolError("Tool execution failed.", {
      code: "tool_execution_failed",
    });
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
