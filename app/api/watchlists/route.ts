import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  addSymbolToWatchlist,
  listUserWatchlists,
  removeSymbolFromWatchlist,
  WatchlistRepositoryError,
} from "@/lib/repositories/watchlists";
import { parseWatchlistMutation } from "@/lib/api/personal-intelligence";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function apiError(code: string, error: string, status: number) {
  return Response.json({ error, code }, { status, headers: noStore });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  try {
    const watchlists = await listUserWatchlists(user.userId);
    return Response.json(
      {
        data: watchlists.map((watchlist) => ({
          id: watchlist.id,
          name: watchlist.name,
          isDefault: watchlist.isDefault,
          createdAt: watchlist.createdAt,
          updatedAt: watchlist.updatedAt,
          items: watchlist.items,
        })),
      },
      { headers: noStore },
    );
  } catch {
    return apiError(
      "watchlists_unavailable",
      "Watchlists are temporarily unavailable.",
      503,
    );
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return apiError("auth_required", "Authentication required.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON.", 400);
  }
  const parsed = parseWatchlistMutation(body);
  if (!parsed.success) {
    return apiError("invalid_request", "Watchlist request is invalid.", 400);
  }

  try {
    const data =
      parsed.data.operation === "add"
        ? await addSymbolToWatchlist(
            user.userId,
            parsed.data.watchlist_id,
            parsed.data.symbol_id,
          )
        : await removeSymbolFromWatchlist(
            user.userId,
            parsed.data.watchlist_id,
            parsed.data.symbol_id,
          );
    return Response.json({ data }, { headers: noStore });
  } catch (error) {
    if (error instanceof WatchlistRepositoryError) {
      if (error.code === "watchlist_not_found") {
        return apiError("watchlist_not_found", "Watchlist not found.", 404);
      }
      return apiError("symbol_not_supported", "Symbol is not supported.", 422);
    }
    return apiError("watchlist_update_failed", "Watchlist update failed.", 500);
  }
}
