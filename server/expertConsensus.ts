import type {
  Bout,
  Corner,
  ExpertConsensus,
  ExpertConsensusValue,
  SherdogRoundObservation,
} from "../src/schema.ts";
import { fighterNameMatches } from "../src/sources/sherdog.ts";

function winnerCorner(bout: Bout, winner: string): Corner | undefined {
  return (["red", "blue"] as const).find((corner) =>
    fighterNameMatches(bout.fighters[corner].name, winner),
  );
}

function consensusValue(
  source: ExpertConsensusValue["source"],
  votes: readonly (Corner | "draw")[],
): ExpertConsensusValue | undefined {
  if (votes.length === 0) return undefined;
  const redVotes = votes.filter((vote) => vote === "red").length;
  const blueVotes = votes.filter((vote) => vote === "blue").length;
  const drawVotes = votes.filter((vote) => vote === "draw").length;
  const maximum = Math.max(redVotes, blueVotes, drawVotes);
  const leaders = [
    ["red", redVotes],
    ["blue", blueVotes],
    ["draw", drawVotes],
  ].filter(([, count]) => count === maximum);

  return {
    source,
    redVotes,
    blueVotes,
    drawVotes,
    total: votes.length,
    ...(leaders.length === 1
      ? { leader: leaders[0]?.[0] as Corner | "draw" }
      : {}),
  };
}

export function computeExpertConsensus(
  bout: Bout,
  sherdog: SherdogRoundObservation | undefined,
): ExpertConsensus | undefined {
  const sherdogConsensus =
    sherdog === undefined
      ? undefined
      : consensusValue(
          "sherdog",
          sherdog.scorerCards.flatMap((card) => {
            if (card.winner === undefined) return [];
            const corner = winnerCorner(bout, card.winner);
            return corner === undefined ? [] : [corner];
          }),
        );

  if (sherdogConsensus === undefined) {
    return undefined;
  }
  return { sherdog: sherdogConsensus };
}
