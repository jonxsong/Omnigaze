import { getDb } from "@/db";

type AccountDataDatabase = Pick<D1Database, "batch" | "prepare">;

type AccountDataDatabaseFactory = () => AccountDataDatabase;

const ownerDeleteStatements = [
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
] as const;

function runtimeDatabase(): AccountDataDatabase {
  return getDb().$client;
}

export async function eraseOwnerSavedData(
  ownerId: string,
  databaseFactory: AccountDataDatabaseFactory = runtimeDatabase,
) {
  if (ownerId.length < 1 || ownerId.length > 256) {
    throw new Error("Invalid owner identity.");
  }

  const database = databaseFactory();
  const statements = ownerDeleteStatements.map((statement) =>
    database.prepare(statement).bind(ownerId),
  );
  await database.batch(statements);
}

