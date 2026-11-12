import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockInboxRepositoryError extends Error {
    constructor(readonly code: "not_found" | "conflict") {
      super(code);
    }
  }
  return {
    getChatGPTUser: vi.fn(),
    getIntelligenceInbox: vi.fn(),
    getIntelligenceInboxItem: vi.fn(),
    getAlertRules: vi.fn(),
    updateIntelligenceInboxState: vi.fn(),
    putAlertRule: vi.fn(),
    InboxRepositoryError: MockInboxRepositoryError,
  };
});

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/intelligence-inbox/service", () => ({
  getIntelligenceInbox: mocks.getIntelligenceInbox,
  getIntelligenceInboxItem: mocks.getIntelligenceInboxItem,
  getAlertRules: mocks.getAlertRules,
  updateIntelligenceInboxState: mocks.updateIntelligenceInboxState,
  putAlertRule: mocks.putAlertRule,
}));

vi.mock("@/lib/intelligence-inbox/repository", () => ({
  InboxRepositoryError: mocks.InboxRepositoryError,
}));

import { GET as getInbox } from "@/app/api/intelligence/inbox/route";
import {
  GET as getInboxItem,
  PATCH as patchInbox,
} from "@/app/api/intelligence/inbox/[eventId]/route";
import { GET as getRules } from "@/app/api/alerts/rules/route";
import { PUT as putRule } from "@/app/api/alerts/rules/[symbol]/route";

function patchContext(eventId: string) {
  return { params: Promise.resolve({ eventId }) };
}

function symbolContext(symbol: string) {
  return { params: Promise.resolve({ symbol }) };
}

