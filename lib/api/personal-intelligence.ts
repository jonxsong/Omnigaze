import { z } from "zod";
import type { CanonicalSymbol } from "@/lib/market-types";

const canonicalSymbolSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/))
  .transform((value) => value as CanonicalSymbol);

const watchlistMutationSchema = z
  .object({
    operation: z.enum(["add", "remove"]),
    watchlist_id: z.string().trim().min(1).max(128),
    symbol_id: canonicalSymbolSchema,
  })
  .strict();

const todayQuerySchema = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  })
  .strict();

export type WatchlistMutation = z.infer<typeof watchlistMutationSchema>;

export type WatchlistLike = {
  id: string;
  name: string;
  isDefault: boolean;
  items: Array<{ symbolId: string }>;
};

export function parseWatchlistMutation(input: unknown) {
  return watchlistMutationSchema.safeParse(input);
}

export function parseTodayQuery(params: URLSearchParams, now = new Date()) {
  const parsed = todayQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return { success: false as const };

  const since =
    parsed.data.since ?? new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  if (Date.parse(since) > now.getTime()) return { success: false as const };

  return {
    success: true as const,
    data: { since, limit: parsed.data.limit },
  };
}

export function extractCanonicalSymbols(watchlists: WatchlistLike[]) {
  const symbols = new Set<CanonicalSymbol>();

  for (const watchlist of watchlists) {
    for (const item of watchlist.items) {
      const parsed = canonicalSymbolSchema.safeParse(item.symbolId);
      if (parsed.success) symbols.add(parsed.data);
    }
  }

  return [...symbols];
}

export function summarizeWatchlists(watchlists: WatchlistLike[]) {
  return watchlists.map((watchlist) => ({
    id: watchlist.id,
    name: watchlist.name,
    isDefault: watchlist.isDefault,
    itemCount: watchlist.items.length,
  }));
}

export function filterFeedToSymbols<T extends { symbolIds: CanonicalSymbol[] }>(
  items: T[],
  symbols: CanonicalSymbol[],
) {
  const allowed = new Set(symbols);
  return items.filter((item) => item.symbolIds.some((symbol) => allowed.has(symbol)));
}
