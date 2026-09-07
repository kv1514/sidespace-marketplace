/**
 * The shapes a portfolio board is arranged from.
 *
 * Kept out of the component so vitest - the repository's only automated gate -
 * can cover it directly. Nothing in here touches the DOM, the network or the
 * clock, and nothing in here is a sentence: the i18n checker reads lib/, and
 * every word a creator sees comes from a message table instead.
 */

/** As many pieces as one board can hold before it stops being a portfolio. */
export const MAX_PORTFOLIO_BLOCKS = 40;

/**
 * How many rows either loader will read.
 *
 * Neither query had a limit, and nothing at the database level caps rows per
 * creator, so a member who wrote to PostgREST directly could make every
 * visitor to their listing download an unbounded board. Above
 * MAX_PORTFOLIO_BLOCKS so a portfolio filled through the product never hits it.
 */
export const PORTFOLIO_READ_LIMIT = 60;

export type PortfolioBlockSize =
  | "small"
  | "medium"
  | "large"
  | "wide"
  | "showcase";

export type PortfolioAccent = "" | "amber" | "ink" | "mist" | "haze";

export type PortfolioMediaFocus = "center" | "top" | "bottom";

/**
 * The five shapes, and the spans each takes at four columns and at two.
 *
 * `columns2` is not `Math.min(columns, 2)` by accident: a block the creator
 * made the full width of the board should still be the full width of the board
 * when the board is two columns wide. Collapsing it to half would silently
 * demote the one block they said was the important one.
 */
export const PORTFOLIO_BLOCK_SIZES: {
  size: PortfolioBlockSize;
  columns: number;
  columns2: number;
  rows: number;
}[] = [
  { size: "small", columns: 1, columns2: 1, rows: 1 },
  { size: "medium", columns: 2, columns2: 2, rows: 1 },
  { size: "large", columns: 2, columns2: 2, rows: 2 },
  { size: "wide", columns: 4, columns2: 2, rows: 1 },
  { size: "showcase", columns: 4, columns2: 2, rows: 2 },
];

const SIZES = new Map(PORTFOLIO_BLOCK_SIZES.map((entry) => [entry.size, entry]));

const ACCENTS: PortfolioAccent[] = ["", "amber", "ink", "mist", "haze"];

const MEDIA_FOCUSES: PortfolioMediaFocus[] = ["center", "top", "bottom"];

/**
 * The spans a row asks for, clamped at the render boundary.
 *
 * Grants on creator_portfolio_items are table-wide, so an authenticated
 * creator can put whatever they like in their own block_size through the REST
 * API. The CHECK constraint catches it, but a stale bundle or a later
 * migration could still hand this a name it does not know, and a board that
 * cannot be drawn is a worse outcome than a block that is the wrong size.
 */
export function spansFor(size: string | null | undefined) {
  return SIZES.get((size ?? "") as PortfolioBlockSize) ?? SIZES.get("medium")!;
}

export function isBlockSize(value: unknown): value is PortfolioBlockSize {
  return typeof value === "string" && SIZES.has(value as PortfolioBlockSize);
}

export function isAccent(value: unknown): value is PortfolioAccent {
  return (
    typeof value === "string" && ACCENTS.includes(value as PortfolioAccent)
  );
}

export function isMediaFocus(value: unknown): value is PortfolioMediaFocus {
  return (
    typeof value === "string" &&
    MEDIA_FOCUSES.includes(value as PortfolioMediaFocus)
  );
}

/**
 * Order two blocks.
 *
 * sort_order first, then the newest of a tie, then id. The first two reproduce
 * exactly what both loaders have always asked the server for, so nothing moves
 * for anybody on the deploy that introduces this. id is the backstop: the
 * 20260906150000 migration dissolves the duplicate positions that the old
 * `sort_order: creatorPortfolio.length` insert produced, but a board read while
 * two tabs are writing can still show a tie, and an order that depends on which
 * row was read first is an order that changes when nobody touched it.
 */
export function comparePortfolioBlocks(
  a: { sort_order: number; created_at: string; id: string },
  b: { sort_order: number; created_at: string; id: string },
) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Move one entry of an array, returning a new array. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/**
 * Whether a URL is safe to put in an <img src> on a public profile.
 *
 * The column already refuses anything but https, and this refuses it again: a
 * src is one of the few places where a string from the database becomes
 * something the browser goes and acts on. The extension test is what keeps an
 * older row whose media_url is a link rather than a picture from drawing the
 * browser's torn-page icon on somebody's portfolio.
 */
export function isPortfolioImage(url: string | null | undefined): boolean {
  const value = url ?? "";
  return (
    /^https:\/\//i.test(value) &&
    /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.test(value)
  );
}
