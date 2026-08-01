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

const RSA_ENCRYPTION_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
  0x01, 0x05, 0x00,
]);

type PrivateKeyPemLabel =
  | "PRIVATE KEY"
  | "RSA PRIVATE KEY"
  | "ENCRYPTED PRIVATE KEY";

interface DecodedPem {
  label: PrivateKeyPemLabel;
  der: Uint8Array;
}

/** Encodes a DER definite length, including the multi-byte form RSA keys need. */
export function encodeDerLength(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("DER length must be a non-negative safe integer");
  }
  if (length < 0x80) return new Uint8Array([length]);

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining % 0x100);
    remaining = Math.floor(remaining / 0x100);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derElement(tag: number, contents: Uint8Array): Uint8Array {
  const length = encodeDerLength(contents.byteLength);
  const encoded = new Uint8Array(1 + length.byteLength + contents.byteLength);
  encoded[0] = tag;
  encoded.set(length, 1);
  encoded.set(contents, 1 + length.byteLength);
  return encoded;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Wraps a PKCS#1 RSAPrivateKey in the PKCS#8 PrivateKeyInfo WebCrypto accepts. */
export function wrapPkcs1PrivateKeyDer(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKey = derElement(0x04, pkcs1);
  return derElement(
    0x30,
    concatBytes(version, RSA_ENCRYPTION_ALGORITHM_IDENTIFIER, privateKey),
  );
}

function decodeBase64Body(body: string, label: string): Uint8Array {
  const base64 = body.replace(/\s+/g, "");
  if (
    base64.length === 0 ||
    base64.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  ) {
    throw new Error(`Invalid base64 in ${label} PEM`);
  }

  let raw: string;
  try {
    raw = atob(base64);
  } catch {
    throw new Error(`Invalid base64 in ${label} PEM`);
  }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Parses only the private-key PEM armors the Kalshi signer understands. */
function decodePrivateKeyPem(pem: string): DecodedPem {
  const begin = pem.match(/-----BEGIN ([A-Z0-9 ]+)-----/);
  if (!begin?.[1]) {
    throw new Error(
      "Kalshi private key PEM armor not found; expected PRIVATE KEY or RSA PRIVATE KEY",
    );
  }

  const label = begin[1];
  if (label === "ENCRYPTED PRIVATE KEY") {
    throw new Error(
      "Kalshi private key is passphrase-encrypted; decrypt it first and provide an unencrypted PEM",
    );
  }
  if (label !== "PRIVATE KEY" && label !== "RSA PRIVATE KEY") {
    throw new Error(
      `Unsupported Kalshi private key PEM armor "${label}"; expected PRIVATE KEY or RSA PRIVATE KEY`,
    );
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const complete = pem.match(
    new RegExp(
      `^\\s*-----BEGIN ${escapedLabel}-----([\\s\\S]*?)-----END ${escapedLabel}-----\\s*$`,
    ),
  );
  if (!complete?.[1]) {
    throw new Error(
      `Malformed ${label} PEM; expected matching BEGIN and END armor`,
    );
  }

  return {
    label,
    der: decodeBase64Body(complete[1], label),
  };
}

/** Imports either PKCS#8 or PKCS#1 PEM private keys for RSA-PSS signing. */
export async function importKalshiPrivateKey(pem: string): Promise<CryptoKey> {
  const decoded = decodePrivateKeyPem(pem);
  const pkcs8 =
    decoded.label === "RSA PRIVATE KEY"
      ? wrapPkcs1PrivateKeyDer(decoded.der)
      : decoded.der;
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(pkcs8),
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
