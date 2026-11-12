import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockWatchlistRepositoryError extends Error {
    constructor(readonly code: "watchlist_not_found" | "symbol_not_supported") {
      super(code);
    }
  }

  return {
    getChatGPTUser: vi.fn(),
    listUserWatchlists: vi.fn(),
    addSymbolToWatchlist: vi.fn(),
    removeSymbolFromWatchlist: vi.fn(),
    WatchlistRepositoryError: MockWatchlistRepositoryError,
  };
});

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/repositories/watchlists", () => ({
  listUserWatchlists: mocks.listUserWatchlists,
  addSymbolToWatchlist: mocks.addSymbolToWatchlist,
  removeSymbolFromWatchlist: mocks.removeSymbolFromWatchlist,
  WatchlistRepositoryError: mocks.WatchlistRepositoryError,
}));

import { GET, POST } from "@/app/api/watchlists/route";

function mutation(body: unknown) {
  return new Request("https://omnigaze.test/api/watchlists", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("personal watchlist API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "user-a",
      email: "a@example.test",
      displayName: "A",
      fullName: null,
    });
  });

  it("rejects anonymous reads and writes before repository access", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);

    const getResponse = await GET();
    const postResponse = await POST(
      mutation({
        operation: "add",
        watchlist_id: "list-a",
        symbol_id: "NASDAQ:NVDA",
      }),
    );

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(mocks.listUserWatchlists).not.toHaveBeenCalled();
    expect(mocks.addSymbolToWatchlist).not.toHaveBeenCalled();
  });

  it("returns a server-persistence contract without owner identifiers", async () => {
    mocks.listUserWatchlists.mockResolvedValue([
      {
        id: "list-a",
        ownerId: "user-a",
        name: "Core holdings",
        isDefault: true,
        createdAt: "2026-11-11T00:00:00.000Z",
        updatedAt: "2026-11-11T00:00:00.000Z",
        items: [{ symbolId: "NASDAQ:NVDA", ticker: "NVDA" }],
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      data: [{ id: "list-a", name: "Core holdings", isDefault: true }],
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
      },
    });
    expect(JSON.stringify(body)).not.toContain("ownerId");
    expect(JSON.stringify(body)).not.toContain("user-a");
  });

  it("keeps mutation input closed and derives the owner from authentication", async () => {
    const invalid = await POST(
      mutation({
        operation: "add",
        watchlist_id: "list-a",
        symbol_id: "NASDAQ:NVDA",
        owner_id: "user-b",
      }),
    );

    mocks.addSymbolToWatchlist.mockResolvedValue({
      watchlistId: "list-a",
      symbolId: "NASDAQ:NVDA",
    });
    const valid = await POST(
      mutation({
        operation: "add",
        watchlist_id: "list-a",
        symbol_id: "nasdaq:nvda",
      }),
    );
    const body = (await valid.json()) as {
      meta: { persistence: string };
    };

    expect(invalid.status).toBe(400);
    expect(mocks.addSymbolToWatchlist).toHaveBeenCalledWith(
      "user-a",
      "list-a",
      "NASDAQ:NVDA",
    );
    expect(valid.status).toBe(200);
    expect(valid.headers.get("cache-control")).toBe("no-store");
    expect(body.meta.persistence).toBe("server");
  });

  it("hides foreign watchlists behind the stable not-found contract", async () => {
    mocks.removeSymbolFromWatchlist.mockRejectedValue(
      new mocks.WatchlistRepositoryError("watchlist_not_found"),
    );

    const response = await POST(
      mutation({
        operation: "remove",
        watchlist_id: "someone-elses-list",
        symbol_id: "NASDAQ:NVDA",
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Watchlist not found.",
      code: "watchlist_not_found",
    });
  });
});
