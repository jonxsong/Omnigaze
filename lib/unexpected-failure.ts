const EVENT_NAME = "omnigaze.unexpected_failure";

type FailureKind = "error" | "unknown";

export function reportUnexpectedFailure(
  operation: string,
  failure: unknown,
) {
  const requestId = crypto.randomUUID();
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
}) {
  const requestId = reportUnexpectedFailure(
    options.operation,
    options.failure,
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
