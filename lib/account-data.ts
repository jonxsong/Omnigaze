import { z } from "zod";
import { DATA_DELETION_CONFIRMATION } from "@/lib/account-data-constants";

export { DATA_DELETION_CONFIRMATION } from "@/lib/account-data-constants";
export const DATA_DELETION_CHALLENGE_COOKIE =
  "omnigaze_data_deletion_challenge";
export const DATA_DELETION_CHALLENGE_TTL_SECONDS = 5 * 60;

const deletionRequestSchema = z
  .object({
    challenge: z.string().uuid(),
    confirmation: z.literal(DATA_DELETION_CONFIRMATION),
  })
  .strict();

export type AccountDataDeletionRequest = z.infer<
  typeof deletionRequestSchema
>;

export function parseAccountDataDeletionRequest(value: unknown) {
  return deletionRequestSchema.safeParse(value);
}

export function isSameOriginMutation(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const key = segment.slice(0, separator).trim();
    if (key !== name) continue;
    const value = segment.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function dataDeletionChallengeCookie(
  requestUrl: string,
  challenge: string,
  maxAge = DATA_DELETION_CHALLENGE_TTL_SECONDS,
) {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${DATA_DELETION_CHALLENGE_COOKIE}=${encodeURIComponent(challenge)}; Path=/api/account/data; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

