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
} from "../schema.ts";
import type { SourceConfig } from "../sources/contract.ts";
import { createCitoSource } from "../sources/cito.ts";
import { createEspnSource } from "../sources/espn.ts";
import { createKalshiSource } from "../sources/kalshi.ts";
import { createOddsApiSource } from "../sources/oddsapi.ts";
import { createPolymarketSource } from "../sources/polymarket.ts";
import { createSherdogSource } from "../sources/sherdog.ts";
import { loadFixtureEvent } from "./fixtureEvent.ts";

const config: SourceConfig = { mode: "fixture" };

export type DashboardDemoState =
  | "default"
  | "loading"
  | "error"
  | "stale"
  | "live";

export interface DashboardLoadState {
  status: "loading" | "ready" | "error";
  data: DashboardState | null;
  stale: boolean;
  message?: string;
  reload: () => void;
}

/** Journalists whose scorecards we embed; trimmed once activity is confirmed. */
const SCORECARD_ACCOUNTS: ScorecardAccount[] = [
  { handle: "arielhelwani", displayName: "Ariel Helwani", active: true },
  { handle: "DinThomas", displayName: "Din Thomas", active: true },
  { handle: "KevinI", displayName: "Kevin Iole", active: true },
  { handle: "lthomasnews", displayName: "Luke Thomas", active: true },
  { handle: "MMAJunkie", displayName: "MMA Junkie", active: true },
];

export async function assembleDashboard(): Promise<DashboardState> {
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

export function dashboardDemoState(search: string): DashboardDemoState {
  const requested = new URLSearchParams(search).get("demo");
  return requested === "loading" ||
    requested === "error" ||
    requested === "stale" ||
    requested === "live"
    ? requested
    : "default";
}

function applyLiveDemo(state: DashboardState): DashboardState {
  const liveBout =
    state.event.bouts.find((bout) => bout.status === "between-rounds") ??
    state.event.bouts[0];
  if (!liveBout) return state;
  const baseView = state.boutViews[liveBout.id];
  if (!baseView) return state;

  const replacement = {
    ...liveBout,
    status: "in-round" as const,
    currentRound: Math.min(
      (liveBout.currentRound ?? 1) + 1,
      liveBout.scheduledRounds,
    ),
  };
  return {
    ...state,
    event: {
      ...state.event,
      bouts: state.event.bouts.map((bout) =>
        bout.id === replacement.id ? replacement : bout,
      ),
    },
    boutViews: {
      ...state.boutViews,
      [replacement.id]: {
        ...baseView,
        bout: replacement,
      },
    },
  };
}

export function useDashboard(): DashboardLoadState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<DashboardLoadState, "reload">>({
    status: "loading",
    data: null,
    stale: false,
  });

  useEffect(() => {
    let cancelled = false;
    const demo = dashboardDemoState(window.location.search);
    setState({ status: "loading", data: null, stale: false });

    if (demo === "loading") {
      return () => {
        cancelled = true;
      };
    }
    if (demo === "error") {
      setState({
        status: "error",
        data: null,
        stale: false,
        message:
          "The event snapshot could not be assembled. No cached fight data was replaced.",
      });
      return () => {
        cancelled = true;
      };
    }

    assembleDashboard()
      .then((next) => {
        if (cancelled) return;
        setState({
          status: "ready",
          data: demo === "live" ? applyLiveDemo(next) : next,
          stale: demo === "stale",
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          data: null,
          stale: false,
          message:
            error instanceof Error
              ? error.message
              : "The event snapshot could not be assembled.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return {
    ...state,
    reload: () => setAttempt((current) => current + 1),
  };
}
