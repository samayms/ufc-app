import type {
  Bout,
  Corner,
  ExpertConsensus,
  ExpertConsensusValue,
  SherdogRoundObservation,
} from "../src/schema.ts";
import {
  scoreWinner,
  type ParsedExpertScore,
} from "../src/sources/x.ts";

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
    .toLocaleLowerCase("en");
}

function winnerCorner(bout: Bout, winner: string): Corner | undefined {
  const normalizedWinner = normalizedName(winner);
  if (!normalizedWinner) return undefined;

  return (["red", "blue"] as const).find((corner) => {
    const full = normalizedName(bout.fighters[corner].name);
    const last = normalizedName(
      bout.fighters[corner].name.trim().split(/\s+/).at(-1) ?? "",
    );
    return normalizedWinner === full || normalizedWinner === last;
  });
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
  xScores: readonly ParsedExpertScore[],
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
  const xConsensus = consensusValue(
    "x",
    xScores.map((score) => scoreWinner(score.score)),
  );

  if (sherdogConsensus === undefined && xConsensus === undefined) {
    return undefined;
  }
  return {
    ...(sherdogConsensus === undefined
      ? {}
      : { sherdog: sherdogConsensus }),
    ...(xConsensus === undefined ? {} : { x: xConsensus }),
  };
}
