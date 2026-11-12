import { and, asc, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  instruments,
  portfolioHoldings,
  portfolioProfiles,
} from "@/db/schema";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  type PortfolioHoldingMutation,
  type PortfolioProfileMutation,
  isOnboardingComplete,
} from "@/lib/portfolio/contracts";
import {
  decimalToMicros,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
  microsToDecimal,
  multiplyMicrosToDecimal,
} from "@/lib/portfolio/decimal";
import { MAX_PORTFOLIO_PULSE_POSITIONS } from "@/lib/portfolio/portfolio-pulse";
import {
  addSymbolToWatchlist,
  ensureDefaultWatchlist,
  type InstrumentRecordInput,
} from "@/lib/repositories/watchlists";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";

export type PortfolioRepositoryErrorCode =
  | "asset_catalog_unavailable"
  | "holding_not_found"
  | "holding_version_conflict"
  | "profile_version_conflict"
  | "symbol_not_supported";

export class PortfolioRepositoryError extends Error {
  constructor(readonly code: PortfolioRepositoryErrorCode) {
    super(code);
    this.name = "PortfolioRepositoryError";
  }
}

type ProfileRow = typeof portfolioProfiles.$inferSelect;
type HoldingRow = typeof portfolioHoldings.$inferSelect;
type HoldingInstrument = Pick<
  InstrumentRecordInput,
  "ticker" | "exchange" | "name"
>;
type ResolvedHoldingInstrument = InstrumentRecordInput;

