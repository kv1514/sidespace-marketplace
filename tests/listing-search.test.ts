import { describe, expect, it } from "vitest";

import { compareSearchRelevance, searchRelevance } from "../lib/listings/search";

const roomWall = {
  title: "Room 114 — wall or mural in Berkeley, CA",
  channel: "Wall / mural",
  format: "One painted mural, up for a month",
  description: "A dorm wall facing the stairwell.",
  location_area: "Berkeley, CA",
  owner: { display_name: "Room 114", city: "Berkeley, CA", categories: ["student"] },
};

const instagramStory = {
  title: "Instagram story shout-out",
  channel: "Instagram",
  format: "One story frame",
  description:
    "Posted to my account. I can shoot it against the wall outside the cafe if you want a backdrop.",
  location_area: "Fullerton, CA",
  owner: { display_name: "Tharun Manigandan", city: "Fullerton, CA", categories: [] },
};

describe("what somebody typed", () => {
  it("ties everything when nothing was typed", () => {
    expect(searchRelevance(roomWall, "")).toBe(0);
    expect(searchRelevance(roomWall, "   ")).toBe(0);
    expect(compareSearchRelevance(roomWall, instagramStory, "")).toBe(0);
  });

  it("puts the listing named after the word above one that mentions it", () => {
    // The bug this was written for. Both match "wall", so both survive the
    // filter; the grid then had nothing to say about which one answered the
    // search and ordered them by freshness instead.
    expect(searchRelevance(roomWall, "wall")).toBeGreaterThan(
      searchRelevance(instagramStory, "wall"),
    );
    expect(compareSearchRelevance(roomWall, instagramStory, "wall")).toBeLessThan(0);
  });

  it("ranks an exact title above a prefix, and a prefix above a mention", () => {
    const exact = searchRelevance(instagramStory, "Instagram story shout-out");
    const prefix = searchRelevance(instagramStory, "Instagram story");
    const inside = searchRelevance(instagramStory, "shout");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(inside);
  });

  it("answers a channel name even when no title carries it", () => {
    const plainWall = { ...roomWall, title: "Space above the stairs" };
    expect(searchRelevance(plainWall, "wall / mural")).toBeGreaterThan(0);
  });

  it("does not care about case or accents", () => {
    expect(searchRelevance(roomWall, "BERKELEY")).toBe(searchRelevance(roomWall, "berkeley"));
    const sao = { ...roomWall, location_area: "São Paulo, BR" };
    expect(searchRelevance(sao, "sao paulo")).toBeGreaterThan(0);
  });

  it("rewards a listing whose title carries every word that was typed", () => {
    const both = searchRelevance(roomWall, "mural berkeley");
    const one = searchRelevance(roomWall, "mural sacramento");
    expect(both).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(0);
  });

  it("scores a listing that answers nothing at zero", () => {
    expect(searchRelevance(roomWall, "podcast")).toBe(0);
  });

  it("finds a seller by name without letting that outrank a title", () => {
    const byName = searchRelevance(instagramStory, "tharun");
    const byTitle = searchRelevance(instagramStory, "instagram story shout-out");
    expect(byName).toBeGreaterThan(0);
    expect(byTitle).toBeGreaterThan(byName);
  });

  it("survives a listing with nothing in it", () => {
    expect(searchRelevance({}, "wall")).toBe(0);
    expect(searchRelevance({ title: null, owner: null }, "wall")).toBe(0);
  });
});