function jsonRequest(url: string, method: "PATCH" | "PUT", body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const desiredState = {
  read: true,
  saved: false,
  dismissed: false,
  expected_version: 2,
  expected_event_revision: 1,
};

const desiredRule = {
  enabled: true,
  minimum_materiality: "high",
  include_controversy: true,
  expected_version: 0,
};

describe("intelligence inbox HTTP API", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "owner-a",
      email: "a@example.test",
      fullName: "A User",
    });
  });

  it("requires authentication on every personal route and always disables caching", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);
    const responses = await Promise.all([
      getInbox(new Request("https://omnigaze.test/api/intelligence/inbox")),
      getInboxItem(
        new Request(
          "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent",
        ),
        patchContext("alpaca%3Aevent"),
      ),
      patchInbox(
        jsonRequest(
          "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent",
          "PATCH",
          desiredState,
        ),
        patchContext("alpaca%3Aevent"),
      ),
      getRules(),
      putRule(
        jsonRequest(
          "https://omnigaze.test/api/alerts/rules/NASDAQ%3ANVDA",
          "PUT",
          desiredRule,
        ),
        symbolContext("NASDAQ%3ANVDA"),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401,
    ]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocks.getIntelligenceInbox).not.toHaveBeenCalled();
    expect(mocks.getIntelligenceInboxItem).not.toHaveBeenCalled();
    expect(mocks.updateIntelligenceInboxState).not.toHaveBeenCalled();
    expect(mocks.getAlertRules).not.toHaveBeenCalled();
    expect(mocks.putAlertRule).not.toHaveBeenCalled();
  });

  it("returns the shared inbox envelope for the auth-derived owner", async () => {
    const payload = {
      data: {
        items: [],
        counts: { all: 0, unread: 0, saved: 0, alerts: 0 },
        rules: [],
      },
      meta: { identity: "authenticated", filter: "saved", limit: 12 },
    };
    mocks.getIntelligenceInbox.mockResolvedValue(payload);

    const response = await getInbox(
      new Request(
        "https://omnigaze.test/api/intelligence/inbox?filter=saved&limit=12",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(payload);
    expect(mocks.getIntelligenceInbox).toHaveBeenCalledWith("owner-a", {
      filter: "saved",
      limit: 12,
    });
    expect(JSON.stringify(payload)).not.toContain("owner-a");
  });

  it.each([
    "?filter=dismissed",
    "?limit=0",
    "?owner_id=owner-b",
    "?filter=all&extra=true",
  ])("rejects a non-closed inbox query %s", async (query) => {
    const response = await getInbox(
      new Request(`https://omnigaze.test/api/intelligence/inbox${query}`),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getIntelligenceInbox).not.toHaveBeenCalled();
  });

  it("accepts a closed desired-state write with opaque encoded event identity", async () => {
    const payload = {
      data: {
        eventId: "alpaca:event-1",
        eventRevision: 1,
        state: { read: true, saved: false, dismissed: false, version: 3 },
      },
      meta: { replayed: false },
    };
    mocks.updateIntelligenceInboxState.mockResolvedValue(payload);
    const response = await patchInbox(
      jsonRequest(
        "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent-1",
        "PATCH",
        desiredState,
      ),
      patchContext("alpaca%3Aevent-1"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.updateIntelligenceInboxState).toHaveBeenCalledWith(
      "owner-a",
      "alpaca:event-1",
      desiredState,
    );
    expect(await response.json()).toEqual(payload);
  });

  it("returns one owner-scoped durable item without provider synchronization", async () => {
    const payload = {
      data: {
        item: {
          event: { eventId: "alpaca:event-1", eventRevision: 2 },
          state: { read: false, saved: true, dismissed: false, version: 3 },
          alert: { triggered: true, deliveryCount: 1 },
        },
      },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        channel: "in_app",
        generatedAt: "2026-11-12T08:00:00.000Z",
      },
    };
    mocks.getIntelligenceInboxItem.mockResolvedValue(payload);

    const response = await getInboxItem(
      new Request(
        "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent-1",
      ),
      patchContext("alpaca%3Aevent-1"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(payload);
    expect(mocks.getIntelligenceInboxItem).toHaveBeenCalledWith(
      "owner-a",
      "alpaca:event-1",
    );
    expect(mocks.getIntelligenceInbox).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toContain("owner-a");
  });

  it("hides foreign focused items behind the same 404 as missing items", async () => {
    mocks.getIntelligenceInboxItem.mockRejectedValue(
      new mocks.InboxRepositoryError("not_found"),
    );
    for (const eventId of ["alpaca%3Aprivate", "alpaca%3Amissing"]) {
      const response = await getInboxItem(
        new Request(`https://omnigaze.test/api/intelligence/inbox/${eventId}`),
        patchContext(eventId),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        code: "inbox_item_not_found",
        error: "Inbox item not found.",
      });
    }
  });

  it("rejects malformed focused item identities and undeclared query fields", async () => {
    const invalidId = await getInboxItem(
      new Request("https://omnigaze.test/api/intelligence/inbox/bad%20id"),
      patchContext("bad%20id"),
    );
    const invalidQuery = await getInboxItem(
      new Request(
        "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent?owner_id=owner-b",
      ),
      patchContext("alpaca%3Aevent"),
    );

    expect([invalidId.status, invalidQuery.status]).toEqual([400, 400]);
    expect(mocks.getIntelligenceInboxItem).not.toHaveBeenCalled();
  });

  it("rejects caller identity and partial PATCH bodies", async () => {
    for (const body of [
      { ...desiredState, owner_id: "owner-b" },
      { read: true, expected_version: 2, expected_event_revision: 1 },
      { ...desiredState, expected_version: 0 },
    ]) {
      const response = await patchInbox(
        jsonRequest(
          "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent-1",
          "PATCH",
          body,
        ),
        patchContext("alpaca%3Aevent-1"),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.updateIntelligenceInboxState).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404, "inbox_item_not_found"],
    ["conflict", 409, "version_conflict"],
  ] as const)(
    "maps state repository %s without exposing internals",
    async (code, status, responseCode) => {
      mocks.updateIntelligenceInboxState.mockRejectedValue(
        new mocks.InboxRepositoryError(code),
      );
      const response = await patchInbox(
        jsonRequest(
          "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent-1",
          "PATCH",
          desiredState,
        ),
        patchContext("alpaca%3Aevent-1"),
      );
      const body = (await response.json()) as { code: string; error: string };
      expect(response.status).toBe(status);
      expect(body.code).toBe(responseCode);
      expect(body.error).not.toContain(code);
    },
  );

  it("lists rules and canonicalizes a closed desired-rule write", async () => {
    mocks.getAlertRules.mockResolvedValue({ data: { rules: [] }, meta: {} });
    mocks.putAlertRule.mockResolvedValue({
      data: {
        rule: {
          symbol: { id: "NASDAQ:NVDA" },
          enabled: true,
          version: 1,
        },
      },
      meta: { replayed: false },
    });

    const read = await getRules();
    const write = await putRule(
      jsonRequest(
        "https://omnigaze.test/api/alerts/rules/nasdaq%3Anvda",
        "PUT",
        desiredRule,
      ),
      symbolContext("nasdaq%3Anvda"),
    );

    expect([read.status, write.status]).toEqual([200, 200]);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(write.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getAlertRules).toHaveBeenCalledWith("owner-a");
    expect(mocks.putAlertRule).toHaveBeenCalledWith(
      "owner-a",
      "NASDAQ:NVDA",
      desiredRule,
    );
  });

  it("rejects undeclared rule and state query parameters", async () => {
    const rules = await getRules(
      new Request("https://omnigaze.test/api/alerts/rules?owner_id=owner-b"),
    );
    const ruleWrite = await putRule(
      jsonRequest(
        "https://omnigaze.test/api/alerts/rules/NASDAQ%3ANVDA?channel=email",
        "PUT",
        desiredRule,
      ),
      symbolContext("NASDAQ%3ANVDA"),
    );
    const stateWrite = await patchInbox(
      jsonRequest(
        "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent?owner_id=owner-b",
        "PATCH",
        desiredState,
      ),
      patchContext("alpaca%3Aevent"),
    );

    expect([rules.status, ruleWrite.status, stateWrite.status]).toEqual([
      400, 400, 400,
    ]);
    expect(mocks.getAlertRules).not.toHaveBeenCalled();
    expect(mocks.putAlertRule).not.toHaveBeenCalled();
    expect(mocks.updateIntelligenceInboxState).not.toHaveBeenCalled();
  });

  it("rejects extra rule fields and sanitizes missing/conflicting rules", async () => {
    const invalid = await putRule(
      jsonRequest(
        "https://omnigaze.test/api/alerts/rules/NASDAQ%3ANVDA",
        "PUT",
        { ...desiredRule, channel: "email" },
      ),
      symbolContext("NASDAQ%3ANVDA"),
    );
    expect(invalid.status).toBe(400);

    for (const [code, status, responseCode] of [
      ["not_found", 404, "alert_rule_not_found"],
      ["conflict", 409, "version_conflict"],
    ] as const) {
      mocks.putAlertRule.mockRejectedValueOnce(
        new mocks.InboxRepositoryError(code),
      );
      const response = await putRule(
        jsonRequest(
          "https://omnigaze.test/api/alerts/rules/NASDAQ%3ANVDA",
          "PUT",
          desiredRule,
        ),
        symbolContext("NASDAQ%3ANVDA"),
      );
      expect(response.status).toBe(status);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe(responseCode);
      expect(body.error).not.toBe(code);
    }
  });

  it("correlates and sanitizes every unexpected inbox failure", async () => {
    const sensitiveFailure = new Error(
      "private database path and do-not-log-this-secret",
    );
    mocks.getIntelligenceInbox.mockRejectedValue(sensitiveFailure);
    mocks.getIntelligenceInboxItem.mockRejectedValue(sensitiveFailure);
    mocks.updateIntelligenceInboxState.mockRejectedValue(sensitiveFailure);
    mocks.getAlertRules.mockRejectedValue(sensitiveFailure);
    mocks.putAlertRule.mockRejectedValue(sensitiveFailure);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const responses = await Promise.all([
      getInbox(new Request("https://omnigaze.test/api/intelligence/inbox")),
      getInboxItem(
        new Request(
          "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent-1",
        ),
        patchContext("alpaca%3Aevent-1"),
      ),
      patchInbox(
        jsonRequest(
          "https://omnigaze.test/api/intelligence/inbox/alpaca%3Aevent-1",
          "PATCH",
          desiredState,
        ),
        patchContext("alpaca%3Aevent-1"),
      ),
      getRules(new Request("https://omnigaze.test/api/alerts/rules")),
      putRule(
        jsonRequest(
          "https://omnigaze.test/api/alerts/rules/NASDAQ%3ANVDA",
          "PUT",
          desiredRule,
        ),
        symbolContext("NASDAQ%3ANVDA"),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      503, 503, 500, 503, 500,
    ]);
    const requestIds: string[] = [];
    for (const response of responses) {
      const body = (await response.json()) as {
        code: string;
        error: string;
        requestId: string;
      };
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-request-id")).toBe(body.requestId);
      expect(body.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(JSON.stringify(body)).not.toContain("database path");
      expect(JSON.stringify(body)).not.toContain("do-not-log-this-secret");
      requestIds.push(body.requestId);
    }

    expect(new Set(requestIds).size).toBe(responses.length);
    expect(errorSpy).toHaveBeenCalledTimes(responses.length * 2);
    const unexpectedFailures = errorSpy.mock.calls
      .filter(([event]) => event === "omnigaze.unexpected_failure")
      .map((call) => call[1]) as Array<{
      event: string;
      operation: string;
      requestId: string;
      failureKind: string;
    }>;
    const completions = errorSpy.mock.calls
      .map(([event]) => event)
      .filter(
        (event): event is {
          event: string;
          operation: string;
          requestId: string;
          outcome: string;
        } =>
          typeof event === "object" &&
          event !== null &&
          "event" in event &&
          event.event === "omnigaze.api_request",
      );
    expect(unexpectedFailures.map((details) => details.requestId).sort()).toEqual(
      [...requestIds].sort(),
    );
    expect(completions.map((details) => details.requestId).sort()).toEqual(
      [...requestIds].sort(),
    );
    const operations = [
      "api.alert_rules.get",
      "api.alert_rules.put",
      "api.intelligence_inbox.get",
      "api.intelligence_inbox_item.get",
      "api.intelligence_inbox_item.patch",
    ];
    expect(
      unexpectedFailures.map((details) => details.operation).sort(),
    ).toEqual(operations);
    expect(completions.map((details) => details.operation).sort()).toEqual(
      operations,
    );
    expect(completions.every((details) => details.outcome === "server_error"))
      .toBe(true);
    expect(
      JSON.stringify(errorSpy.mock.calls),
    ).not.toContain("do-not-log-this-secret");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("owner-a");
  });
});
