import { z } from "zod";
import type {
  CanonicalSymbol,
  CausalLink,
  ClaimStatus,
  IntelligenceEvent,
  Materiality,
} from "@/lib/market-types";
import type {
  DataMode,
  FreshnessState,
  ProviderCoverage,
} from "@/lib/services/live-market-data";

export const inboxFilters = ["all", "unread", "saved", "alerts"] as const;
export type InboxFilter = (typeof inboxFilters)[number];

export const alertMinimumMaterialities = ["medium", "high", "critical"] as const;
export type AlertMinimumMateriality =
  (typeof alertMinimumMaterialities)[number];

export const inboxQuerySchema = z
  .object({
    filter: z.enum(inboxFilters).optional().default("all"),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  })
  .strict();

export const emptyInboxQuerySchema = z.object({}).strict();

export const inboxStateMutationSchema = z
  .object({
    read: z.boolean(),
    saved: z.boolean(),
    dismissed: z.boolean(),
    expected_version: z.number().int().min(1),
    expected_event_revision: z.number().int().min(1),
  })
  .strict();

export const alertRuleMutationSchema = z
  .object({
    enabled: z.boolean(),
    minimum_materiality: z.enum(alertMinimumMaterialities),
    include_controversy: z.boolean(),
    expected_version: z.number().int().min(0),
  })
  .strict();

export const canonicalInboxSymbolSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/))
  .transform((value) => value as CanonicalSymbol);

export const inboxEventIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);

export type InboxStateMutation = z.infer<typeof inboxStateMutationSchema>;
export type AlertRuleMutation = z.infer<typeof alertRuleMutationSchema>;

export interface InboxSymbolSnapshot {
  id: CanonicalSymbol;
  ticker: string;
  exchange: string;
  name: string;
}

export interface InboxEventSnapshot {
  eventId: string;
  eventRevision: number;
  symbols: InboxSymbolSnapshot[];
  source: {
    name: string;
    kind: string;
    url: string | null;
  };
  headline: string;
  summary: string | null;
  materiality: Materiality;
  category: IntelligenceEvent["category"] | null;
  claimStatus: ClaimStatus | null;
  causalLink: CausalLink | null;
  topicTags: string[];
  isControversial: boolean;
  publishedAt: string;
  receivedAt: string;
  providerUpdatedAt: string;
}

export interface InboxUserState {
  read: boolean;
  saved: boolean;
  dismissed: boolean;
  readRevision: number;
  hasUpdate: boolean;
  version: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface InboxAlertEvaluation {
  triggered: boolean;
  deliveryCount: number;
  lastDeliveredAt: string | null;
  matchedRuleSymbols: CanonicalSymbol[];
}

export interface IntelligenceInboxItem {
  event: InboxEventSnapshot;
  state: InboxUserState;
  alert: InboxAlertEvaluation;
}

export interface AlertRuleView {
  symbol: InboxSymbolSnapshot;
  enabled: boolean;
  minimumMateriality: AlertMinimumMateriality;
  includeControversy: boolean;
  channel: "in_app";
  version: number;
  persisted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface IntelligenceInboxCounts {
  all: number;
  unread: number;
  saved: number;
  alerts: number;
}

export type InboxSyncStatus =
  | "live"
  | "empty_watchlist"
  | "demo_suppressed"
  | "stale_suppressed"
  | "provider_unavailable"
  | "refresh_deferred";

export interface IntelligenceInboxSyncMeta {
  status: InboxSyncStatus;
  checkedAt: string;
  dataMode: DataMode | null;
  freshness: FreshnessState | null;
  providerCoverage: ProviderCoverage | null;
  baselineApplied: boolean;
  hasMoreCandidates: boolean;
  newItemCount: number;
  newDeliveryCount: number;
  notice: string;
}

export interface IntelligenceInboxResponse {
  data: {
    items: IntelligenceInboxItem[];
    counts: IntelligenceInboxCounts;
    rules: AlertRuleView[];
  };
  meta: {
    scope: "personal";
    identity: "authenticated";
    persistence: "server";
    channel: "in_app";
    filter: InboxFilter;
    limit: number;
    sync: IntelligenceInboxSyncMeta;
    generatedAt: string;
  };
}

export interface IntelligenceInboxItemResponse {
  data: { item: IntelligenceInboxItem };
  meta: {
    scope: "personal";
    identity: "authenticated";
    persistence: "server";
    channel: "in_app";
    generatedAt: string;
  };
}

export interface InboxStateMutationResponse {
  data: {
    eventId: string;
    eventRevision: number;
    state: InboxUserState;
  };
  meta: {
    scope: "personal";
    identity: "authenticated";
    persistence: "server";
    replayed: boolean;
    generatedAt: string;
  };
}

export interface AlertRulesResponse {
  data: { rules: AlertRuleView[] };
  meta: {
    scope: "personal";
    identity: "authenticated";
    persistence: "server";
    channel: "in_app";
    generatedAt: string;
  };
}

export interface AlertRuleMutationResponse {
  data: { rule: AlertRuleView };
  meta: {
    scope: "personal";
    identity: "authenticated";
    persistence: "server";
    channel: "in_app";
    replayed: boolean;
    generatedAt: string;
  };
}

export function parseInboxQuery(params: URLSearchParams) {
  return inboxQuerySchema.safeParse(Object.fromEntries(params));
}

export function parseEmptyInboxQuery(params: URLSearchParams) {
  return emptyInboxQuerySchema.safeParse(Object.fromEntries(params));
}

export function parseInboxStateMutation(input: unknown) {
  return inboxStateMutationSchema.safeParse(input);
}

export function parseAlertRuleMutation(input: unknown) {
  return alertRuleMutationSchema.safeParse(input);
}
