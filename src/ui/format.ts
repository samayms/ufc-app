import type { FightRecord, FinishMethod, NativePrice } from "../schema.ts";

export function fmtRecord(r: FightRecord): string {
  const base = `${r.wins}-${r.losses}-${r.draws}`;
  return r.noContests > 0 ? `${base} (${r.noContests} NC)` : base;
}

export function fmtMoneyline(ml: number): string {
  return ml > 0 ? `+${ml}` : `${ml}`;
}

export function fmtPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export function fmtNative(price: NativePrice): string {
  switch (price.kind) {
    case "kalshi-cents":
      return `${price.yesCents}¢`;
    case "polymarket-price":
      return `$${price.price.toFixed(2)}`;
    case "american-moneyline":
      return fmtMoneyline(price.moneyline);
  }
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const METHOD_LABEL: Record<FinishMethod, string> = {
  "ko-tko": "KO/TKO",
  submission: "SUB",
  "decision-unanimous": "UD",
  "decision-split": "SD",
  "decision-majority": "MD",
  dq: "DQ",
  nc: "NC",
  other: "—",
};

export function fmtMethod(m: FinishMethod): string {
  return METHOD_LABEL[m];
}

export const WEIGHT_LABEL: Record<string, string> = {
  strawweight: "Strawweight",
  flyweight: "Flyweight",
  bantamweight: "Bantamweight",
  featherweight: "Featherweight",
  lightweight: "Lightweight",
  welterweight: "Welterweight",
  middleweight: "Middleweight",
  "light-heavyweight": "Light Heavyweight",
  heavyweight: "Heavyweight",
  "womens-strawweight": "Women's Strawweight",
  "womens-flyweight": "Women's Flyweight",
  "womens-bantamweight": "Women's Bantamweight",
  "womens-featherweight": "Women's Featherweight",
  catchweight: "Catchweight",
};
