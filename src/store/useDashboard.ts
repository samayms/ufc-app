/**
 * Assembles DashboardState from the source clients (all fixture mode until
 * credentials arrive). Adding a live source tomorrow = changing a
 * SourceConfig here, nothing else.
 */

import { useEffect, useState } from "react";
import type {
  BoutView,
  DashboardState,
  OddsSnapshot,
  ScorecardAccount,
} from "../schema/types.ts";
import type { SourceConfig } from "../sources/contract.ts";
import { createCitoSource } from "../sources/cito.ts";
import { createEspnSource } from "../sources/espn.ts";
import { createKalshiSource } from "../sources/kalshi.ts";
import { createOddsApiSource } from "../sources/oddsapi.ts";
import { createPolymarketSource } from "../sources/polymarket.ts";
import { createSherdogSource } from "../sources/sherdog.ts";
import { loadFixtureEvent } from "./fixtureEvent.ts";

const config: SourceConfig = { mode: "fixture" };

/** Journalists whose scorecards we embed; trimmed once activity is confirmed. */
const SCORECARD_ACCOUNTS: ScorecardAccount[] = [
  { handle: "arielhelwani", displayName: "Ariel Helwani", active: true },
  { handle: "DinThomas", displayName: "Din Thomas", active: true },
  { handle: "KevinI", displayName: "Kevin Iole", active: true },
  { handle: "lthomasnews", displayName: "Luke Thomas", active: true },
  { handle: "MMAJunkie", displayName: "MMA Junkie", active: true },
];

async function assemble(): Promise<DashboardState> {
  const event = loadFixtureEvent();
  const polymarket = createPolymarketSource(config);
  const oddsApi = createOddsApiSource(config);
  const sherdog = createSherdogSource(config);
  const kalshi = createKalshiSource(config);
  const espn = createEspnSource(config);
  const cito = createCitoSource(config);

  const boutViews: Record<string, BoutView> = {};
  await Promise.all(
    event.bouts.map(async (bout) => {
      const [pm, book, kalshiSnap, sherdogRounds, espnRounds, citoRounds] = await Promise.all([
        polymarket.getOddsSnapshot(bout),
        oddsApi.getOddsSnapshot(bout),
        kalshi.getOddsSnapshot(bout),
        sherdog.getRoundUpdates(bout),
        espn.getRoundUpdates(bout),
        cito.getRoundUpdates(bout),
      ]);

      const latestOdds: BoutView["latestOdds"] = {};
      const oddsHistory: BoutView["oddsHistory"] = {};
      const record = (market: OddsSnapshot["market"], snap: OddsSnapshot | null) => {
        if (!snap) return;
        latestOdds[market] = snap;
        oddsHistory[market] = [snap];
      };
      record("kalshi", kalshiSnap);
      record("polymarket", pm);
      record("sportsbook", book);

      const rounds: BoutView["rounds"] = {};
      if (sherdogRounds.length) rounds.sherdog = sherdogRounds;
      if (espnRounds.length) rounds.espn = espnRounds;
      if (citoRounds.length) rounds.cito = citoRounds;

      boutViews[bout.id] = {
        bout,
        rounds,
        latestOdds,
        oddsHistory,
        scorecards: [],
      };
    }),
  );

  return { event, boutViews, scorecardAccounts: SCORECARD_ACCOUNTS };
}

export function useDashboard(): DashboardState | null {
  const [state, setState] = useState<DashboardState | null>(null);
  useEffect(() => {
    let cancelled = false;
    assemble().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
