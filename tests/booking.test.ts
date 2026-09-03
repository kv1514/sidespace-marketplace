import { describe, expect, it } from "vitest";
import { bookingDateLabel, calendarDayCount, proratedSubtotal, quoteBooking } from "../lib/listings/booking";
const now = new Date("2026-09-03T12:00:00Z");
const listing = { timing_kind: "date_range" as const, pricing_kind: "week" as const, price_cents: 7000, booking_timezone: "UTC", minimum_duration_days: 1 };
describe("booking timing and prices", () => {
  it("prorates the entire inclusive range once", () => {
    expect(quoteBooking(listing,"2026-09-10","2026-09-19",now)).toMatchObject({ days:10,subtotalCents:10000,buyerFeeCents:500,customerTotalCents:10500 });
    expect(proratedSubtotal(100,10,"week")).toBe(143);
    expect(proratedSubtotal(100,10,"30_days")).toBe(33);
  });
  it("supports one day and calendar boundaries without DST arithmetic", () => {
    expect(calendarDayCount("2026-03-07","2026-03-09")).toBe(3);
    expect(calendarDayCount("2028-02-28","2028-03-01")).toBe(3);
    expect(quoteBooking(listing,"2026-09-10","2026-09-10",now).subtotalCents).toBe(1000);
  });
  it("treats delivery as one deadline at a fixed total", () => {
    const result = quoteBooking({...listing,timing_kind:"deadline",pricing_kind:"fixed"},"2026-09-20",undefined,now);
    expect(result).toMatchObject({ startDate:"2026-09-20",endDate:"2026-09-20",days:1,subtotalCents:7000 });
    expect(bookingDateLabel("deadline",result.startDate,result.endDate)).toBe("Deliver by September 20, 2026");
    expect(() => quoteBooking({...listing,timing_kind:"deadline",pricing_kind:"fixed"},"2026-09-20","2026-09-21",now)).toThrow("one delivery deadline");
  });
  it("checks every selected day, minimum duration and required notice", () => {
    expect(() => quoteBooking({...listing,instant_booking_enabled:true,availability_dates:["2026-09-10","2026-09-12"]},"2026-09-10","2026-09-12",now)).toThrow("unavailable");
    expect(() => quoteBooking({...listing,minimum_duration_days:3},"2026-09-10","2026-09-11",now)).toThrow("at least 3");
    expect(() => quoteBooking({...listing,lead_time_days:4},"2026-09-05","2026-09-06",now)).toThrow("notice");
    expect(() => quoteBooking(listing,"2027-09-03","2027-09-04",now)).toThrow("next year");
  });
  it("preserves legacy fixed packages and requires fixed package duration", () => {
    expect(quoteBooking({price_cents:7000,instant_booking_enabled:false},"2026-09-10","2026-09-19",now).subtotalCents).toBe(7000);
    expect(quoteBooking({...listing,pricing_kind:"fixed",booking_duration_days:7},"2026-09-10",undefined,now)).toMatchObject({endDate:"2026-09-16",subtotalCents:7000});
    expect(() => quoteBooking({...listing,pricing_kind:"fixed",booking_duration_days:7},"2026-09-10","2026-09-19",now)).toThrow("includes 7");
  });
  it("rejects invalid input and unsafe amounts", () => {
    expect(() => calendarDayCount("2026-02-30","2026-03-01")).toThrow();
    expect(() => proratedSubtotal(Number.MAX_SAFE_INTEGER,365,"day")).toThrow();
    expect(() => quoteBooking({...listing,price_max_cents:9000},"2026-09-10","2026-09-11",now)).toThrow("custom offer");
  });
});
