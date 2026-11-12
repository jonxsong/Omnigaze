import { z } from "zod";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  isPortfolioDecimal,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
} from "./decimal";

const MAX_VERSION = 2_147_483_647;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export const portfolioCanonicalSymbolSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/))
  .transform((value) => value as CanonicalSymbol);

export const experienceLevelSchema = z.enum([
  "unspecified",
  "beginner",
  "intermediate",
  "advanced",
]);

export const riskComfortSchema = z.enum([
  "unspecified",
  "low",
  "medium",
  "high",
]);

export const timeHorizonSchema = z.enum([
  "unspecified",
  "under_1y",
  "1_to_3y",
  "3_to_7y",
  "over_7y",
]);

export const portfolioObjectiveSchema = z.enum([
  "unspecified",
  "capital_preservation",
  "income",
  "balanced_growth",
  "growth",
  "learning",
]);

const expectedVersionSchema = z.number().int().min(0).max(MAX_VERSION);

const quantityDecimalSchema = z
  .string()
  .max(32)
  .refine(
    (value) =>
      isPortfolioDecimal(value, {
        allowZero: false,
        maxMicros: MAX_QUANTITY_MICROS,
      }),
    "Quantity must be a positive decimal with at most six fractional digits.",
  );

const averageCostDecimalSchema = z
  .string()
  .max(32)
  .refine(
    (value) =>
      isPortfolioDecimal(value, {
        allowZero: true,
        maxMicros: MAX_AVERAGE_COST_MICROS,
      }),
    "Average cost must be a non-negative decimal with at most six fractional digits.",
  );

export const portfolioProfileMutationSchema = z
  .object({
    base_currency: z.literal("USD"),
    experience_level: experienceLevelSchema,
    risk_comfort: riskComfortSchema,
    time_horizon: timeHorizonSchema,
    objective: portfolioObjectiveSchema,
    max_single_position_bps: z.number().int().min(100).max(10_000).nullable(),
    expected_version: expectedVersionSchema,
  })
  .strict();

export const portfolioHoldingMutationSchema = z
  .object({
    quantity: quantityDecimalSchema,
    average_cost: averageCostDecimalSchema.nullable(),
    cost_currency: z.literal("USD"),
    quantity_as_of: z.string().datetime({ offset: true }),
    expected_version: expectedVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.quantity_as_of) > Date.now() + MAX_FUTURE_SKEW_MS) {
      context.addIssue({
        code: "custom",
        path: ["quantity_as_of"],
        message: "Quantity as-of time cannot be in the future.",
      });
    }
  });

export const portfolioHoldingDeleteQuerySchema = z
  .object({
    expected_version: z.coerce.number().int().min(1).max(MAX_VERSION),
  })
  .strict();

const scenarioBudgetSchema = z
  .string()
  .max(32)
  .refine(
    (value) =>
      isPortfolioDecimal(value, {
        allowZero: false,
        maxMicros: MAX_AVERAGE_COST_MICROS,
      }),
    "Scenario budget must be a positive USD decimal with at most six fractional digits.",
  );

export const portfolioDecisionSupportRequestSchema = z
  .object({
    symbol_id: portfolioCanonicalSymbolSchema,
    horizon: z.enum(["near_term", "long_term"]),
    preset: z.enum(["tight", "balanced", "wide"]),
    budget: scenarioBudgetSchema.nullable().optional(),
  })
  .strict();

export type PortfolioProfileMutation = z.infer<
  typeof portfolioProfileMutationSchema
>;
export type PortfolioHoldingMutation = z.infer<
  typeof portfolioHoldingMutationSchema
>;
export type PortfolioDecisionSupportRequest = z.infer<
  typeof portfolioDecisionSupportRequestSchema
>;

export function isOnboardingComplete(
  profile: Pick<
    PortfolioProfileMutation,
    "experience_level" | "risk_comfort" | "time_horizon" | "objective"
  >,
) {
  return (
    profile.experience_level !== "unspecified" &&
    profile.risk_comfort !== "unspecified" &&
    profile.time_horizon !== "unspecified" &&
    profile.objective !== "unspecified"
  );
}

export function parsePortfolioProfileMutation(input: unknown) {
  return portfolioProfileMutationSchema.safeParse(input);
}

export function parsePortfolioHoldingMutation(input: unknown) {
  return portfolioHoldingMutationSchema.safeParse(input);
}

export function parsePortfolioHoldingDeleteQuery(params: URLSearchParams) {
  return portfolioHoldingDeleteQuerySchema.safeParse(Object.fromEntries(params));
}

export function parsePortfolioDecisionSupportRequest(input: unknown) {
  return portfolioDecisionSupportRequestSchema.safeParse(input);
}
