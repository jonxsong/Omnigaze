import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DATA_DELETION_CHALLENGE_COOKIE,
  DATA_DELETION_CONFIRMATION,
} from "@/lib/account-data";

const mocks = vi.hoisted(() => ({
  deleteSavedAccountData: vi.fn(),
  getChatGPTUser: vi.fn(),
}));

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/services/account-data-deletion", () => ({
  deleteSavedAccountData: mocks.deleteSavedAccountData,
}));

import { DELETE as deleteData } from "@/app/api/account/data/route";
import { POST as createChallenge } from "@/app/api/account/data-deletion-challenge/route";

const origin = "https://omnigaze.test";
const challenge = "11111111-1111-4111-8111-111111111111";

function challengeRequest(requestOrigin = origin) {
  return new Request(`${origin}/api/account/data-deletion-challenge`, {
    method: "POST",
    headers: { origin: requestOrigin },
  });
}

function deletionRequest(
  body: unknown,
  options: { cookie?: string; requestOrigin?: string } = {},
) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: options.requestOrigin ?? origin,
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${origin}/api/account/data`, {
    method: "DELETE",
    headers,
    body: JSON.stringify(body),
  });
}

describe("account data deletion HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "owner-a",
      email: "owner@example.test",
      displayName: "Owner",
      fullName: "Owner",
    });
    mocks.deleteSavedAccountData.mockResolvedValue({ deleted: true });
  });

  it("requires authentication before issuing a challenge or deleting data", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);
    const challengeResponse = await createChallenge(challengeRequest());
    const deletionResponse = await deleteData(
      deletionRequest({
        challenge,
        confirmation: DATA_DELETION_CONFIRMATION,
      }),
    );

    expect(challengeResponse.status).toBe(401);
    expect(deletionResponse.status).toBe(401);
    expect(mocks.deleteSavedAccountData).not.toHaveBeenCalled();
  });

  it("issues a short-lived, no-store, HttpOnly same-site challenge", async () => {
    const response = await createChallenge(challengeRequest());
    const body = (await response.json()) as {
      data: {
        challenge: string;
        confirmationPhrase: string;
        expiresAt: string;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain(
      `${DATA_DELETION_CHALLENGE_COOKIE}=`,
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(body.data.challenge).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.data.confirmationPhrase).toBe(DATA_DELETION_CONFIRMATION);
    expect(Date.parse(body.data.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("rejects cross-origin, unconfirmed, and unbound deletion requests", async () => {
    const validBody = {
      challenge,
      confirmation: DATA_DELETION_CONFIRMATION,
    };
    const crossOrigin = await deleteData(
      deletionRequest(validBody, { requestOrigin: "https://attacker.test" }),
    );
    const wrongPhrase = await deleteData(
      deletionRequest(
        { challenge, confirmation: "DELETE" },
        { cookie: `${DATA_DELETION_CHALLENGE_COOKIE}=${challenge}` },
      ),
    );
    const missingCookie = await deleteData(deletionRequest(validBody));

    expect(crossOrigin.status).toBe(403);
    expect(wrongPhrase.status).toBe(400);
    expect(missingCookie.status).toBe(403);
    expect(mocks.deleteSavedAccountData).not.toHaveBeenCalled();
  });

  it("derives the owner from authentication, erases data, and expires the challenge", async () => {
    const response = await deleteData(
      deletionRequest(
        {
          challenge,
          confirmation: DATA_DELETION_CONFIRMATION,
        },
        { cookie: `${DATA_DELETION_CHALLENGE_COOKIE}=${challenge}` },
      ),
    );
    const body = (await response.json()) as {
      data: { deleted: boolean };
      meta: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(body).toEqual({
      data: { deleted: true },
      meta: {
        scope: "personal",
        identity: "authenticated",
        action: "erase_saved_data",
      },
    });
    expect(JSON.stringify(body)).not.toContain("owner-a");
    expect(mocks.deleteSavedAccountData).toHaveBeenCalledOnce();
    expect(mocks.deleteSavedAccountData).toHaveBeenCalledWith("owner-a");
  });

  it("fails closed when the atomic deletion cannot complete", async () => {
    mocks.deleteSavedAccountData.mockRejectedValue(new Error("database down"));
    const response = await deleteData(
      deletionRequest(
        {
          challenge,
          confirmation: DATA_DELETION_CONFIRMATION,
        },
        { cookie: `${DATA_DELETION_CHALLENGE_COOKIE}=${challenge}` },
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "data_deletion_failed",
      error: "Saved Omnigaze data could not be erased.",
    });
  });
});

