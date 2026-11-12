import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAccountSavedDataSnapshot: vi.fn(),
  getChatGPTUser: vi.fn(),
}));

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/services/account-data-export", () => ({
  buildAccountSavedDataSnapshot: mocks.buildAccountSavedDataSnapshot,
}));

import { POST } from "@/app/api/account/data-export/route";

const origin = "https://omnigaze.test";
const snapshot = {
  schemaVersion: "omnigaze.saved-data-snapshot.v1",
  snapshotType: "omnigaze-saved-data-snapshot",
  exportedAt: "2026-11-12T20:30:00.000Z",
  scope: { identity: "authenticated-owner", bounded: true },
  sections: {},
};

function exportRequest(
  body: unknown = { format: "json" },
  options: { requestOrigin?: string; contentType?: string; rawBody?: string } = {},
) {
  const headers = new Headers({
    origin: options.requestOrigin ?? origin,
    "content-type": options.contentType ?? "application/json; charset=utf-8",
  });
  return new Request(`${origin}/api/account/data-export`, {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  });
}

describe("saved-data snapshot HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "owner-a",
      email: "owner@example.test",
      displayName: "Owner",
      fullName: "Owner Name",
    });
    mocks.buildAccountSavedDataSnapshot.mockResolvedValue(snapshot);
  });

  it("requires authentication and never trusts an owner from the body", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);
    const response = await POST(
      exportRequest({ format: "json", ownerId: "owner-b" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.buildAccountSavedDataSnapshot).not.toHaveBeenCalled();
  });

  it("rejects cross-origin, non-JSON, malformed, and expanded requests", async () => {
    const crossOrigin = await POST(
      exportRequest(undefined, { requestOrigin: "https://attacker.test" }),
    );
    const wrongMediaType = await POST(
      exportRequest(undefined, { contentType: "text/plain" }),
    );
    const malformed = await POST(
      exportRequest(undefined, { rawBody: "{" }),
    );
    const expanded = await POST(
      exportRequest({ format: "json", includeRawPayloads: true }),
    );

    expect(crossOrigin.status).toBe(403);
    expect(wrongMediaType.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(expanded.status).toBe(400);
    expect(mocks.buildAccountSavedDataSnapshot).not.toHaveBeenCalled();
  });

  it("downloads only the authenticated owner's no-store JSON snapshot", async () => {
    const response = await POST(exportRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="omnigaze-saved-data-snapshot-2026-11-12.json"',
    );
    expect(body).toEqual(snapshot);
    expect(JSON.stringify(body)).not.toContain("owner-a");
    expect(JSON.stringify(body)).not.toContain("owner@example.test");
    expect(mocks.buildAccountSavedDataSnapshot).toHaveBeenCalledOnce();
    expect(mocks.buildAccountSavedDataSnapshot).toHaveBeenCalledWith("owner-a");
  });

  it("fails closed without returning a partial snapshot", async () => {
    mocks.buildAccountSavedDataSnapshot.mockRejectedValue(
      new Error("database unavailable"),
    );
    const response = await POST(exportRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      code: "data_export_failed",
      error: "Your Omnigaze saved-data snapshot could not be created.",
    });
  });
});
