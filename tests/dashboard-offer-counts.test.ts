import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The stat tiles promise that the number you click is the number you land on.
// They counted only open work ("2 waiting on your reply") while the section
// they navigate to filtered by side alone, so a member with two open offers
// and fifteen finished bookings clicked "2" and arrived at a list of
// seventeen. Nothing failed, nothing logged - the feature just quietly did not
// do the thing it exists to do.
//
// The fix is one shared status list and one shared predicate. These assert
// that, because a second inline ["pending", "countered"] anywhere in the
// dashboard is exactly how the two sides drift apart again.
const app = readFileSync(
  join(import.meta.dirname, "..", "app/MarketplaceApp.tsx"),
  "utf8",
);

const dashboard = app.slice(
  app.indexOf("function renderDashboardCampaigns"),
  app.indexOf("function renderDashboardPayments"),
);

describe("offer tiles and the section they navigate to", () => {
  it("share one definition of which offers are still open", () => {
    expect(app).toContain("const OPEN_REQUEST_STATUSES");
    // Two or more independent status lists is the drift this prevents.
    const inlineLists = app.match(
      /\[\s*"pending",\s*"countered"\s*\]|\[\s*"countered",\s*"pending"\s*\]/g,
    );
    // Exactly one: the constant's own declaration. Any second copy is a
    // second source of truth, which is how the tile and the list drifted
    // apart in the first place.
    expect(inlineLists, "status list should be declared once, as a constant")
      .toHaveLength(1);
  });

  it("filters the list through the same predicate that counts the chips", () => {
    // sideCount and visibleRequests must both go through `matches`, or the
    // chip can read 2 above a list of 17.
    expect(dashboard).toMatch(
      /sideCount\s*=\s*\([\s\S]{0,120}?matches\(request,\s*key\)/,
    );
    expect(dashboard).toMatch(
      /visibleRequests\s*=[\s\S]{0,120}?matches\(request,\s*campaignSide\)/,
    );
  });

  it("narrows to open work when a tile navigates, and says so on screen", () => {
    // Both offer tiles set it. Matched on live lines only - a commented-out
    // call still contains the string, which is how this assertion first
    // failed to notice its own mutation.
    const live = app
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const tileSets = live.match(/setCampaignOpenOnly\(true\)/g) ?? [];
    expect(tileSets.length).toBe(2);
    // ...the member can clear it...
    expect(app).toContain("setCampaignOpenOnly(false)");
    // ...and it is visible while it is on. A filter nobody can see reads as
    // missing data.
    expect(app).toContain("filter-pill");
    expect(app).toContain("Open only");
  });

  it("keeps the offers filter announced as a single choice, not three toggles", () => {
    expect(dashboard).toContain('role="radiogroup"');
    expect(dashboard).toContain('role="radio"');
    expect(dashboard).toContain("aria-checked");
    // aria-pressed would say "three independent toggles" to a screen reader.
    expect(dashboard).not.toContain("aria-pressed");
  });

  it("does not report a business brief as unfinished", () => {
    // listingGaps measures `format`, which the brief form derives rather than
    // asks for - so a brief could be called unfinished with nothing the member
    // could do about it.
    const status = app.slice(
      app.indexOf("function dashboardStatus"),
      app.indexOf("function renderDashboardListings"),
    );
    expect(status).toContain('listing.channel !== "Business brief"');
  });
});
