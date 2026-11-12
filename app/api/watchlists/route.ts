import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  addSymbolToWatchlist,
  listUserWatchlists,
  removeSymbolFromWatchlist,
} from "@/lib/repositories/watchlists";
import type { CanonicalSymbol } from "@/lib/market-types";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  return Response.json({ data: await listUserWatchlists(user.userId) });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    operation?: "add" | "remove";
    watchlist_id?: string;
    symbol_id?: string;
  } | null;

  if (!body?.operation || !body.watchlist_id || !body.symbol_id) {
    return Response.json(
      { error: "operation, watchlist_id, and symbol_id are required." },
      { status: 400 },
    );
  }

  const symbolId = body.symbol_id.toUpperCase() as CanonicalSymbol;
  try {
    const data =
      body.operation === "add"
        ? await addSymbolToWatchlist(user.userId, body.watchlist_id, symbolId)
        : await removeSymbolFromWatchlist(user.userId, body.watchlist_id, symbolId);
    return Response.json({ data });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Watchlist update failed." },
      { status: 404 },
    );
  }
}
