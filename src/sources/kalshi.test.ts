import { describe, expect, it } from "vitest";
import { loadFixtureEvent } from "../store/fixtureEvent.ts";
import { createKalshiSource } from "./kalshi.ts";
import {
  importKalshiPrivateKey,
  kalshiMessage,
  signKalshiRequest,
} from "./kalshiAuth.ts";

const event = loadFixtureEvent();
const bout = (id: string) => {
  const b = event.bouts.find((x) => x.id === id);
  if (!b) throw new Error(`missing fixture bout ${id}`);
  return b;
};

describe("createKalshiSource", () => {
  const source = createKalshiSource({ mode: "fixture" });

  it("throws at construction in live mode", () => {
    expect(() => createKalshiSource({ mode: "live" })).toThrow(/live mode/);
  });

  it("returns mid-price quotes for both corners of the main event", async () => {
    const snap = await source.getOddsSnapshot(bout("bout-main"));
    expect(snap).not.toBeNull();
    expect(snap!.market).toBe("kalshi");
    const red = snap!.quotes.find((q) => q.corner === "red")!;
    const blue = snap!.quotes.find((q) => q.corner === "blue")!;
    // mid of 59/62 and 38/41
    expect(red.impliedProbability).toBeCloseTo(0.605, 5);
    expect(blue.impliedProbability).toBeCloseTo(0.395, 5);
    expect(red.native).toEqual({ kind: "kalshi-cents", yesCents: 60.5, noCents: 39.5 });
    expect(snap!.provenance.synthetic).toBe(true);
  });

  it("returns null for bouts without a market", async () => {
    expect(await source.getOddsSnapshot(bout("bout-comain"))).toBeNull();
    expect(await source.getOddsSnapshot(bout("bout-5"))).toBeNull();
  });
});

describe("createKalshiSource getTickHistory", () => {
  const source = createKalshiSource({ mode: "fixture" });

  it("returns bout-main's tick history in fixture order", async () => {
    const ticks = await source.getTickHistory("bout-main");
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.every((t) => t.boutId === "bout-main")).toBe(true);
    expect(ticks.every((t) => t.source === "kalshi")).toBe(true);
  });

  it("returns an empty history for a bout with no ticks", async () => {
    expect(await source.getTickHistory("bout-comain")).toEqual([]);
  });

  it("returns an empty history when asked for a different source", async () => {
    expect(await source.getTickHistory("bout-main", "polymarket")).toEqual([]);
  });
});

describe("kalshi RSA-PSS signing", () => {
  it("builds the timestamp+METHOD+path message", () => {
    expect(kalshiMessage(1753500000000, "get", "/trade-api/v2/portfolio/balance")).toBe(
      "1753500000000GET/trade-api/v2/portfolio/balance",
    );
  });

  it("produces a verifiable RSA-PSS signature from a PKCS#8 PEM key", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let b64 = "";
    for (const byte of der) b64 += String.fromCharCode(byte);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----`;

    const key = await importKalshiPrivateKey(pem);
    const ts = 1753500000000;
    const headers = await signKalshiRequest(key, "key-123", "GET", "/trade-api/v2/markets", ts);

    expect(headers["KALSHI-ACCESS-KEY"]).toBe("key-123");
    expect(headers["KALSHI-ACCESS-TIMESTAMP"]).toBe(String(ts));

    const sig = Uint8Array.from(atob(headers["KALSHI-ACCESS-SIGNATURE"]), (c) =>
      c.charCodeAt(0),
    );
    const ok = await crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      pair.publicKey,
      sig,
      new TextEncoder().encode(kalshiMessage(ts, "GET", "/trade-api/v2/markets")),
    );
    expect(ok).toBe(true);
  });
});
