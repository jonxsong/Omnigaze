import { describe, expect, it } from "vitest";
import {
  extractCanonicalSymbols,
  filterFeedToSymbols,
  parseTodayQuery,
  parseWatchlistMutation,
  summarizeWatchlists,
} from "@/lib/api/personal-intelligence";

const watchlists = [
  {
    id: "one",
    name: "Core holdings",
    isDefault: true,
    items: [
      { symbolId: "nasdaq:nvda" },
      { symbolId: "NASDAQ:MSFT" },
      { symbolId: "NASDAQ:NVDA" },
      { symbolId: "not-canonical" },
    ],
  },
  {
    id: "two",
    name: "Ideas",
    isDefault: false,
    items: [{ symbolId: "NYSE:SHOP" }],
  },
];

describe("personal intelligence request contracts", () => {
  it("normalizes canonical symbols and rejects extra mutation fields", () => {
    expect(
      parseWatchlistMutation({
        operation: "add",
        watchlist_id: "list-1",
        symbol_id: " nasdaq:nvda ",
      }),
    ).toMatchObject({
      success: true,
      data: { symbol_id: "NASDAQ:NVDA" },
    });

    expect(
      parseWatchlistMutation({
        operation: "add",
        watchlist_id: "list-1",
        symbol_id: "NVDA",
      }).success,
    ).toBe(false);
    expect(
      parseWatchlistMutation({
        operation: "add",
        watchlist_id: "list-1",
        symbol_id: "NASDAQ:NVDA",
        owner_id: "someone-else",
      }).success,
    ).toBe(false);
  });

  it("validates Today query bounds and supplies a deterministic default window", () => {
    const now = new Date("2026-11-11T18:00:00.000Z");
    expect(parseTodayQuery(new URLSearchParams(), now)).toEqual({
      success: true,
      data: { since: "2026-11-10T18:00:00.000Z", limit: 50 },
    });
    expect(parseTodayQuery(new URLSearchParams("limit=101"), now).success).toBe(false);
    expect(
      parseTodayQuery(
        new URLSearchParams("since=2026-11-12T00%3A00%3A00.000Z"),
        now,
      ).success,
    ).toBe(false);
    expect(parseTodayQuery(new URLSearchParams("unknown=1"), now).success).toBe(false);
  });

  it("derives a deduplicated canonical universe only from watchlist items", () => {
    expect(extractCanonicalSymbols(watchlists)).toEqual([
      "NASDAQ:NVDA",
      "NASDAQ:MSFT",
      "NYSE:SHOP",
    ]);
    expect(summarizeWatchlists(watchlists)).toEqual([
      { id: "one", name: "Core holdings", isDefault: true, itemCount: 4 },
      { id: "two", name: "Ideas", isDefault: false, itemCount: 1 },
    ]);
  });

  it("removes fallback events that are outside the user's symbol universe", () => {
    const data = [
      { id: "allowed", symbolIds: ["NASDAQ:NVDA" as const] },
      { id: "global", symbolIds: ["NASDAQ:AAPL" as const] },
      { id: "unmapped", symbolIds: [] },
    ];

    expect(filterFeedToSymbols(data, ["NASDAQ:NVDA"])).toEqual([data[0]]);
    expect(filterFeedToSymbols(data, [])).toEqual([]);
  });
});
