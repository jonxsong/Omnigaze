import { beforeEach, describe, expect, it, vi } from "vitest";
import { OmnigazeAiGuardError } from "@/lib/ai/omnigaze-view-guard";

const mocks = vi.hoisted(() => {
  class MockDailyBriefServiceError extends Error {
    readonly status: number;

    constructor(readonly code: string) {
      super(code === "empty_watchlist" ? "Add a stock first." : "Unavailable.");
      this.name = "DailyBriefServiceError";
      this.status = code === "empty_watchlist" ? 422 : 503;
    }
  }
  return {
    getChatGPTUser: vi.fn(),
    generatePersonalDailyBrief: vi.fn(),
    DailyBriefServiceError: MockDailyBriefServiceError,
  };
});

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/services/personal-daily-brief", () => ({
  generatePersonalDailyBrief: mocks.generatePersonalDailyBrief,
  DailyBriefServiceError: mocks.DailyBriefServiceError,
}));

import { POST } from "@/app/api/ai/daily-brief/route";

function request(body: unknown) {
  return new Request("https://omnigaze.test/api/ai/daily-brief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function envelope(cacheState: "generated" | "hit" | "deduplicated" = "generated") {
  const consumed = cacheState === "generated";
  return {
    data: {
      headline: "Tracked companies changed today",
      summary: "Fresh evidence changed the watchlist context.",
      developments: [],
      watchNext: ["Watch for confirmation."],
      unknowns: ["Durability remains unknown."],
      briefDate: "2026-11-12",
      window: {
        since: "2026-11-11T18:00:00.000Z",
        through: "2026-11-12T18:00:00.000Z",
      },
    },
    meta: {
      dataMode: "live",
      cache: {
        state: cacheState,
        cachedAt: "2026-11-12T18:00:00.000Z",
        expiresAt: "2026-11-13T00:00:00.000Z",
      },
      budget: consumed
        ? {
            consumed: true,
            remaining: 18,
            limit: 20,
            resetsAt: "2026-11-13T00:00:00.000Z",
          }
        : { consumed: false, remaining: null, limit: null, resetsAt: null },
    },
  };
}

describe("Daily Brief HTTP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "owner-route-1",
      email: "owner@example.test",
      fullName: "Owner",
    });
    mocks.generatePersonalDailyBrief.mockResolvedValue(envelope());
  });

  it("requires authentication before validation or generation", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);

    const response = await POST(request({ request_id: "valid-request-1" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Authentication required.",
      code: "auth_required",
    });
    expect(mocks.generatePersonalDailyBrief).not.toHaveBeenCalled();
  });

  it("rejects malformed or expansive input with no service work", async () => {
    for (const body of [
      { request_id: "bad key" },
      { request_id: "valid-request-1", symbol_id: "NASDAQ:NVDA" },
      null,
    ]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(mocks.generatePersonalDailyBrief).not.toHaveBeenCalled();
  });

  it("returns the direct envelope with honest generated budget headers", async () => {
    const response = await POST(request({ request_id: "valid-request-1" }));

    expect(response.status).toBe(200);
    expect(mocks.generatePersonalDailyBrief).toHaveBeenCalledWith(
      "owner-route-1",
      { requestId: "valid-request-1" },
    );
    expect(await response.json()).toMatchObject({
      data: { headline: "Tracked companies changed today" },
      meta: { cache: { state: "generated" }, budget: { consumed: true } },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-omnigaze-ai-cache")).toBe("miss");
    expect(response.headers.get("x-omnigaze-ai-deduplicated")).toBe("false");
    expect(response.headers.get("x-omnigaze-ai-budget-charged")).toBe("true");
    expect(response.headers.get("x-omnigaze-ai-budget-remaining")).toBe("18");
  });

  it("labels durable hits and in-flight deduplication without budget headers", async () => {
    for (const state of ["hit", "deduplicated"] as const) {
      mocks.generatePersonalDailyBrief.mockResolvedValueOnce(envelope(state));
      const response = await POST(request({}));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-omnigaze-ai-cache")).toBe(
        state === "hit" ? "hit" : "miss",
      );
      expect(response.headers.get("x-omnigaze-ai-deduplicated")).toBe(
        String(state === "deduplicated"),
      );
      expect(response.headers.get("x-omnigaze-ai-budget-charged")).toBe("false");
      expect(response.headers.get("x-omnigaze-ai-budget-remaining")).toBeNull();
    }
  });

  it("preserves stable service and shared-budget failures", async () => {
    mocks.generatePersonalDailyBrief.mockRejectedValueOnce(
      new mocks.DailyBriefServiceError("empty_watchlist"),
    );
    const empty = await POST(request({}));
    expect(empty.status).toBe(422);
    expect(await empty.json()).toMatchObject({ code: "empty_watchlist" });

    mocks.generatePersonalDailyBrief.mockRejectedValueOnce(
      new OmnigazeAiGuardError(
        "ai_rate_limited",
        "2026-11-12T18:00:45.000Z",
        45,
        "rolling_limit",
      ),
    );
    const limited = await POST(request({ request_id: "rate-limit-request" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("45");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.json()).toMatchObject({
      code: "ai_rate_limited",
      retryAfterSeconds: 45,
      budgetReason: "rolling_limit",
    });
  });
});