function serializeProfile(row: ProfileRow) {
  return {
    baseCurrency: row.baseCurrency,
    experienceLevel: row.experienceLevel,
    riskComfort: row.riskComfort,
    timeHorizon: row.timeHorizon,
    objective: row.objective,
    maxSinglePositionBps: row.maxSinglePositionBps,
    onboardingCompletedAt: row.onboardingCompletedAt,
    isComplete:
      row.experienceLevel !== "unspecified" &&
      row.riskComfort !== "unspecified" &&
      row.timeHorizon !== "unspecified" &&
      row.objective !== "unspecified",
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeHolding(row: HoldingRow, instrument: HoldingInstrument) {
  return {
    symbolId: row.symbolId as CanonicalSymbol,
    ticker: instrument.ticker,
    exchange: instrument.exchange,
    name: instrument.name,
    quantity: microsToDecimal(row.quantityMicros),
    averageCost:
      row.averageCostMicros === null
        ? null
        : microsToDecimal(row.averageCostMicros),
    totalCostBasis:
      row.averageCostMicros === null
        ? null
        : multiplyMicrosToDecimal(row.quantityMicros, row.averageCostMicros),
    costCurrency: row.costCurrency,
    quantityAsOf: row.quantityAsOf,
    entrySource: row.entrySource,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function profileMatches(row: ProfileRow, input: PortfolioProfileMutation) {
  return (
    row.baseCurrency === input.base_currency &&
    row.experienceLevel === input.experience_level &&
    row.riskComfort === input.risk_comfort &&
    row.timeHorizon === input.time_horizon &&
    row.objective === input.objective &&
    row.maxSinglePositionBps === input.max_single_position_bps
  );
}

function holdingMatches(
  row: HoldingRow,
  values: {
    quantityMicros: number;
    averageCostMicros: number | null;
    costCurrency: string;
    quantityAsOf: string;
  },
) {
  return (
    row.quantityMicros === values.quantityMicros &&
    row.averageCostMicros === values.averageCostMicros &&
    row.costCurrency === values.costCurrency &&
    row.quantityAsOf === values.quantityAsOf
  );
}

async function selectProfile(ownerId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(portfolioProfiles)
    .where(eq(portfolioProfiles.ownerId, ownerId))
    .limit(1);
  return rows[0] ?? null;
}

async function selectHolding(ownerId: string, symbolId: CanonicalSymbol) {
  const db = getDb();
  const rows = await db
    .select()
    .from(portfolioHoldings)
    .where(
      and(
        eq(portfolioHoldings.ownerId, ownerId),
        eq(portfolioHoldings.symbolId, symbolId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function resolveHoldingInstrument(symbolId: CanonicalSymbol) {
  const db = getDb();
  const stored = await db
    .select({
      id: instruments.id,
      ticker: instruments.ticker,
      exchange: instruments.exchange,
      name: instruments.name,
      sector: instruments.sector,
      currency: instruments.currency,
      status: instruments.status,
    })
    .from(instruments)
    .where(eq(instruments.id, symbolId))
    .limit(1);
  if (stored[0]) {
    return { ...stored[0], id: stored[0].id as CanonicalSymbol };
  }

  try {
    return await resolveCanonicalInstrument(symbolId);
  } catch (error) {
    if (
      error instanceof InstrumentResolutionError &&
      error.code === "asset_catalog_unavailable"
    ) {
      throw new PortfolioRepositoryError("asset_catalog_unavailable");
    }
    throw new PortfolioRepositoryError("symbol_not_supported");
  }
}

async function ensureSymbolIsWatched(
  ownerId: string,
  symbolId: CanonicalSymbol,
  instrument: ResolvedHoldingInstrument,
) {
  const watchlist = await ensureDefaultWatchlist(ownerId);
  await addSymbolToWatchlist(
    ownerId,
    watchlist.id,
    symbolId,
    instrument,
  );
}

export async function getUserPortfolio(ownerId: string) {
  const db = getDb();
  const [profile, holdingRows] = await Promise.all([
    selectProfile(ownerId),
    db
      .select({
        holding: portfolioHoldings,
        instrument: instruments,
      })
      .from(portfolioHoldings)
      .innerJoin(instruments, eq(instruments.id, portfolioHoldings.symbolId))
      .where(eq(portfolioHoldings.ownerId, ownerId))
      .orderBy(asc(instruments.ticker)),
  ]);

  return {
    profile: profile ? serializeProfile(profile) : null,
    holdings: holdingRows.map(({ holding, instrument }) =>
      serializeHolding(holding, instrument),
    ),
  };
}

/**
 * Reads only the bounded canonical-symbol slice used by Portfolio Pulse while
 * retaining a separate owner-scoped total for truthful truncation metadata.
 * The existing full portfolio read intentionally remains unchanged for its
 * other callers.
 */
export async function getPortfolioPulseHoldings(ownerId: string) {
  const db = getDb();
  const [countRows, holdingRows] = await Promise.all([
    db
      .select({ totalPositions: count() })
      .from(portfolioHoldings)
      .where(eq(portfolioHoldings.ownerId, ownerId)),
    db
      .select({
        holding: portfolioHoldings,
        instrument: instruments,
      })
      .from(portfolioHoldings)
      .innerJoin(instruments, eq(instruments.id, portfolioHoldings.symbolId))
      .where(eq(portfolioHoldings.ownerId, ownerId))
      .orderBy(asc(portfolioHoldings.symbolId))
      .limit(MAX_PORTFOLIO_PULSE_POSITIONS),
  ]);

  return {
    holdings: holdingRows.map(({ holding, instrument }) =>
      serializeHolding(holding, instrument),
    ),
    totalPositions: countRows[0]?.totalPositions ?? 0,
  };
}

export async function putPortfolioProfile(
  ownerId: string,
  input: PortfolioProfileMutation,
) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = await selectProfile(ownerId);

  if (existing && profileMatches(existing, input)) {
    return serializeProfile(existing);
  }

  if (input.expected_version === 0) {
    if (existing) {
      throw new PortfolioRepositoryError("profile_version_conflict");
    }

    const inserted = await db
      .insert(portfolioProfiles)
      .values({
        ownerId,
        baseCurrency: input.base_currency,
        experienceLevel: input.experience_level,
        riskComfort: input.risk_comfort,
        timeHorizon: input.time_horizon,
        objective: input.objective,
        maxSinglePositionBps: input.max_single_position_bps,
        onboardingCompletedAt: isOnboardingComplete(input) ? now : null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted[0]) return serializeProfile(inserted[0]);
    const winner = await selectProfile(ownerId);
    if (winner && profileMatches(winner, input)) return serializeProfile(winner);
    throw new PortfolioRepositoryError("profile_version_conflict");
  }

  if (!existing || existing.version !== input.expected_version) {
    throw new PortfolioRepositoryError("profile_version_conflict");
  }

  const updated = await db
    .update(portfolioProfiles)
    .set({
      baseCurrency: input.base_currency,
      experienceLevel: input.experience_level,
      riskComfort: input.risk_comfort,
      timeHorizon: input.time_horizon,
      objective: input.objective,
      maxSinglePositionBps: input.max_single_position_bps,
      onboardingCompletedAt: isOnboardingComplete(input)
        ? existing.onboardingCompletedAt ?? now
        : null,
      version: existing.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(portfolioProfiles.ownerId, ownerId),
        eq(portfolioProfiles.version, input.expected_version),
      ),
    )
    .returning();

  if (updated[0]) return serializeProfile(updated[0]);
  const winner = await selectProfile(ownerId);
  if (winner && profileMatches(winner, input)) return serializeProfile(winner);
  throw new PortfolioRepositoryError("profile_version_conflict");
}

export async function putPortfolioHolding(
  ownerId: string,
  symbolId: CanonicalSymbol,
  input: PortfolioHoldingMutation,
) {
  const instrument = await resolveHoldingInstrument(symbolId);

  const db = getDb();
  const now = new Date().toISOString();
  const values = {
    quantityMicros: decimalToMicros(input.quantity, {
      allowZero: false,
      maxMicros: MAX_QUANTITY_MICROS,
    }),
    averageCostMicros:
      input.average_cost === null
        ? null
        : decimalToMicros(input.average_cost, {
            allowZero: true,
            maxMicros: MAX_AVERAGE_COST_MICROS,
          }),
    costCurrency: input.cost_currency,
    quantityAsOf: input.quantity_as_of,
  };
  const existing = await selectHolding(ownerId, symbolId);

  if (existing && holdingMatches(existing, values)) {
    await ensureSymbolIsWatched(ownerId, symbolId, instrument);
    return serializeHolding(existing, instrument);
  }

  if (
    (input.expected_version === 0 && existing) ||
    (input.expected_version > 0 &&
      (!existing || existing.version !== input.expected_version))
  ) {
    throw new PortfolioRepositoryError("holding_version_conflict");
  }

  await ensureSymbolIsWatched(ownerId, symbolId, instrument);

  if (!existing) {
    const inserted = await db
      .insert(portfolioHoldings)
      .values({
        ownerId,
        symbolId,
        ...values,
        entrySource: "user_entered",
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted[0]) {
      return serializeHolding(inserted[0], instrument);
    }
    const winner = await selectHolding(ownerId, symbolId);
    if (winner && holdingMatches(winner, values)) {
      return serializeHolding(winner, instrument);
    }
    throw new PortfolioRepositoryError("holding_version_conflict");
  }

  const updated = await db
    .update(portfolioHoldings)
    .set({
      ...values,
      version: existing.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(portfolioHoldings.ownerId, ownerId),
        eq(portfolioHoldings.symbolId, symbolId),
        eq(portfolioHoldings.version, input.expected_version),
      ),
    )
    .returning();

  if (updated[0]) return serializeHolding(updated[0], instrument);
  const winner = await selectHolding(ownerId, symbolId);
  if (winner && holdingMatches(winner, values)) {
    return serializeHolding(winner, instrument);
  }
  throw new PortfolioRepositoryError("holding_version_conflict");
}

export async function deletePortfolioHolding(
  ownerId: string,
  symbolId: CanonicalSymbol,
  expectedVersion: number,
) {
  const db = getDb();
  const existing = await selectHolding(ownerId, symbolId);
  if (!existing) throw new PortfolioRepositoryError("holding_not_found");
  if (existing.version !== expectedVersion) {
    throw new PortfolioRepositoryError("holding_version_conflict");
  }

  const deleted = await db
    .delete(portfolioHoldings)
    .where(
      and(
        eq(portfolioHoldings.ownerId, ownerId),
        eq(portfolioHoldings.symbolId, symbolId),
        eq(portfolioHoldings.version, expectedVersion),
      ),
    )
    .returning({ symbolId: portfolioHoldings.symbolId });

  if (!deleted[0]) {
    const winner = await selectHolding(ownerId, symbolId);
    if (!winner) return { symbolId, deleted: true as const };
    throw new PortfolioRepositoryError("holding_version_conflict");
  }

  return { symbolId: deleted[0].symbolId as CanonicalSymbol, deleted: true as const };
}
