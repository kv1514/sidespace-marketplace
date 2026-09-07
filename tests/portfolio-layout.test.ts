import { describe, expect, it } from "vitest";

import {
  MAX_PORTFOLIO_BLOCKS,
  PORTFOLIO_BLOCK_SIZES,
  PORTFOLIO_READ_LIMIT,
  comparePortfolioBlocks,
  isAccent,
  isBlockSize,
  isMediaFocus,
  isPortfolioImage,
  moveItem,
  spansFor,
} from "../lib/portfolio-layout";

const block = (
  id: string,
  sort_order: number,
  created_at = "2026-09-01T00:00:00Z",
) => ({ id, sort_order, created_at });

describe("portfolio block shapes", () => {
  it("keeps a full-width block full-width when the board narrows", () => {
    for (const entry of PORTFOLIO_BLOCK_SIZES) {
      expect(entry.columns2).toBeLessThanOrEqual(2);
      // A block the creator widened to the whole board stays the whole board.
      if (entry.columns === 4) expect(entry.columns2).toBe(2);
    }
  });

  it("never spans more columns than the board has", () => {
    for (const entry of PORTFOLIO_BLOCK_SIZES) {
      expect(entry.columns).toBeGreaterThanOrEqual(1);
      expect(entry.columns).toBeLessThanOrEqual(4);
      expect(entry.rows).toBeGreaterThanOrEqual(1);
      expect(entry.rows).toBeLessThanOrEqual(2);
    }
  });

  it("falls back to medium rather than refusing to draw a block", () => {
    expect(spansFor("large").rows).toBe(2);
    expect(spansFor("enormous")).toEqual(spansFor("medium"));
    expect(spansFor("")).toEqual(spansFor("medium"));
    expect(spansFor(null)).toEqual(spansFor("medium"));
    expect(spansFor(undefined)).toEqual(spansFor("medium"));
  });

  it("recognises exactly the values the CHECK constraints allow", () => {
    expect(PORTFOLIO_BLOCK_SIZES.every((entry) => isBlockSize(entry.size))).toBe(
      true,
    );
    expect(isBlockSize("huge")).toBe(false);
    expect(isBlockSize(2)).toBe(false);

    for (const accent of ["", "amber", "ink", "mist", "haze"]) {
      expect(isAccent(accent)).toBe(true);
    }
    expect(isAccent("neon")).toBe(false);

    for (const focus of ["center", "top", "bottom"]) {
      expect(isMediaFocus(focus)).toBe(true);
    }
    expect(isMediaFocus("left")).toBe(false);
  });

  it("reads more rows than the composer will ever write", () => {
    expect(PORTFOLIO_READ_LIMIT).toBeGreaterThan(MAX_PORTFOLIO_BLOCKS);
  });
});

describe("portfolio block ordering", () => {
  it("orders by position, then the newest of a tie, then id", () => {
    const rows = [
      block("c", 1, "2026-01-01T00:00:00Z"),
      block("a", 0),
      block("b", 1, "2026-06-01T00:00:00Z"),
    ];
    expect([...rows].sort(comparePortfolioBlocks).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("reproduces what both loaders ask the server for", () => {
    // sort_order ascending, created_at descending - the order every existing
    // portfolio is already displayed in, so nothing moves on deploy.
    const rows = [
      block("old", 0, "2026-01-01T00:00:00Z"),
      block("new", 0, "2026-08-01T00:00:00Z"),
    ];
    expect([...rows].sort(comparePortfolioBlocks).map((row) => row.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("is total, so an order never depends on which row was read first", () => {
    const same = "2026-09-01T00:00:00Z";
    const rows = [block("b", 3, same), block("a", 3, same)];
    expect(comparePortfolioBlocks(rows[0], rows[1])).toBeGreaterThan(0);
    expect(comparePortfolioBlocks(rows[1], rows[0])).toBeLessThan(0);
    expect(comparePortfolioBlocks(rows[0], rows[0])).toBe(0);
  });
});

describe("moving a block", () => {
  const items = ["a", "b", "c", "d"];

  it("moves an entry without disturbing the rest", () => {
    expect(moveItem(items, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(items, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(items, 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("never mutates the array it was given", () => {
    const before = [...items];
    moveItem(items, 0, 2);
    expect(items).toEqual(before);
  });

  it("returns the same array when there is nothing to do", () => {
    expect(moveItem(items, 2, 2)).toBe(items);
    expect(moveItem(items, -1, 2)).toBe(items);
    expect(moveItem(items, 9, 2)).toBe(items);
  });

  it("clamps a destination past the end rather than dropping the block", () => {
    expect(moveItem(items, 0, 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(items, 2, -5)).toEqual(["c", "a", "b", "d"]);
  });

  it("keeps every block, whatever the move", () => {
    for (let from = 0; from < items.length; from += 1) {
      for (let to = 0; to < items.length; to += 1) {
        expect([...moveItem(items, from, to)].sort()).toEqual([...items].sort());
      }
    }
  });
});

describe("what may be drawn as a picture", () => {
  it("accepts an https image", () => {
    expect(isPortfolioImage("https://cdn.example.com/a.jpg")).toBe(true);
    expect(isPortfolioImage("https://cdn.example.com/a.PNG")).toBe(true);
    expect(isPortfolioImage("https://cdn.example.com/a.webp?width=800")).toBe(
      true,
    );
    expect(isPortfolioImage("https://cdn.example.com/a.avif#top")).toBe(true);
  });

  it("refuses anything the browser would go and act on", () => {
    expect(isPortfolioImage("http://cdn.example.com/a.jpg")).toBe(false);
    expect(isPortfolioImage("javascript:alert(1)//a.jpg")).toBe(false);
    expect(isPortfolioImage("data:image/png;base64,AAAA")).toBe(false);
    expect(isPortfolioImage("//cdn.example.com/a.jpg")).toBe(false);
  });

  it("degrades a link that is not a picture to a plain block", () => {
    expect(isPortfolioImage("https://example.com/case-study")).toBe(false);
    expect(isPortfolioImage("")).toBe(false);
    expect(isPortfolioImage(null)).toBe(false);
    expect(isPortfolioImage(undefined)).toBe(false);
  });
});
