const EVENT_NAME = "omnigaze.unexpected_failure";
const SERVER_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FailureKind = "error" | "unknown";

export function reportUnexpectedFailure(
  operation: string,
  failure: unknown,
  serverRequestId?: string,
) {
  const requestId =
    serverRequestId && SERVER_REQUEST_ID_PATTERN.test(serverRequestId)
      ? serverRequestId
      : crypto.randomUUID();
  const failureKind: FailureKind = failure instanceof Error ? "error" : "unknown";

  // Deliberately omit the thrown message, stack, request body, owner identity,
  // URL, and provider payload. The opaque request ID is enough to correlate a
  // client-visible failure with platform logs without copying sensitive data.
  console.error(EVENT_NAME, {
    event: EVENT_NAME,
    operation,
    requestId,
    failureKind,
  });

  return requestId;
}

export function unexpectedApiError(options: {
  operation: string;
  failure: unknown;
  code: string;
  message: string;
  status: number;
  serverRequestId?: string;
}) {
  const requestId = reportUnexpectedFailure(
    options.operation,
    options.failure,
    options.serverRequestId,
  );

  return Response.json(
    {
      error: options.message,
      code: options.code,
      requestId,
    },
    {
      status: options.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-ID": requestId,
      },
    },
  );
}
