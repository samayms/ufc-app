import type {
  BoutResult,
  BoutStatus,
  FightRecord,
  FinishMethod,
  NativePrice,
} from "../schema.ts";

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

/** Magnitude of an implied-probability delta, in percentage points. Direction is rendered separately (arrow, color) — this is never signed. */
export function fmtMove(deltaProbability: number): string {
  return `${(Math.abs(deltaProbability) * 100).toFixed(1)}pp`;
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

export function fmtEventDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtEventDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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

/** Compact, mutually exclusive fight phase for card-rail status chips. */
export function fmtFightPhase(
  status: BoutStatus,
  currentRound?: number,
  result?: BoutResult,
): string {
  switch (status) {
    case "in-round":
      return currentRound !== undefined && currentRound >= 1
        ? `IN R${currentRound}`
        : "WALKOUTS";
    case "between-rounds":
      return currentRound !== undefined && currentRound >= 1
        ? `END R${currentRound}`
        : "END ROUND";
    case "final": {
      if (result === undefined) return "FINAL";
      const method = result.method === "other" ? "FINAL" : fmtMethod(result.method);
      return `${method}${result.round ? ` · R${result.round}` : ""}`;
    }
    case "canceled":
      return "CANCELED";
    case "postponed":
      return "POSTPONED";
    default:
      return "UPCOMING";
  }
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
