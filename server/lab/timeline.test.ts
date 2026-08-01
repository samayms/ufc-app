import { describe, expect, it, vi } from "vitest";
import { LabTimeline, type TimelineInput } from "./timeline.ts";

const BASE_TIME = Date.parse("2026-07-30T20:00:00.000Z");

class ManualClock {
  value = BASE_TIME;

  now = (): number => this.value;
}

function marker(values: Partial<TimelineInput> = {}): TimelineInput {
  return {
    kind: "marker",
    source: "user",
    label: "round 2 ended (broadcast)",
    boutId: "bout-x",
    round: 2,
    ...values,
  };
}

function observation(values: Partial<TimelineInput> = {}): TimelineInput {
  return {
    kind: "observation",
    source: "cito",
    label: "Cito published round 2",
    boutId: "bout-x",
    round: 2,
    ...values,
  };
}

describe("LabTimeline deltas", () => {
  it("measures from the latest marker for the same bout and round", () => {
    const clock = new ManualClock();
    const timeline = new LabTimeline({ now: clock.now });
    timeline.record(marker());
    clock.value += 47_200;

    const entry = timeline.record(observation());

    expect(entry.deltaMs).toBe(47_200);
    expect(entry.deltaFrom).toBe("round 2 ended (broadcast)");
  });

  it("uses a same-round marker when the observation has no bout id", () => {
    const clock = new ManualClock();
    const timeline = new LabTimeline({ now: clock.now });
    timeline.record(marker());
    clock.value += 8_125;

    const entry = timeline.record(
      observation({ boutId: undefined, source: "espn" }),
    );

    expect(entry.deltaMs).toBe(8_125);
    expect(entry.deltaFrom).toBe("round 2 ended (broadcast)");
  });

  it("does not match another bout merely because its round matches", () => {
    const clock = new ManualClock();
    const timeline = new LabTimeline({ now: clock.now });
    timeline.record(marker({ boutId: "bout-x" }));
    clock.value += 4_000;

    const entry = timeline.record(observation({ boutId: "bout-y" }));

    expect(entry).not.toHaveProperty("deltaMs");
    expect(entry).not.toHaveProperty("deltaFrom");
  });

  it("omits delta fields when no marker matches", () => {
    const timeline = new LabTimeline({ now: () => BASE_TIME });

    const entry = timeline.record(observation({ round: 3 }));

    expect(entry).not.toHaveProperty("deltaMs");
    expect(entry).not.toHaveProperty("deltaFrom");
  });

  it("lets a newer marker supersede an older one for the same bout and round", () => {
    const clock = new ManualClock();
    const timeline = new LabTimeline({ now: clock.now });
    timeline.record(marker({ label: "first horn" }));
    clock.value += 30_000;
    timeline.record(marker({ label: "corrected horn" }));
    clock.value += 2_750;

    const entry = timeline.record(observation());

    expect(entry.deltaMs).toBe(2_750);
    expect(entry.deltaFrom).toBe("corrected horn");
  });

  it("preserves a negative delta", () => {
    const timeline = new LabTimeline({ now: () => BASE_TIME });
    timeline.record(marker());

    const entry = timeline.record(
      observation({
        at: new Date(BASE_TIME - 1_800).toISOString(),
      }),
    );

    expect(entry.deltaMs).toBe(-1_800);
    expect(entry.deltaFrom).toBe("round 2 ended (broadcast)");
  });
});

describe("LabTimeline ordering and retention", () => {
  it("keeps sequence numbers monotonic across ring-buffer eviction", () => {
    const timeline = new LabTimeline({
      now: () => BASE_TIME,
      maxEntries: 2,
    });
    expect(timeline.record(observation({ label: "one" })).seq).toBe(1);
    expect(timeline.record(observation({ label: "two" })).seq).toBe(2);
    expect(timeline.record(observation({ label: "three" })).seq).toBe(3);

    expect(timeline.size).toBe(2);
    expect(timeline.latestSeq).toBe(3);
    expect(timeline.since(0).map(({ seq }) => seq)).toEqual([2, 3]);
    expect(timeline.since(1).map(({ seq }) => seq)).toEqual([2, 3]);
    expect(timeline.since(2).map(({ seq }) => seq)).toEqual([3]);
    expect(timeline.since(3)).toEqual([]);
  });

  it("uses caller timestamps for deltas without reordering insertion sequence", () => {
    const clock = new ManualClock();
    const timeline = new LabTimeline({ now: clock.now });
    timeline.record(marker());
    const later = timeline.record(
      observation({
        label: "observed later",
        at: new Date(BASE_TIME + 3_000).toISOString(),
      }),
    );
    const earlier = timeline.record(
      observation({
        label: "recorded late",
        at: new Date(BASE_TIME + 1_000).toISOString(),
      }),
    );

    expect(later.seq).toBe(2);
    expect(later.deltaMs).toBe(3_000);
    expect(earlier.seq).toBe(3);
    expect(earlier.deltaMs).toBe(1_000);
    expect(timeline.since(1).map(({ label }) => label)).toEqual([
      "observed later",
      "recorded late",
    ]);
  });

  it("continues matching against a marker after the ring evicts it", () => {
    const clock = new ManualClock();
    const timeline = new LabTimeline({ now: clock.now, maxEntries: 1 });
    timeline.record(marker());
    clock.value += 5_000;

    const entry = timeline.record(observation());

    expect(timeline.size).toBe(1);
    expect(entry.deltaMs).toBe(5_000);
  });
});

describe("LabTimeline persistence", () => {
  it("writes the exact stored entry as one JSONL line", () => {
    const lines: string[] = [];
    const timeline = new LabTimeline({
      now: () => BASE_TIME,
      appendFile: (line) => lines.push(line),
    });

    const entry = timeline.record(observation());

    expect(lines).toEqual([`${JSON.stringify(entry)}\n`]);
  });

  it("keeps the entry and adds one note when persistence throws", () => {
    const appendFile = vi.fn(() => {
      throw new Error("disk full");
    });
    const timeline = new LabTimeline({
      now: () => BASE_TIME,
      appendFile,
    });

    const entry = timeline.record(observation());

    expect(entry.seq).toBe(1);
    expect(timeline.latestSeq).toBe(2);
    expect(timeline.size).toBe(2);
    expect(timeline.since(0)).toEqual([
      entry,
      {
        seq: 2,
        at: "2026-07-30T20:00:00.000Z",
        kind: "note",
        source: "timeline",
        label: "timeline persistence failed",
        detail: { error: "disk full" },
      },
    ]);
    expect(appendFile).toHaveBeenCalledTimes(2);
  });
});
