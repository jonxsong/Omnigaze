const credentialQueryKeys = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "apisecret",
  "auth",
  "authorization",
  "awsaccesskeyid",
  "bearer",
  "clientsecret",
  "credential",
  "credentials",
  "jwt",
  "key",
  "googleaccessid",
  "oauth",
  "password",
  "passwd",
  "secret",
  "secretkey",
  "session",
  "sessionid",
  "sig",
  "signature",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

function canonicalKey(value: string) {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function containsCredentialKey(parameters: URLSearchParams) {
  return [...parameters.keys()].some((key) =>
    credentialQueryKeys.has(canonicalKey(key)),
  );
}

/**
 * Accepts only public HTTP(S) URLs without inline or query-string credentials.
 * The fragment is checked too because it is still exposed to browser/MCP clients.
 */
export function isCredentialFreePublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      containsCredentialKey(url.searchParams)
    ) {
      return false;
    }

    if (url.hash) {
      const fragment = url.hash.slice(1);
      const fragmentParameters = new URLSearchParams(fragment);
      if (containsCredentialKey(fragmentParameters)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
