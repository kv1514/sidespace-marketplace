import { describe, expect, it } from "vitest";
import { addCalendarDays, availableStartDates, calendarToday, validCalendarDay } from "../lib/listings/availability";

describe("listing calendar boundaries", () => {
  it("uses the seller's date around midnight and daylight saving", () => {
    const now = new Date("2026-09-03T01:00:00Z");
    expect(calendarToday("America/Los_Angeles", now)).toBe("2026-09-02");
    expect(calendarToday("Asia/Tokyo", now)).toBe("2026-09-03");
    expect(addCalendarDays("2026-03-08", 1)).toBe("2026-03-09");
  });
  it("rejects normalized invalid dates", () => {
    expect(validCalendarDay("2026-02-30")).toBe(false);
    expect(validCalendarDay("2028-02-29")).toBe(true);
    expect(validCalendarDay("tomorrow")).toBe(false);
  });
  it("requires the entire package, respects notice, and caps its end date", () => {
    expect(availableStartDates({ booking_timezone: "UTC", booking_duration_days: 2, lead_time_days: 2,
      availability_dates: ["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-08", "2027-09-03", "2027-09-04"]
    }, new Date("2026-09-03T12:00:00Z"))).toEqual(["2026-09-05"]);
  });
});
