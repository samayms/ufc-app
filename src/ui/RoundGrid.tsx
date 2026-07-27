import type { BoutView, Corner, RoundUpdate, SourceId } from "../schema/types.ts";
import { fmtTime } from "./format.ts";

const SOURCE_LABEL: Partial<Record<SourceId, string>> = {
  sherdog: "Sherdog",
  espn: "ESPN",
  cito: "Cito",
};

function scoreCell(update: RoundUpdate | undefined, round: number) {
  if (!update?.score) {
    return (
      <td key={round} className="rg-cell rg-empty">
        —
      </td>
    );
  }
  const { red, blue } = update.score;
  const winner: Corner | null = red > blue ? "red" : blue > red ? "blue" : null;
  return (
    <td key={round} className={`rg-cell num${winner ? ` rg-win-${winner}` : ""}`}>
      {red}-{blue}
    </td>
  );
}

export function RoundGrid({ view }: { view: BoutView }) {
  const { bout, rounds } = view;
  // Table rows only for sources that actually score rounds; summary-only
  // sources (e.g. ESPN recaps) still feed the prose block below.
  const sources = (Object.keys(rounds) as SourceId[]).filter((s) =>
    rounds[s]?.some((u) => u.score),
  );
  const roundNumbers = Array.from({ length: bout.scheduledRounds }, (_, i) => i + 1);

  if (sources.length === 0) {
    return (
      <section className="panel" aria-label="Round scores">
        <div className="panel-head">
          <h2>Rounds</h2>
        </div>
        <p className="empty">
          {bout.status === "upcoming"
            ? "Round-by-round scoring appears here once the fight starts."
            : "No round data from any source for this bout."}
        </p>
      </section>
    );
  }

  // Prose: the latest-round summary from any source (including summary-only
  // ones excluded from the table), preferring Sherdog's live blog.
  const proseSources = [
    "sherdog",
    ...(Object.keys(rounds) as SourceId[]).filter((s) => s !== "sherdog"),
  ] as SourceId[];
  const latest = proseSources
    .flatMap((s) => rounds[s] ?? [])
    .filter((u) => u.summary)
    .sort((a, b) => b.round - a.round)[0];

  const newestFetch = Object.values(rounds)
    .flat()
    .map((u) => u.provenance.fetchedAt)
    .sort()
    .at(-1);

  return (
    <section className="panel" aria-label="Round scores">
      <div className="panel-head">
        <h2>Rounds</h2>
        <span className="freshness">
          per-source scoring · updated between rounds
          {newestFetch && (
            <>
              {" · as of "}
              <span className="num">{fmtTime(newestFetch)}</span>
            </>
          )}
        </span>
      </div>
      <table className="rg-table">
        <thead>
          <tr>
            <th scope="col" className="rg-source-col">
              Source
            </th>
            {roundNumbers.map((n) => (
              <th scope="col" key={n} className="num">
                R{n}
              </th>
            ))}
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => {
            const updates = rounds[source] ?? [];
            const byRound = new Map(updates.map((u) => [u.round, u]));
            const scored = updates.filter((u) => u.score);
            const totals = scored.reduce(
              (acc, u) => ({
                red: acc.red + (u.score?.red ?? 0),
                blue: acc.blue + (u.score?.blue ?? 0),
              }),
              { red: 0, blue: 0 },
            );
            return (
              <tr key={source}>
                <th scope="row" className="rg-source-col">
                  {SOURCE_LABEL[source] ?? source}
                </th>
                {roundNumbers.map((n) => scoreCell(byRound.get(n), n))}
                <td className="rg-cell rg-total num">
                  {scored.length ? `${totals.red}-${totals.blue}` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {latest?.summary && (
        <blockquote className="rg-prose">
          <p>{latest.summary}</p>
          <footer>
            {SOURCE_LABEL[latest.provenance.source] ?? latest.provenance.source} · round{" "}
            {latest.round} · <span className="num">{fmtTime(latest.provenance.fetchedAt)}</span>
          </footer>
        </blockquote>
      )}
    </section>
  );
}
