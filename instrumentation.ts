import type { Instrumentation } from "next";
import { reportUnexpectedFailure } from "@/lib/unexpected-failure";

const SAFE_ROUTER_KINDS = new Map<string, string>([
  ["App Router", "app"],
  ["Pages Router", "pages"],
]);
const SAFE_ROUTE_TYPES = new Set([
  "action",
  "middleware",
  "proxy",
  "render",
  "route",
]);

/**
 * Vinext invokes this hook for unhandled request failures outside our route
 * wrappers. Request paths, headers, error messages, and stacks stay excluded.
 */
export const onRequestError: Instrumentation.onRequestError = (
  error,
  _request,
  context,
) => {
  const routerKind = SAFE_ROUTER_KINDS.get(context.routerKind) ?? "unknown";
  const routeType = SAFE_ROUTE_TYPES.has(context.routeType)
    ? context.routeType
    : "unknown";
  reportUnexpectedFailure(
    `framework.${routerKind}.${routeType}`,
    error,
  );
};
