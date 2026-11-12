import { getChatGPTUser } from "@/app/chatgpt-auth";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import {
  extractCanonicalSymbols,
  filterFeedToSymbols,
  parseTodayQuery,
  summarizeWatchlists,
} from "@/lib/api/personal-intelligence";
import { listUserWatchlists } from "@/lib/repositories/watchlists";
import { intelligenceReadPlane } from "@/lib/services/intelligence-read-plane";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

async function getTodayIntelligence(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  const query = parseTodayQuery(new URL(request.url).searchParams);
  if (!query.success) {
    return apiError("invalid_query", "since or limit is invalid.", 400);
  }

  let watchlists;
  try {
    watchlists = await listUserWatchlists(user.userId);
  } catch {
    return apiError(
      "watchlists_unavailable",
      "Personal watchlists are temporarily unavailable.",
      503,
    );
  }

  const publicWatchlists = summarizeWatchlists(watchlists);
  const symbols = extractCanonicalSymbols(watchlists);
  if (symbols.length === 0) {
    return Response.json(
      {
        watchlists: publicWatchlists,
        symbols: [],
        data: [],
        meta: {
          scope: "personal",
          status: "empty",
          generatedAt: new Date().toISOString(),
          notice: "Add a symbol to a watchlist to build your Today feed.",
        },
      },
      { headers: noStore },
    );
  }

  try {
    const feed = await intelligenceReadPlane.getIntelligenceFeed({
      symbols,
      since: query.data.since,
      limit: query.data.limit,
      minimumMateriality: "low",
    });

    return Response.json(
      {
        watchlists: publicWatchlists,
        symbols,
        data: filterFeedToSymbols(feed.data, symbols),
        meta: { ...feed.meta, scope: "personal", status: "ready" },
      },
      { headers: noStore },
    );
  } catch {
    return apiError(
      "intelligence_unavailable",
      "Personal intelligence is temporarily unavailable.",
      502,
    );
  }
}

export const GET = instrumentApiRoute(
  { operation: "api.intelligence.today.get", slowMs: 5_000 },
  getTodayIntelligence,
);
