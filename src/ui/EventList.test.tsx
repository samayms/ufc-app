import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EventList,
  groupEventListEntries,
  type EventListEntry,
} from "./EventList.tsx";

const mixedEvents: EventListEntry[] = [
  { id: "past-old", name: "Past Old", startsAt: "2026-07-01T00:00:00Z", isComplete: true },
  { id: "future-late", name: "Future Late", startsAt: "2026-09-01T00:00:00Z" },
  { id: "past-new", name: "Past New", startsAt: "2026-08-01T00:00:00Z", isComplete: true },
  { id: "future-near", name: "Future Near", startsAt: "2026-08-08T00:00:00Z" },
];

describe("EventList", () => {
  it("groups upcoming before past and orders each group for browsing", () => {
    const grouped = groupEventListEntries(mixedEvents);

    expect(grouped.upcoming.map((event) => event.id)).toEqual([
      "future-near",
      "future-late",
    ]);
    expect(grouped.past.map((event) => event.id)).toEqual([
      "past-new",
      "past-old",
    ]);
  });

  it("renders current, upcoming, and past as separate ordered sections", () => {
    const html = renderToStaticMarkup(
      <EventList
        currentEvent={{
          id: "current",
          name: "Current Event",
          startsAt: "2026-08-02T00:00:00Z",
          isLive: true,
        }}
        events={mixedEvents}
        selectedId=""
        onSelect={() => {}}
      />,
    );

    const currentHeading = html.indexOf("Current event");
    const upcomingHeading = html.indexOf("Upcoming events");
    const pastHeading = html.indexOf("Past events");
    expect(currentHeading).toBeGreaterThanOrEqual(0);
    expect(upcomingHeading).toBeGreaterThan(currentHeading);
    expect(pastHeading).toBeGreaterThan(upcomingHeading);
    expect(html.indexOf("Future Near")).toBeLessThan(html.indexOf("Future Late"));
    expect(html.indexOf("Past New")).toBeLessThan(html.indexOf("Past Old"));
  });
});
