/**
 * Kalshi request signing (RSA-PSS, SHA-256). Public market reads don't
 * require auth, but authenticated endpoints sign
 * `${timestampMs}${METHOD}${path}` with the account's RSA private key and
 * send it alongside the key id and timestamp. Built on WebCrypto so the
 * same code runs in the browser and in node (tests). No credentials exist
 * yet — this is the scaffold tomorrow's live client plugs into.
 *
 * Kalshi's spec: RSASSA-PSS, SHA-256 digest, salt length equal to the
 * digest length (32 bytes), signature base64-encoded. The signed path is
 * the request path only (e.g. "/trade-api/v2/portfolio/balance"), no
 * query string, no host.
 */

export interface KalshiAuthHeaders {
  "KALSHI-ACCESS-KEY": string;
  "KALSHI-ACCESS-SIGNATURE": string;
  "KALSHI-ACCESS-TIMESTAMP": string;
}

const PSS_PARAMS: RsaPssParams = { name: "RSA-PSS", saltLength: 32 };

/** Strips PEM armor and decodes the base64 body into DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

/** Imports a PKCS#8 PEM private key for RSA-PSS signing. */
export async function importKalshiPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The exact string Kalshi expects to be signed. */
export function kalshiMessage(timestampMs: number, method: string, path: string): string {
  return `${timestampMs}${method.toUpperCase()}${path}`;
}

export async function signKalshiRequest(
  privateKey: CryptoKey,
  keyId: string,
  method: string,
  path: string,
  timestampMs: number = Date.now(),
): Promise<KalshiAuthHeaders> {
  const message = new TextEncoder().encode(kalshiMessage(timestampMs, method, path));
  const signature = await crypto.subtle.sign(PSS_PARAMS, privateKey, message);
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": btoa(binary),
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
  };
}
