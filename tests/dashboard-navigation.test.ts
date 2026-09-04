import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The dashboard stat tiles are the page's navigation now: each one scrolls to
// a section or opens the inbox. Two things can break that silently, and
// neither shows up as a failing render or a type error.
//
//   1. A section id gets renamed and the tile scrolls nowhere. `getElementById`
//      returns null, `goToDashboardSection` returns early, and the click just
//      does nothing.
//   2. The jump offset drifts below the sticky header height, so the section
//      you land on sits underneath the header. That is the state this replaced:
//      a hardcoded 28px against a 76px header.
const root = join(import.meta.dirname, "..");
const app = readFileSync(join(root, "app/MarketplaceApp.tsx"), "utf8");
const globals = readFileSync(join(root, "app/globals.css"), "utf8");
const publicSite = readFileSync(join(root, "app/public-site.css"), "utf8");

describe("dashboard tile navigation", () => {
  it("scrolls only to section ids that exist", () => {
    const jumped = [...app.matchAll(/goToDashboardSection\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(jumped.length).toBeGreaterThan(0);
    for (const id of jumped) {
      expect(app, `no element carries id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it("leaves the keyboard on the section it scrolled to", () => {
    // scrollIntoView moves the viewport but not focus. Without tabIndex={-1}
    // the section cannot take focus at all, so the next Tab would continue
    // from the tile the user just left, several screens up the page.
    const jumped = new Set(
      [...app.matchAll(/goToDashboardSection\("([^"]+)"\)/g)].map((m) => m[1]),
    );
    for (const id of jumped) {
      const section = app.slice(
        Math.max(0, app.indexOf(`id="${id}"`) - 400),
        app.indexOf(`id="${id}"`) + 200,
      );
      expect(section, `${id} is not focusable`).toContain("tabIndex={-1}");
    }
    expect(app).toContain("focus({ preventScroll: true })");
  });

  it("honours prefers-reduced-motion when it jumps", () => {
    const fn = app.slice(
      app.indexOf("function goToDashboardSection"),
      app.indexOf("function goToDashboardSection") + 700,
    );
    expect(fn).toContain("prefers-reduced-motion");
    expect(fn).toContain('"auto"');
  });

  it("offsets the jump by the real header height rather than a fixed guess", () => {
    const rule = globals.slice(
      globals.indexOf(".dashboard-work-section {"),
      globals.indexOf(".dashboard-work-section {") + 400,
    );
    // Tying the offset to the variable is what keeps it correct when the
    // header shrinks to 67px on narrow screens.
    expect(rule).toMatch(/scroll-margin-top:[\s\S]*--ss-header-height/);
    expect(publicSite).toContain("--ss-header-height");
  });
});
