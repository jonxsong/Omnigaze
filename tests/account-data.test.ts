import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ getDb: vi.fn() }));

import {
  DATA_DELETION_CHALLENGE_COOKIE,
  DATA_DELETION_CONFIRMATION,
  dataDeletionChallengeCookie,
  isSameOriginMutation,
  parseAccountDataDeletionRequest,
  readCookie,
} from "@/lib/account-data";
import { eraseOwnerSavedData } from "@/lib/repositories/account-data";
import { deleteSavedAccountData } from "@/lib/services/account-data-deletion";

describe("account data deletion domain", () => {
  it("accepts only the exact confirmation phrase and a UUID challenge", () => {
    const challenge = "11111111-1111-4111-8111-111111111111";
    expect(
      parseAccountDataDeletionRequest({
        challenge,
        confirmation: DATA_DELETION_CONFIRMATION,
      }).success,
    ).toBe(true);
    expect(
      parseAccountDataDeletionRequest({
        challenge,
        confirmation: "erase my data",
      }).success,
    ).toBe(false);
    expect(
      parseAccountDataDeletionRequest({
        challenge,
        confirmation: DATA_DELETION_CONFIRMATION,
        owner_id: "another-user",
      }).success,
    ).toBe(false);
  });

  it("requires the request origin to match the API origin", () => {
    expect(
      isSameOriginMutation(
        new Request("https://omnigaze.test/api/account/data", {
          headers: { origin: "https://omnigaze.test" },
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginMutation(
        new Request("https://omnigaze.test/api/account/data", {
          headers: { origin: "https://attacker.test" },
        }),
      ),
    ).toBe(false);
    expect(
      isSameOriginMutation(
        new Request("https://omnigaze.test/api/account/data"),
      ),
    ).toBe(false);
  });

  it("creates an HttpOnly strict cookie and reads its exact value", () => {
    const challenge = "11111111-1111-4111-8111-111111111111";
    const cookie = dataDeletionChallengeCookie(
      "https://omnigaze.test/api/account/data",
      challenge,
    );
    expect(cookie).toContain(`${DATA_DELETION_CHALLENGE_COOKIE}=${challenge}`);
    expect(cookie).toContain("Path=/api/account/data");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(
      readCookie(`other=1; ${DATA_DELETION_CHALLENGE_COOKIE}=${challenge}`, DATA_DELETION_CHALLENGE_COOKIE),
    ).toBe(challenge);
  });

  it("erases every owner-scoped table in one ordered database batch", async () => {
    const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    const database = {
      prepare(sql: string) {
        const statement = {
          sql,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            statement.bindings = bindings;
            prepared.push(statement);
            return statement;
          },
        };
        return statement;
      },
      batch,
    } as unknown as D1Database;

    await eraseOwnerSavedData("owner-a", () => database);

    expect(batch).toHaveBeenCalledOnce();
    expect(prepared).toHaveLength(12);
    expect(prepared.map(({ sql }) => sql)).toEqual([
      "DELETE FROM alert_deliveries WHERE owner_id = ?1",
      "DELETE FROM alert_rules WHERE owner_id = ?1",
      "DELETE FROM inbox_event_states WHERE owner_id = ?1",
      "DELETE FROM inbox_projection_cursors WHERE owner_id = ?1",
      "DELETE FROM inbox_sync_gates WHERE owner_id = ?1",
      "DELETE FROM inbox_profiles WHERE owner_id = ?1",
      "DELETE FROM ai_daily_brief_cache_entries WHERE owner_id = ?1",
      "DELETE FROM ai_model_budget_reservations WHERE owner_id = ?1",
      "DELETE FROM portfolio_holdings WHERE owner_id = ?1",
      "DELETE FROM portfolio_profiles WHERE owner_id = ?1",
      "DELETE FROM watchlist_items WHERE watchlist_id IN (SELECT id FROM watchlists WHERE owner_id = ?1)",
      "DELETE FROM watchlists WHERE owner_id = ?1",
    ]);
    expect(prepared.every(({ bindings }) => bindings[0] === "owner-a")).toBe(
      true,
    );
    expect(prepared.map(({ sql }) => sql).join(" ")).not.toContain(
      "source_events",
    );
  });

  it("propagates an atomic batch failure and reports success only afterward", async () => {
    const erase = vi.fn().mockRejectedValueOnce(new Error("batch failed"));
    await expect(
      deleteSavedAccountData("owner-a", { eraseOwnerSavedData: erase }),
    ).rejects.toThrow("batch failed");

    erase.mockResolvedValueOnce(undefined);
    await expect(
      deleteSavedAccountData("owner-a", { eraseOwnerSavedData: erase }),
    ).resolves.toEqual({ deleted: true });
  });
});

