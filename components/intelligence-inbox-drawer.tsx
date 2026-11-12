"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  BellRing,
  Bookmark,
  BookmarkCheck,
  Check,
  Clock3,
  ExternalLink,
  FileText,
  Inbox,
  LoaderCircle,
  LogIn,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { CanonicalSymbol, Materiality } from "@/lib/market-types";
import type {
  AlertMinimumMateriality,
  AlertRuleMutationResponse,
  AlertRuleView,
  AlertRulesResponse,
  InboxStateMutationResponse,
  IntelligenceInboxCounts,
  IntelligenceInboxItem,
  IntelligenceInboxItemResponse,
  IntelligenceInboxResponse,
  IntelligenceInboxSyncMeta,
} from "@/lib/intelligence-inbox/contracts";
import styles from "./intelligence-inbox-drawer.module.css";

export type IntelligenceInboxTab = "inbox" | "saved" | "rules";
type InboxFilter = "all" | "unread" | "alerts" | "high_impact";
type ResourcePhase = "idle" | "loading" | "ready" | "refreshing" | "degraded";

export interface IntelligenceInboxInstrument {
  id: CanonicalSymbol;
  ticker: string;
  name: string;
}

export interface IntelligenceInboxSaveRequest {
  eventId: string;
  nonce: number;
}

export type IntelligenceInboxSaveResult =
  | "saved"
  | "already_saved"
  | "not_found"
  | "auth_required"
  | "conflict"
  | "error";

export interface IntelligenceInboxDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  isAuthenticated: boolean;
  signInPath: string;
  instruments: IntelligenceInboxInstrument[];
  initialTab?: IntelligenceInboxTab;
  focusEventId?: string | null;
  saveRequest?: IntelligenceInboxSaveRequest | null;
  onSaveRequestHandled?(
    request: IntelligenceInboxSaveRequest,
    result: IntelligenceInboxSaveResult,
  ): void;
  onCountsChange?(counts: IntelligenceInboxCounts): void;
}

interface InboxResource {
  phase: ResourcePhase;
  items: IntelligenceInboxItem[];
  counts: IntelligenceInboxCounts;
  sync: IntelligenceInboxSyncMeta | null;
  message: string | null;
}

interface RulesResource {
  phase: ResourcePhase;
  rules: AlertRuleView[];
  message: string | null;
}

const emptyCounts: IntelligenceInboxCounts = {
  all: 0,
  unread: 0,
  saved: 0,
  alerts: 0,
};

const INTELLIGENCE_DRAWER_POLL_MS = 60_000;
const inboxTabOrder: IntelligenceInboxTab[] = ["inbox", "saved", "rules"];

function inboxTabId(tab: IntelligenceInboxTab) {
  return `intelligence-inbox-tab-${tab}`;
}

const materialityOrder: Record<Materiality, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function responseError(body: unknown, fallback: string) {
  const error = asRecord(body).error;
  return typeof error === "string" && error.trim() ? error : fallback;
}

function isHealthySyncStatus(status: IntelligenceInboxSyncMeta["status"]) {
  return (
    status === "live" ||
    status === "empty_watchlist" ||
    status === "refresh_deferred"
  );
}

function formatEventTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const ageMs = Date.now() - timestamp;
  const ageMinutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (ageMinutes < 1) return "Just now";
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function materialityLabel(value: Materiality) {
  return `${value[0].toUpperCase()}${value.slice(1)} impact`;
}

function symbolLabel(item: IntelligenceInboxItem) {
  if (item.event.symbols.length === 0) return "Market";
  const tickers = item.event.symbols.map(({ ticker }) => ticker);
  return tickers.slice(0, 2).join(" · ") + (tickers.length > 2 ? ` +${tickers.length - 2}` : "");
}

function countContribution(item: IntelligenceInboxItem): IntelligenceInboxCounts {
  return {
    all: item.state.dismissed ? 0 : 1,
    unread:
      !item.state.dismissed && (!item.state.read || item.state.hasUpdate) ? 1 : 0,
    saved: item.state.saved ? 1 : 0,
    alerts: !item.state.dismissed && item.alert.triggered ? 1 : 0,
  };
}

function sameMutableInboxState(
  left: IntelligenceInboxItem["state"],
  right: IntelligenceInboxItem["state"],
) {
  return (
    left.version === right.version &&
    left.read === right.read &&
    left.saved === right.saved &&
    left.dismissed === right.dismissed
  );
}

function sameRuleConfiguration(left: AlertRuleView, right: AlertRuleView) {
  return (
    left.version === right.version &&
    left.enabled === right.enabled &&
    left.minimumMateriality === right.minimumMateriality &&
    left.includeControversy === right.includeControversy
  );
}

