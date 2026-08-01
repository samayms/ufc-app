import {
  constants,
  generateKeyPairSync,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodeDerLength,
  importKalshiPrivateKey,
  kalshiMessage,
  signKalshiRequest,
  wrapPkcs1PrivateKeyDer,
} from "./kalshiAuth.ts";

const MESSAGE_PATH = "/trade-api/v2/portfolio/balance";
const TIMESTAMP_MS = 1_753_500_000_000;

function generatePemKeyPair(): {
  pkcs1: string;
  pkcs8: string;
  publicKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKey,
  };
}

async function sign(
  pem: string,
  method = "GET",
  path = MESSAGE_PATH,
): Promise<Buffer> {
  const key = await importKalshiPrivateKey(pem);
  const headers = await signKalshiRequest(
    key,
    "test-key",
    method,
    path,
    TIMESTAMP_MS,
  );
  return Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64");
}

function verifies(
  signature: Buffer,
  publicKey: KeyObject,
  method = "GET",
  path = MESSAGE_PATH,
): boolean {
  return verifySignature(
    "sha256",
    Buffer.from(kalshiMessage(TIMESTAMP_MS, method, path)),
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    },
    signature,
  );
}

describe("Kalshi private-key loading", () => {
  it("imports a PKCS#8 PEM key", async () => {
    const { pkcs8, publicKey } = generatePemKeyPair();

    expect(verifies(await sign(pkcs8), publicKey)).toBe(true);
  });

  it("wraps and imports a PKCS#1 PEM key", async () => {
    const { pkcs1, publicKey } = generatePemKeyPair();

    expect(verifies(await sign(pkcs1), publicKey)).toBe(true);
  });

  it("produces independently verifiable signatures through both armors", async () => {
    const { pkcs1, pkcs8, publicKey } = generatePemKeyPair();

    const pkcs1Signature = await sign(pkcs1);
    const pkcs8Signature = await sign(pkcs8);

    expect(verifies(pkcs1Signature, publicKey)).toBe(true);
    expect(verifies(pkcs8Signature, publicKey)).toBe(true);
  });

  it("rejects passphrase-encrypted private keys with an actionable error", async () => {
    const encryptedPem =
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----";

    await expect(importKalshiPrivateKey(encryptedPem)).rejects.toThrow(
      /passphrase-encrypted; decrypt it first/i,
    );
  });

  it("rejects missing, unsupported, and corrupt PEM input clearly", async () => {
    await expect(importKalshiPrivateKey("not a key")).rejects.toThrow(
      /PEM armor not found/i,
    );
    await expect(
      importKalshiPrivateKey(
        "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
      ),
    ).rejects.toThrow(/PUBLIC KEY/);
    await expect(
      importKalshiPrivateKey(
        "-----BEGIN PRIVATE KEY-----\n%%%bad%%%\n-----END PRIVATE KEY-----",
      ),
    ).rejects.toThrow(/Invalid base64 in PRIVATE KEY PEM/);
  });

  it("accepts CRLF line endings and trailing whitespace", async () => {
    const { pkcs1, publicKey } = generatePemKeyPair();
    const downloadedPem = `${pkcs1.replace(/\n/g, "\r\n")}\r\n`;

    expect(verifies(await sign(downloadedPem), publicKey)).toBe(true);
  });
});

describe("Kalshi PKCS#1 DER wrapping", () => {
  it("encodes short and two-byte DER lengths in big-endian order", () => {
    expect([...encodeDerLength(0x7f)]).toEqual([0x7f]);
    expect([...encodeDerLength(0x80)]).toEqual([0x81, 0x80]);
    expect([...encodeDerLength(0x1234)]).toEqual([0x82, 0x12, 0x34]);
  });

  it("places the PKCS#1 bytes in a PKCS#8 OCTET STRING", () => {
    const pkcs1 = new Uint8Array(256).fill(0xa5);
    const wrapped = wrapPkcs1PrivateKeyDer(pkcs1);

    expect([...wrapped.slice(0, 7)]).toEqual([
      0x30, 0x82, 0x01, 0x16, 0x02, 0x01, 0x00,
    ]);
    expect([...wrapped.slice(-256)]).toEqual([...pkcs1]);
  });
});

describe("kalshiMessage", () => {
  it("joins timestamp, upper-cased method, and path exactly", () => {
    expect(kalshiMessage(TIMESTAMP_MS, "gEt", MESSAGE_PATH)).toBe(
      `${TIMESTAMP_MS}GET${MESSAGE_PATH}`,
    );
  });
});
