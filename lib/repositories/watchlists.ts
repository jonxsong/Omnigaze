import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { instruments, watchlistItems, watchlists } from "@/db/schema";
import { workspaceBySymbol } from "@/lib/demo-market-data";
import type { CanonicalSymbol } from "@/lib/market-types";

export type WatchlistRepositoryErrorCode =
  | "watchlist_not_found"
  | "symbol_not_supported";

export class WatchlistRepositoryError extends Error {
  constructor(readonly code: WatchlistRepositoryErrorCode) {
    super(code);
    this.name = "WatchlistRepositoryError";
  }
}

export async function ensureDefaultWatchlist(ownerId: string) {
  const db = getDb();
  const existing = await db
    .select()
    .from(watchlists)
    .where(and(eq(watchlists.ownerId, ownerId), eq(watchlists.isDefault, true)))
    .limit(1);

  if (existing[0]) return existing[0];

  const created = {
    id: crypto.randomUUID(),
    ownerId,
    name: "Core holdings",
    isDefault: true,
  };
  await db.insert(watchlists).values(created);
  return { ...created, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export async function listUserWatchlists(ownerId: string) {
  const db = getDb();
  await ensureDefaultWatchlist(ownerId);

  const lists = await db.select().from(watchlists).where(eq(watchlists.ownerId, ownerId));
  const items = await db
    .select({
      watchlistId: watchlistItems.watchlistId,
      symbolId: watchlistItems.symbolId,
      note: watchlistItems.note,
      addedAt: watchlistItems.addedAt,
      ticker: instruments.ticker,
      exchange: instruments.exchange,
      name: instruments.name,
    })
    .from(watchlistItems)
    .innerJoin(instruments, eq(instruments.id, watchlistItems.symbolId))
    .innerJoin(watchlists, eq(watchlists.id, watchlistItems.watchlistId))
    .where(eq(watchlists.ownerId, ownerId));

  return lists.map((list) => ({
    ...list,
    items: items.filter((item) => item.watchlistId === list.id),
  }));
}

async function assertOwnedWatchlist(ownerId: string, watchlistId: string) {
  const db = getDb();
  const owned = await db
    .select({ id: watchlists.id })
    .from(watchlists)
    .where(and(eq(watchlists.id, watchlistId), eq(watchlists.ownerId, ownerId)))
    .limit(1);
  if (!owned[0]) throw new WatchlistRepositoryError("watchlist_not_found");
}

export async function addSymbolToWatchlist(
  ownerId: string,
  watchlistId: string,
  symbolId: CanonicalSymbol,
) {
  const db = getDb();
  await assertOwnedWatchlist(ownerId, watchlistId);
  const workspace = workspaceBySymbol.get(symbolId);
  if (!workspace) throw new WatchlistRepositoryError("symbol_not_supported");

  await db
    .insert(instruments)
    .values({
      id: workspace.instrument.id,
      ticker: workspace.instrument.ticker,
      exchange: workspace.instrument.exchange,
      name: workspace.instrument.name,
      sector: workspace.instrument.sector,
      currency: workspace.instrument.currency,
    })
    .onConflictDoUpdate({
      target: instruments.id,
      set: {
        name: workspace.instrument.name,
        sector: workspace.instrument.sector,
        updatedAt: new Date().toISOString(),
      },
    });

  await db
    .insert(watchlistItems)
    .values({ watchlistId, symbolId })
    .onConflictDoNothing();

  return { watchlistId, symbolId };
}

export async function removeSymbolFromWatchlist(
  ownerId: string,
  watchlistId: string,
  symbolId: CanonicalSymbol,
) {
  const db = getDb();
  await assertOwnedWatchlist(ownerId, watchlistId);
  await db
    .delete(watchlistItems)
    .where(
      and(
        eq(watchlistItems.watchlistId, watchlistId),
        eq(watchlistItems.symbolId, symbolId),
      ),
    );
  return { watchlistId, symbolId };
}