function replaceInboxItem(
  resource: InboxResource,
  eventId: string,
  replacement: IntelligenceInboxItem,
): InboxResource {
  const previous = resource.items.find(
    (candidate) => candidate.event.eventId === eventId,
  );
  if (!previous) {
    return { ...resource, items: [replacement, ...resource.items] };
  }
  const before = countContribution(previous);
  const after = countContribution(replacement);
  const counts = { ...resource.counts };
  for (const key of Object.keys(counts) as Array<keyof IntelligenceInboxCounts>) {
    counts[key] = Math.max(0, counts[key] + after[key] - before[key]);
  }
  return {
    ...resource,
    items: resource.items.map((candidate) =>
      candidate.event.eventId === eventId ? replacement : candidate,
    ),
    counts,
  };
}

export function IntelligenceInboxDrawer({
  open,
  onOpenChange,
  isAuthenticated,
  signInPath,
  instruments,
  initialTab = "inbox",
  focusEventId = null,
  saveRequest = null,
  onSaveRequestHandled,
  onCountsChange,
}: IntelligenceInboxDrawerProps) {
  const [tab, setTab] = useState<IntelligenceInboxTab>(initialTab);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [inbox, setInbox] = useState<InboxResource>({
    phase: "idle",
    items: [],
    counts: emptyCounts,
    sync: null,
    message: null,
  });
  const [rules, setRules] = useState<RulesResource>({
    phase: "idle",
    rules: [],
    message: null,
  });
  const [busyItems, setBusyItems] = useState<Set<string>>(new Set());
  const [busyRules, setBusyRules] = useState<Set<CanonicalSymbol>>(new Set());
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [savedLoaded, setSavedLoaded] = useState(false);
  const handledSaveNonces = useRef(new Set<number>());

  const loadInbox = useCallback(async (signal?: AbortSignal) => {
    setInbox((current) => ({
      ...current,
      phase: current.items.length > 0 ? "refreshing" : "loading",
      message: null,
    }));
    try {
      const response = await fetch("/api/intelligence/inbox?filter=all&limit=100", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(
          responseError(body, `Inbox refresh failed with ${response.status}.`),
        );
      }
      const parsed = body as IntelligenceInboxResponse;
      if (!Array.isArray(parsed?.data?.items) || !parsed?.data?.counts || !parsed?.meta?.sync) {
        throw new Error("The intelligence inbox returned an invalid response.");
      }
      setInbox({
        phase: isHealthySyncStatus(parsed.meta.sync.status) ? "ready" : "degraded",
        items: parsed.data.items,
        counts: parsed.data.counts,
        sync: parsed.meta.sync,
        message: isHealthySyncStatus(parsed.meta.sync.status)
          ? null
          : parsed.meta.sync.notice ??
            "Live provider refresh is delayed. Stored account events remain available.",
      });
      setRules({ phase: "ready", rules: parsed.data.rules, message: null });
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      setInbox((current) => ({
        ...current,
        phase: "degraded",
        message:
          error instanceof Error
            ? error.message
            : "The intelligence inbox is temporarily unavailable.",
      }));
      return false;
    }
  }, []);

  const loadSaved = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(
        "/api/intelligence/inbox?filter=saved&limit=100",
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(
          responseError(
            body,
            `Saved intelligence refresh failed with ${response.status}.`,
          ),
        );
      }
      const parsed = body as IntelligenceInboxResponse;
      if (
        !Array.isArray(parsed?.data?.items) ||
        !parsed?.data?.counts ||
        !parsed?.meta?.sync
      ) {
        throw new Error("Saved intelligence returned an invalid response.");
      }
      setInbox((current) => {
        const merged = new Map(
          current.items.map((item) => [item.event.eventId, item]),
        );
        for (const item of parsed.data.items) {
          merged.set(item.event.eventId, item);
        }
        return {
          ...current,
          phase: isHealthySyncStatus(parsed.meta.sync.status)
            ? "ready"
            : "degraded",
          items: [...merged.values()].sort(
            (left, right) =>
              right.event.publishedAt.localeCompare(left.event.publishedAt) ||
              left.event.eventId.localeCompare(right.event.eventId),
          ),
          counts: parsed.data.counts,
          sync: parsed.meta.sync,
          message: isHealthySyncStatus(parsed.meta.sync.status)
            ? null
            : parsed.meta.sync.notice ??
              "Live provider refresh is delayed. Stored saved intelligence remains available.",
        };
      });
      setRules({ phase: "ready", rules: parsed.data.rules, message: null });
      setSavedLoaded(true);
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      setInbox((current) => ({
        ...current,
        phase: "degraded",
        message:
          error instanceof Error
            ? error.message
            : "Saved intelligence is temporarily unavailable.",
      }));
      return false;
    }
  }, []);

  const loadInboxItem = useCallback(async (eventId: string) => {
    try {
      const response = await fetch(
        `/api/intelligence/inbox/${encodeURIComponent(eventId)}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 404) return { status: "not_found" as const };
      if (!response.ok) {
        throw new Error(
          responseError(body, `Inbox item lookup failed with ${response.status}.`),
        );
      }
      const parsed = body as IntelligenceInboxItemResponse;
      if (
        parsed?.data?.item?.event?.eventId !== eventId ||
        typeof parsed.data.item.state?.version !== "number"
      ) {
        throw new Error("The inbox item lookup returned an invalid response.");
      }
      return { status: "found" as const, item: parsed.data.item };
    } catch (error) {
      return {
        status: "error" as const,
        message:
          error instanceof Error
            ? error.message
            : "The durable inbox item could not be loaded.",
      };
    }
  }, []);

  const loadRules = useCallback(async (signal?: AbortSignal) => {
    setRules((current) => ({
      ...current,
      phase: current.rules.length > 0 ? "refreshing" : "loading",
      message: null,
    }));
    try {
      const response = await fetch("/api/alerts/rules", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(
          responseError(body, `Alert rules refresh failed with ${response.status}.`),
        );
      }
      const parsed = body as AlertRulesResponse;
      if (!Array.isArray(parsed?.data?.rules)) {
        throw new Error("The alert rules endpoint returned an invalid response.");
      }
      setRules({ phase: "ready", rules: parsed.data.rules, message: null });
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      setRules((current) => ({
        ...current,
        phase: "degraded",
        message:
          error instanceof Error
            ? error.message
            : "Alert rules are temporarily unavailable.",
      }));
      return false;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setActionMessage(null);
    setSavedLoaded(false);
    if (!isAuthenticated) return;
    const controller = new AbortController();
    void loadInbox(controller.signal);
    return () => controller.abort();
  }, [initialTab, isAuthenticated, loadInbox, open]);

  useEffect(() => {
    if (
      !open ||
      !isAuthenticated ||
      tab !== "rules" ||
      rules.phase !== "idle"
    ) {
      return;
    }
    const controller = new AbortController();
    void loadRules(controller.signal);
    return () => controller.abort();
  }, [isAuthenticated, loadRules, open, rules.phase, tab]);

  useEffect(() => {
    if (
      !open ||
      !isAuthenticated ||
      tab !== "saved" ||
      savedLoaded ||
      inbox.phase === "idle" ||
      inbox.phase === "loading"
    ) {
      return;
    }
    const controller = new AbortController();
    void loadSaved(controller.signal);
    return () => controller.abort();
  }, [
    inbox.phase,
    isAuthenticated,
    loadSaved,
    open,
    savedLoaded,
    tab,
  ]);

  const pendingDeferredSave = Boolean(
    saveRequest &&
      !handledSaveNonces.current.has(saveRequest.nonce) &&
      inbox.sync?.status === "refresh_deferred" &&
      !inbox.items.some(
        (candidate) => candidate.event.eventId === saveRequest.eventId,
      ),
  );

  useEffect(() => {
    if (!open || !isAuthenticated) return;
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | undefined;
    const pollDelay = inbox.sync?.hasMoreCandidates || pendingDeferredSave
      ? 2_000
      : INTELLIGENCE_DRAWER_POLL_MS;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, INTELLIGENCE_DRAWER_POLL_MS);
        return;
      }
      activeController = new AbortController();
      await loadInbox(activeController.signal);
      if (tab === "saved" && !activeController.signal.aborted) {
        await loadSaved(activeController.signal);
      }
      if (!stopped) {
        timer = window.setTimeout(poll, pollDelay);
      }
    }

    timer = window.setTimeout(poll, pollDelay);
    return () => {
      stopped = true;
      activeController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [
    inbox.sync?.hasMoreCandidates,
    isAuthenticated,
    loadInbox,
    loadSaved,
    open,
    pendingDeferredSave,
    tab,
  ]);

  const unreadCount = inbox.counts.unread;

  useEffect(() => {
    onCountsChange?.(inbox.counts);
  }, [inbox.counts, onCountsChange]);

  const visibleItems = useMemo(() => {
    const base =
      tab === "saved"
        ? inbox.items.filter((item) => item.state.saved)
        : inbox.items.filter((item) => !item.state.dismissed);
    if (tab === "saved" || filter === "all") return base;
    if (filter === "unread") {
      return base.filter((item) => !item.state.read || item.state.hasUpdate);
    }
    if (filter === "alerts") return base.filter((item) => item.alert.triggered);
    return base.filter(
      (item) => materialityOrder[item.event.materiality] >= materialityOrder.high,
    );
  }, [filter, inbox.items, tab]);

  const mutateItem = useCallback(
    async (
      item: IntelligenceInboxItem,
      patch: Partial<Pick<IntelligenceInboxItem["state"], "read" | "saved" | "dismissed">>,
    ) => {
      const eventId = item.event.eventId;
      if (busyItems.has(eventId)) return "error" as const;
      const nextState = {
        ...item.state,
        ...patch,
        ...(patch.read === true
          ? { hasUpdate: false, readRevision: item.event.eventRevision }
          : {}),
      };
      setActionMessage(null);
      setBusyItems((current) => new Set(current).add(eventId));
      setInbox((current) =>
        replaceInboxItem(current, eventId, { ...item, state: nextState }),
      );

      try {
        const response = await fetch(
          `/api/intelligence/inbox/${encodeURIComponent(eventId)}`,
          {
            method: "PATCH",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              read: nextState.read,
              saved: nextState.saved,
              dismissed: nextState.dismissed,
              expected_version: item.state.version,
              expected_event_revision: item.event.eventRevision,
            }),
          },
        );
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) {
          if (response.status === 409) {
            setInbox((current) => replaceInboxItem(current, eventId, item));
            const refreshed = await loadInbox();
            setActionMessage(
              refreshed
                ? "This event changed in another session. Omnigaze loaded the latest account state."
                : "This event changed in another session. Your optimistic change was rolled back, but the latest account state could not be loaded.",
            );
            return "conflict" as const;
          }
          throw new Error(
            responseError(body, `Inbox update failed with ${response.status}.`),
          );
        }
        const parsed = body as InboxStateMutationResponse;
        if (
          parsed?.data?.eventId !== eventId ||
          typeof parsed.data.state?.version !== "number"
        ) {
          throw new Error("The inbox update returned an invalid response.");
        }
        setInbox((current) => {
          const candidate = current.items.find(
            (entry) => entry.event.eventId === eventId,
          );
          if (!candidate) return current;
          return replaceInboxItem(current, eventId, {
            ...candidate,
            event: {
              ...candidate.event,
              eventRevision: parsed.data.eventRevision,
            },
            state: parsed.data.state,
          });
        });
        return "saved" as const;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Inbox update failed.";
        const focused = await loadInboxItem(eventId);
        let refreshed = false;
        if (focused.status === "found") {
          setInbox((current) =>
            replaceInboxItem(current, eventId, focused.item),
          );
          refreshed = true;
        } else {
          refreshed = await loadInbox();
        }
        if (!refreshed) {
          setInbox((current) => {
            const currentItem = current.items.find(
              (candidate) => candidate.event.eventId === eventId,
            );
            return currentItem && sameMutableInboxState(currentItem.state, nextState)
              ? replaceInboxItem(current, eventId, item)
              : current;
          });
        }
        setActionMessage(
          refreshed
            ? `${message} Omnigaze loaded the latest account state.`
            : `${message} The latest account state could not be verified; the optimistic view was rolled back.`,
        );
        return "error" as const;
      } finally {
        setBusyItems((current) => {
          const next = new Set(current);
          next.delete(eventId);
          return next;
        });
      }
    },
    [busyItems, loadInbox, loadInboxItem],
  );

  const updateRule = useCallback(
    async (
      symbolId: CanonicalSymbol,
      patch: Partial<Pick<AlertRuleView, "enabled" | "minimumMateriality" | "includeControversy">>,
    ) => {
      if (busyRules.has(symbolId)) return;
      const instrument = instruments.find((candidate) => candidate.id === symbolId);
      if (!instrument) return;
      const existing = rules.rules.find((rule) => rule.symbol.id === symbolId);
      const previous: AlertRuleView =
        existing ?? {
          symbol: {
            id: symbolId,
            ticker: instrument.ticker,
            exchange: symbolId.split(":")[0] ?? "UNKNOWN",
            name: instrument.name,
          },
          enabled: false,
          minimumMateriality: "high",
          includeControversy: false,
          channel: "in_app",
          version: 0,
          persisted: false,
          createdAt: null,
          updatedAt: null,
        };
      const desired = { ...previous, ...patch };
      setActionMessage(null);
      setBusyRules((current) => new Set(current).add(symbolId));
      setRules((current) => ({
        ...current,
        rules: [
          ...current.rules.filter((rule) => rule.symbol.id !== symbolId),
          desired,
        ],
      }));

      try {
        const response = await fetch(
          `/api/alerts/rules/${encodeURIComponent(symbolId)}`,
          {
            method: "PUT",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              enabled: desired.enabled,
              minimum_materiality: desired.minimumMateriality,
              include_controversy: desired.includeControversy,
              expected_version: previous.version,
            }),
          },
        );
        const body = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) {
          if (response.status === 409) {
            setRules((current) => ({
              ...current,
              rules: existing
                ? [
                    ...current.rules.filter(
                      (rule) => rule.symbol.id !== symbolId,
                    ),
                    existing,
                  ]
                : current.rules.filter(
                    (rule) => rule.symbol.id !== symbolId,
                  ),
            }));
            const refreshed = await loadRules();
            setActionMessage(
              refreshed
                ? "This rule changed in another session. Omnigaze loaded the latest version."
                : "This rule changed in another session. Your optimistic change was rolled back, but the latest rule could not be loaded.",
            );
            return;
          }
          throw new Error(
            responseError(body, `Alert rule update failed with ${response.status}.`),
          );
        }
        const parsed = body as AlertRuleMutationResponse;
        if (parsed?.data?.rule?.symbol.id !== symbolId) {
          throw new Error("The alert rule update returned an invalid response.");
        }
        setRules((current) => ({
          ...current,
          rules: [
            ...current.rules.filter((rule) => rule.symbol.id !== symbolId),
            parsed.data.rule,
          ],
        }));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Alert rule update failed.";
        const refreshed = await loadRules();
        if (!refreshed) {
          setRules((current) => {
            const currentRule = current.rules.find(
              (rule) => rule.symbol.id === symbolId,
            );
            if (!currentRule || !sameRuleConfiguration(currentRule, desired)) {
              return current;
            }
            return {
              ...current,
              rules: existing
                ? [
                    ...current.rules.filter(
                      (rule) => rule.symbol.id !== symbolId,
                    ),
                    existing,
                  ]
                : current.rules.filter(
                    (rule) => rule.symbol.id !== symbolId,
                  ),
            };
          });
        }
        setActionMessage(
          refreshed
            ? `${message} Omnigaze loaded the latest rule state.`
            : `${message} The latest rule state could not be verified; the optimistic view was rolled back.`,
        );
      } finally {
        setBusyRules((current) => {
          const next = new Set(current);
          next.delete(symbolId);
          return next;
        });
      }
    },
    [busyRules, instruments, loadRules, rules.rules],
  );

  useEffect(() => {
    if (!open || !focusEventId || inbox.items.length === 0) return;
    const timer = window.setTimeout(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-inbox-event-id]"),
      ).find((element) => element.dataset.inboxEventId === focusEventId);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [focusEventId, inbox.items.length, open]);

  useEffect(() => {
    if (!open || !saveRequest || handledSaveNonces.current.has(saveRequest.nonce)) {
      return;
    }
    if (!isAuthenticated) {
      handledSaveNonces.current.add(saveRequest.nonce);
      setActionMessage("Sign in before saving intelligence to your thesis.");
      onSaveRequestHandled?.(saveRequest, "auth_required");
      return;
    }
    if (
      inbox.phase === "idle" ||
      inbox.phase === "loading" ||
      inbox.phase === "refreshing"
    ) {
      return;
    }

    const materializedItem = inbox.items.find(
      (candidate) => candidate.event.eventId === saveRequest.eventId,
    );
    if (
      !materializedItem &&
      (inbox.sync?.hasMoreCandidates ||
        inbox.sync?.status === "refresh_deferred")
    ) {
      return;
    }

    handledSaveNonces.current.add(saveRequest.nonce);
    void (async () => {
      let item = materializedItem;
      if (!item) {
        const focused = await loadInboxItem(saveRequest.eventId);
        if (focused.status === "error") {
          setActionMessage(
            `${focused.message} Nothing was saved.`,
          );
          onSaveRequestHandled?.(saveRequest, "error");
          return;
        }
        if (focused.status === "not_found") {
          setActionMessage(
            "This event is not eligible for durable saving. Demo, stale, and unverified feed items are never added to your account inbox.",
          );
          onSaveRequestHandled?.(saveRequest, "not_found");
          return;
        }
        const focusedItem = focused.item;
        item = focusedItem;
        setInbox((current) =>
          replaceInboxItem(current, focusedItem.event.eventId, focusedItem),
        );
      }
      if (item.state.saved) {
        setTab("saved");
        setActionMessage("This event is already saved in your thesis workspace.");
        onSaveRequestHandled?.(saveRequest, "already_saved");
        return;
      }

      const result = await mutateItem(item, { saved: true });
      if (result === "saved") {
        setTab("saved");
        setActionMessage("Saved to your thesis workspace.");
      }
      onSaveRequestHandled?.(saveRequest, result);
    })();
  }, [
    inbox.items,
    inbox.phase,
    inbox.sync,
    isAuthenticated,
    loadInboxItem,
    mutateItem,
    onSaveRequestHandled,
    open,
    saveRequest,
  ]);

  const syncLabel =
    inbox.sync?.hasMoreCandidates
      ? "Catching up on fresh evidence"
      : inbox.sync?.status === "live"
        ? "Live provider check complete"
        : inbox.sync?.status === "refresh_deferred"
          ? "Recent provider check reused"
          : inbox.sync?.status === "empty_watchlist"
            ? "Add stocks to begin monitoring"
            : inbox.items.length > 0
              ? "Showing stored account intelligence"
              : "Live provider refresh unavailable";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={styles.drawer}
          aria-describedby="intelligence-inbox-description"
          data-testid="intelligence-inbox-drawer"
        >
          <header className={styles.header}>
            <div className={styles.headerIdentity}>
              <span className={styles.headerIcon} aria-hidden="true">
                <BellRing size={19} />
                {unreadCount > 0 && <i />}
              </span>
              <div>
                <span>PERSONAL MARKET INTELLIGENCE</span>
                <DialogPrimitive.Title>Intelligence inbox</DialogPrimitive.Title>
                <DialogPrimitive.Description id="intelligence-inbox-description">
                  Evidence that matters to the stocks you follow.
                </DialogPrimitive.Description>
              </div>
            </div>
            <div className={styles.headerActions}>
              {isAuthenticated && (
                <button
                  type="button"
                  className={styles.refreshButton}
                  aria-label="Refresh intelligence inbox"
                  disabled={inbox.phase === "loading" || inbox.phase === "refreshing"}
                  onClick={() => {
                    void (async () => {
                      await loadInbox();
                      if (tab === "saved") await loadSaved();
                    })();
                  }}
                >
                  <RefreshCw
                    size={16}
                    className={
                      inbox.phase === "loading" || inbox.phase === "refreshing"
                        ? styles.spinning
                        : undefined
                    }
                  />
                </button>
              )}
              <DialogPrimitive.Close className={styles.closeButton}>
                <X size={18} />
                <span className="sr-only">Close intelligence inbox</span>
              </DialogPrimitive.Close>
            </div>
          </header>

          {!isAuthenticated ? (
            <div className={styles.authGate} data-testid="inbox-auth-gate">
              <span className={styles.gateIcon}><ShieldCheck size={25} /></span>
              <span className={styles.eyebrow}>YOUR PRIVATE WORKSPACE</span>
              <h2>Sign in to keep your intelligence</h2>
              <p>
                Read state, saved research, and alert rules belong to your account and
                stay synchronized across your Omnigaze sessions.
              </p>
              <a href={signInPath} target="_top">
                <LogIn size={16} /> Sign in to continue
              </a>
              <small>
                Omnigaze does not create background alerts or store inbox activity
                while you are signed out.
              </small>
            </div>
          ) : (
            <>
              <nav
                className={styles.tabs}
                role="tablist"
                aria-label="Intelligence inbox views"
                onKeyDown={(event) => {
                  if (
                    event.key !== "ArrowLeft" &&
                    event.key !== "ArrowRight" &&
                    event.key !== "Home" &&
                    event.key !== "End"
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const currentIndex = inboxTabOrder.indexOf(tab);
                  const nextTab =
                    event.key === "Home"
                      ? inboxTabOrder[0]
                      : event.key === "End"
                        ? inboxTabOrder[inboxTabOrder.length - 1]
                        : inboxTabOrder[
                            (currentIndex + (event.key === "ArrowRight" ? 1 : -1) +
                              inboxTabOrder.length) % inboxTabOrder.length
                          ];
                  setTab(nextTab);
                  window.requestAnimationFrame(() => {
                    document.getElementById(inboxTabId(nextTab))?.focus();
                  });
                }}
              >
                <button
                  id={inboxTabId("inbox")}
                  type="button"
                  role="tab"
                  aria-selected={tab === "inbox"}
                  aria-controls="intelligence-inbox-panel"
                  aria-label={
                    unreadCount > 0
                      ? `Inbox, ${unreadCount} unread`
                      : "Inbox"
                  }
                  tabIndex={tab === "inbox" ? 0 : -1}
                  className={tab === "inbox" ? styles.activeTab : undefined}
                  onClick={() => setTab("inbox")}
                >
                  <Inbox size={15} /> Inbox
                  {unreadCount > 0 && <span>{unreadCount > 99 ? "99+" : unreadCount}</span>}
                </button>
                <button
                  id={inboxTabId("saved")}
                  type="button"
                  role="tab"
                  aria-selected={tab === "saved"}
                  aria-controls="intelligence-inbox-panel"
                  tabIndex={tab === "saved" ? 0 : -1}
                  className={tab === "saved" ? styles.activeTab : undefined}
                  onClick={() => setTab("saved")}
                >
                  <Bookmark size={15} /> Saved
                </button>
                <button
                  id={inboxTabId("rules")}
                  type="button"
                  role="tab"
                  aria-selected={tab === "rules"}
                  aria-controls="intelligence-inbox-panel"
                  tabIndex={tab === "rules" ? 0 : -1}
                  className={tab === "rules" ? styles.activeTab : undefined}
                  onClick={() => setTab("rules")}
                >
                  <SlidersHorizontal size={15} /> Rules
                </button>
              </nav>

              {tab === "inbox" && (
                <div
                  className={styles.filterBar}
                  role="group"
                  aria-label="Filter intelligence"
                >
                  {(
                    [
                      ["all", "All"],
                      ["unread", "Unread"],
                      ["alerts", "Alerts"],
                      ["high_impact", "High impact"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={filter === value ? styles.activeFilter : undefined}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {(inbox.phase === "degraded" || rules.phase === "degraded") && (
                <div className={styles.degradedNotice} role="status">
                  <AlertTriangle size={15} />
                  <div>
                    <strong>{syncLabel}</strong>
                    <span>
                      {tab === "rules"
                        ? rules.message ?? "Stored alert rules remain visible."
                        : inbox.message ?? "Stored inbox events remain visible."}
                    </span>
                  </div>
                </div>
              )}

              {pendingDeferredSave ? (
                <div className={styles.actionNotice} role="status" aria-live="polite">
                  <LoaderCircle className={styles.spinning} size={14} />
                  Finishing the durable refresh before saving…
                </div>
              ) : actionMessage ? (
                <div className={styles.actionNotice} role="status" aria-live="polite">
                  <RotateCcw size={14} /> {actionMessage}
                </div>
              ) : null}

              <div
                id="intelligence-inbox-panel"
                className={styles.body}
                role="tabpanel"
                aria-labelledby={inboxTabId(tab)}
                tabIndex={0}
              >
                {tab === "rules" ? (
                  <RulesPanel
                    instruments={instruments}
                    resource={rules}
                    busyRules={busyRules}
                    onUpdate={updateRule}
                  />
                ) : inbox.phase === "loading" && inbox.items.length === 0 ? (
                  <LoadingState />
                ) : visibleItems.length === 0 ? (
                  <EmptyState tab={tab} filter={filter} watchedCount={instruments.length} />
                ) : (
                  <div className={styles.eventList}>
                    {visibleItems.map((item) => (
                      <InboxEventCard
                        key={item.event.eventId}
                        item={item}
                        busy={busyItems.has(item.event.eventId)}
                        onMutate={mutateItem}
                      />
                    ))}
                  </div>
                )}
              </div>

              <footer className={styles.footer}>
                <span className={styles.syncState}>
                  {inbox.sync?.status === "live" ? <Radio size={12} /> : <Clock3 size={12} />}
                  {syncLabel}
                </span>
                <span>Live, fresh evidence only. Demo and stale items never create alerts.</span>
              </footer>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function LoadingState() {
  return (
    <div className={styles.loadingState} role="status">
      <LoaderCircle className={styles.spinning} size={22} />
      <strong>Checking your market intelligence</strong>
      <span>Matching fresh provider evidence to your watchlist…</span>
    </div>
  );
}

function EmptyState({
  tab,
  filter,
  watchedCount,
}: {
  tab: Exclude<IntelligenceInboxTab, "rules">;
  filter: InboxFilter;
  watchedCount: number;
}) {
  const copy =
    watchedCount === 0
      ? ["Your inbox starts with a watchlist", "Add a stock and Omnigaze will check fresh provider evidence when you return."]
      : tab === "saved"
        ? ["No saved research yet", "Save an event to keep it available for your thesis, even after it leaves the recent feed."]
        : filter === "unread"
          ? ["You are caught up", "There are no unread intelligence events in your account."]
          : filter === "alerts"
            ? ["No matching alerts", "Alert rules are opt-in. Enable one in Rules to surface matching fresh evidence here."]
            : filter === "high_impact"
              ? ["No high-impact events", "No stored events currently meet the high or critical impact filter."]
              : ["No provider events yet", "Omnigaze will keep checking for live, fresh evidence tied to your watchlist."];
  return (
    <div className={styles.emptyState} role="status">
      <span><Sparkles size={21} /></span>
      <strong>{copy[0]}</strong>
      <p>{copy[1]}</p>
    </div>
  );
}

function InboxEventCard({
  item,
  busy,
  onMutate,
}: {
  item: IntelligenceInboxItem;
  busy: boolean;
  onMutate(
    item: IntelligenceInboxItem,
    patch: Partial<
      Pick<IntelligenceInboxItem["state"], "read" | "saved" | "dismissed">
    >,
  ): Promise<"saved" | "conflict" | "error">;
}) {
  const needsRead = !item.state.read || item.state.hasUpdate;
  return (
    <article
      className={`${styles.eventCard} ${needsRead ? styles.unreadEvent : ""}`}
      data-testid={`inbox-event-${item.event.eventId}`}
      data-inbox-event-id={item.event.eventId}
      tabIndex={-1}
    >
      <div className={styles.eventTopline}>
        <div>
          {needsRead && <i aria-label="Unread" />}
          <span className={styles.symbolChip}>{symbolLabel(item)}</span>
          <span className={`${styles.impactChip} ${styles[item.event.materiality]}`}>
            {materialityLabel(item.event.materiality)}
          </span>
          {item.alert.triggered && (
            <span className={styles.alertChip}><Bell size={11} /> Rule match</span>
          )}
        </div>
        <time dateTime={item.event.publishedAt}>{formatEventTime(item.event.publishedAt)}</time>
      </div>

      <h3>{item.event.headline}</h3>
      {item.event.summary && <p>{item.event.summary}</p>}

      <div className={styles.eventContext}>
        <span>{item.event.source.name}</span>
        {item.event.category && <span>{item.event.category.replaceAll("_", " ")}</span>}
        {item.event.claimStatus && <span>{item.event.claimStatus.replaceAll("-", " ")}</span>}
        {item.event.isControversial && <span className={styles.controversy}>Controversy</span>}
        {item.state.hasUpdate && (
          <span className={styles.updated}>
            {item.state.read ? "Updated since read" : "Provider update"}
          </span>
        )}
      </div>

      <div className={styles.eventActions}>
        {item.event.source.url ? (
          <a
            href={item.event.source.url}
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              if (needsRead) void onMutate(item, { read: true });
            }}
          >
            <ExternalLink size={13} /> Open source
          </a>
        ) : (
          <span className={styles.noSource}><FileText size={13} /> Source link unavailable</span>
        )}
        <button
          type="button"
          disabled={busy}
          aria-pressed={!needsRead}
          onClick={() => void onMutate(item, { read: needsRead })}
        >
          {needsRead ? <Check size={13} /> : <RotateCcw size={13} />}
          {needsRead ? "Mark read" : "Mark unread"}
        </button>
        <button
          type="button"
          disabled={busy}
          aria-pressed={item.state.saved}
          className={item.state.saved ? styles.savedAction : undefined}
          onClick={() => void onMutate(item, { saved: !item.state.saved })}
        >
          {item.state.saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
          {item.state.saved ? "Saved" : "Save for thesis"}
        </button>
        <button
          type="button"
          disabled={busy}
          className={styles.dismissAction}
          onClick={() => void onMutate(item, { dismissed: !item.state.dismissed })}
        >
          {item.state.dismissed ? <RotateCcw size={13} /> : <Trash2 size={13} />}
          {item.state.dismissed ? "Restore" : "Dismiss"}
        </button>
        {busy && <LoaderCircle className={styles.spinning} size={14} aria-label="Saving" />}
      </div>
    </article>
  );
}

function RulesPanel({
  instruments,
  resource,
  busyRules,
  onUpdate,
}: {
  instruments: IntelligenceInboxInstrument[];
  resource: RulesResource;
  busyRules: Set<CanonicalSymbol>;
  onUpdate(
    symbolId: CanonicalSymbol,
    patch: Partial<
      Pick<AlertRuleView, "enabled" | "minimumMateriality" | "includeControversy">
    >,
  ): Promise<void>;
}) {
  if (resource.phase === "loading" && resource.rules.length === 0) return <LoadingState />;
  return (
    <div className={styles.rulesPanel}>
      <div className={styles.deliveryNotice}>
        <span><BellRing size={18} /></span>
        <div>
          <strong>In-app only</strong>
          <p>
            Matching evidence appears in Omnigaze when it becomes available and when
            you next open the app. Email, SMS, push, and browser notifications are not
            enabled.
          </p>
        </div>
      </div>

      <div className={styles.rulesIntro}>
        <div>
          <span className={styles.eyebrow}>WATCHLIST RULES</span>
          <h2>Choose what earns your attention</h2>
        </div>
        <p>Rules are off by default and are never inferred from onboarding answers.</p>
      </div>

      {instruments.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <span><SlidersHorizontal size={21} /></span>
          <strong>Add a stock before creating a rule</strong>
          <p>Each alert rule is scoped to one symbol on your watchlist.</p>
        </div>
      ) : (
        <div className={styles.ruleList}>
          {instruments.map((instrument) => {
            const rule = resource.rules.find(
              (candidate) => candidate.symbol.id === instrument.id,
            ) ?? {
              symbol: {
                id: instrument.id,
                ticker: instrument.ticker,
                exchange: instrument.id.split(":")[0] ?? "UNKNOWN",
                name: instrument.name,
              },
              enabled: false,
              minimumMateriality: "high" as const,
              includeControversy: false,
              channel: "in_app" as const,
              version: 0,
              persisted: false,
              createdAt: null,
              updatedAt: null,
            };
            const busy = busyRules.has(instrument.id);
            return (
              <article className={styles.ruleCard} key={instrument.id} data-testid={`alert-rule-${instrument.id}`}>
                <div className={styles.ruleHeading}>
                  <div className={styles.ruleSymbol}>
                    <span>{instrument.ticker[0]}</span>
                    <div><strong>{instrument.ticker}</strong><small>{instrument.name}</small></div>
                  </div>
                  <label className={styles.ruleSwitch}>
                    <span className="sr-only">Enable {instrument.ticker} in-app alert rule</span>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={busy}
                      onChange={(event) => void onUpdate(instrument.id, { enabled: event.target.checked })}
                    />
                    <i aria-hidden="true" />
                    <b>{rule.enabled ? "On" : "Off"}</b>
                  </label>
                </div>
                <div className={styles.ruleFields} aria-disabled={!rule.enabled}>
                  <label>
                    <span>Minimum impact</span>
                    <select
                      value={rule.minimumMateriality}
                      disabled={busy || !rule.enabled}
                      onChange={(event) =>
                        void onUpdate(instrument.id, {
                          minimumMateriality: event.target.value as AlertMinimumMateriality,
                        })
                      }
                    >
                      <option value="medium">Medium or higher</option>
                      <option value="high">High or critical</option>
                      <option value="critical">Critical only</option>
                    </select>
                  </label>
                  <label className={styles.checkField}>
                    <input
                      type="checkbox"
                      checked={rule.includeControversy}
                      disabled={busy || !rule.enabled}
                      onChange={(event) =>
                        void onUpdate(instrument.id, {
                          includeControversy: event.target.checked,
                        })
                      }
                    />
                    <span><b>Include controversy</b><small>Reported disputes, allegations, and reputation events.</small></span>
                  </label>
                </div>
                {busy && <span className={styles.ruleSaving}><LoaderCircle className={styles.spinning} size={13} /> Saving rule…</span>}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
