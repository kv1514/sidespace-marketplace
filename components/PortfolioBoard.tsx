"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./portfolio-board.css";
import { useLocale } from "@/app/components/LocaleProvider";
import {
  PORTFOLIO_BLOCK_SIZES,
  comparePortfolioBlocks,
  isAccent,
  isBlockSize,
  isMediaFocus,
  isPortfolioImage,
  moveItem,
  spansFor,
  type PortfolioAccent,
  type PortfolioBlockSize,
  type PortfolioMediaFocus,
} from "@/lib/portfolio-layout";

export type CreatorPortfolioItem = {
  id: string;
  creator_profile_id: string;
  title: string;
  description: string;
  kind: "video" | "project" | "campaign" | "case_study" | "other";
  media_url: string;
  project_url: string;
  /** The creator's own accounts this work ran on. See the 20260906130000 migration. */
  social_urls?: string[];
  sort_order: number;
  /** How big the block is and how it is painted. See 20260906150000. */
  block_size: PortfolioBlockSize;
  accent: PortfolioAccent;
  media_focus: PortfolioMediaFocus;
  published: boolean;
  created_at: string;
};

export type PortfolioBlockPatch = Partial<
  Pick<CreatorPortfolioItem, "block_size" | "accent" | "media_focus" | "media_url">
>;

type AccentKey = "app.paper" | "app.amber" | "app.ink" | "app.mist" | "app.haze";
type SizeKey =
  | "app.small"
  | "app.medium"
  | "app.large"
  | "app.wide"
  | "app.showcase";
type FocusKey = "app.top" | "app.middle" | "app.bottom";

const ACCENT_CHOICES: { value: PortfolioAccent; label: AccentKey }[] = [
  { value: "", label: "app.paper" },
  { value: "amber", label: "app.amber" },
  { value: "ink", label: "app.ink" },
  { value: "mist", label: "app.mist" },
  { value: "haze", label: "app.haze" },
];

const SIZE_LABELS: Record<PortfolioBlockSize, SizeKey> = {
  small: "app.small",
  medium: "app.medium",
  large: "app.large",
  wide: "app.wide",
  showcase: "app.showcase",
};

const FOCUS_CHOICES: { value: PortfolioMediaFocus; label: FocusKey }[] = [
  { value: "top", label: "app.top" },
  { value: "center", label: "app.middle" },
  { value: "bottom", label: "app.bottom" },
];

/** A rectangle in page coordinates, which survive the board scrolling under a drag. */
type PageRect = { id: string; left: number; top: number; right: number; bottom: number };

/**
 * A block that says something about the creator rather than showing a piece of
 * work: no link, no picture, no account it ran on. Somebody who filed their
 * introduction here had nowhere else to put it, and this is what lets the board
 * offer to move it where it belongs instead of leaving it looking like a
 * campaign nobody can click.
 */
function looksLikeAnIntroduction(item: CreatorPortfolioItem) {
  return (
    !item.project_url &&
    !isPortfolioImage(item.media_url) &&
    !(item.social_urls ?? []).length
  );
}

/**
 * The creator's portfolio, as blocks they arrange themselves.
 *
 * The same component draws the owner's editor and the read-only board a
 * business sees on a listing, because "what I arranged is what they see" should
 * be a property of the code and not an intention somebody has to keep.
 * `editable` and `compact` are the only two branches.
 *
 * THE ORDER DOES NOT CHANGE WHILE A BLOCK IS IN THE AIR. The lifted block is
 * translated under the pointer and the slot it would land in is outlined; the
 * arrangement is rewritten once, on release. Reflowing the board under the
 * finger looks livelier and is wrong: the lifted block's own grid cell moves
 * with the reflow, and a transform is applied on top of that cell, so the block
 * walks away from the pointer one cell at a time. Holding the layout still also
 * means the rectangles measured before the drag stay true for its whole
 * duration, which is what makes the hit test exact rather than approximate.
 */
export function PortfolioBoard({
  items,
  busy = false,
  editable = false,
  compact = false,
  owner,
  socialLabel,
  onMove,
  onStyle,
  onDelete,
  onPromoteToProfile,
  onPickImage,
}: {
  items: CreatorPortfolioItem[];
  busy?: boolean;
  /** The owner's board, with grips and controls. Off for the public render. */
  editable?: boolean;
  /** Two columns at any viewport width, for the narrow listing detail pane. */
  compact?: boolean;
  /** Drawn above the grid, and only for the owner. Never a portfolio row. */
  owner?: {
    display_name: string;
    avatar_url: string;
    bio: string;
    roleLabel: string;
  } | null;
  /** socialLabelForUrl bound to the caller's tx, so this file imports no helpers. */
  socialLabel: (url: string) => string;
  /** Commit a move. Resolves false when the write was refused, and the board reverts. */
  onMove?: (itemId: string, toIndex: number) => Promise<boolean>;
  onStyle?: (itemId: string, patch: PortfolioBlockPatch) => Promise<boolean>;
  onDelete?: (itemId: string) => void;
  onPromoteToProfile?: (item: CreatorPortfolioItem) => void;
  onPickImage?: (itemId: string, file: File) => void;
}) {
  const { t } = useLocale();
  const boardRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef(new Map<string, HTMLElement>());
  const instructionsId = useId();

  /** The board's working copy. Drags move this; the network is never on the interaction path. */
  const [order, setOrder] = useState<CreatorPortfolioItem[]>(() =>
    [...items].sort(comparePortfolioBlocks),
  );
  const [drag, setDrag] = useState<{
    id: string;
    pointerId: number;
    fromIndex: number;
    overIndex: number;
    /** Page coordinates, so the edge autoscroll cannot slide the block off the pointer. */
    grabPageX: number;
    grabPageY: number;
    dx: number;
    dy: number;
    /** The pointer's last viewport position, so the scroll loop can redo the maths. */
    clientX: number;
    clientY: number;
    active: boolean;
    /** A one-block board has nothing to rearrange, but the grip still answers a tap. */
    canReorder: boolean;
    /** What the grip's own menu was doing before the press, so a tap can toggle it. */
    menuWasOpen: boolean;
  } | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [overflowIds, setOverflowIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  /** Cell rectangles in page coordinates. Measured when the order changes, never mid-drag. */
  const rectsRef = useRef<PageRect[]>([]);
  const prevRectsRef = useRef(new Map<string, PageRect>());
  const autoScrollRef = useRef({ speed: 0, frame: 0 });
  /**
   * What actually scrolls behind the board.
   *
   * The owner's board is drawn inside the account modal, and opening a modal
   * pins the body with `position: fixed`, so window.scrollBy moves nothing and
   * window.scrollY is stuck at 0. The element that scrolls is the modal card.
   * Resolved from the DOM rather than assumed, so the same component works on
   * the public listing pane, where the window is the scroller.
   */
  const scrollerRef = useRef<HTMLElement | null>(null);
  /**
   * The pointer's last viewport position. A ref because the scroll loop runs
   * outside React and needs the live value, not the one from a closed-over
   * render.
   */
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);
  const focusAfterMoveRef = useRef<string | null>(null);
  const reducedMotionRef = useRef(false);
  /**
   * The block that was just released. It is already sitting where the finger
   * left it, so animating it from the cell it used to occupy would teleport it
   * backwards before flying it forwards.
   */
  const skipFlipRef = useRef<string | null>(null);

  /** The nearest ancestor that scrolls, or null when that is the window. */
  const findScroller = useCallback(() => {
    let node = boardRef.current?.parentElement ?? null;
    while (node && node !== document.body && node !== document.documentElement) {
      const overflow = window.getComputedStyle(node).overflowY;
      if (
        (overflow === "auto" || overflow === "scroll") &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }, []);

  /** Where the scroller has got to, in the coordinate space the rects use. */
  const scrollOffset = useCallback(() => {
    const scroller = scrollerRef.current;
    return scroller
      ? { x: scroller.scrollLeft, y: scroller.scrollTop }
      : { x: window.scrollX, y: window.scrollY };
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current.frame) {
      cancelAnimationFrame(autoScrollRef.current.frame);
    }
    autoScrollRef.current = { speed: 0, frame: 0 };
  }, []);

  const endDrag = useCallback(() => {
    stopAutoScroll();
    dragPointRef.current = null;
    setDrag(null);
  }, [stopAutoScroll]);

  /**
   * Reconcile the rows into the board's working copy.
   *
   * The local order wins for everything still present, because it is what the
   * creator is looking at; blocks that arrived are appended in their own order
   * and blocks that went are dropped. Reading the rows straight back would undo
   * a move between the optimistic update and the reload that follows it.
   */
  const arranging = Boolean(drag?.active);
  useEffect(() => {
    // Nothing rearranges the board under a finger that is already holding a
    // block. A reload landing mid-gesture would change `order`, which would
    // re-run the measuring effect below while a drag transform is applied, and
    // every rectangle it recorded would describe the pointer rather than a
    // cell. Deferred, not dropped: this re-runs when the gesture ends.
    if (arranging) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrder((current) => {
      const byId = new Map(items.map((item) => [item.id, item]));
      const kept = current
        .filter((block) => byId.has(block.id))
        .map((block) => byId.get(block.id) as CreatorPortfolioItem);
      const keptIds = new Set(kept.map((block) => block.id));
      const arrived = items
        .filter((item) => !keptIds.has(item.id))
        .sort(comparePortfolioBlocks);
      if (
        !arrived.length &&
        kept.length === current.length &&
        kept.every((block, index) => block === current[index])
      ) {
        return current;
      }
      return [...kept, ...arrived];
    });
  }, [items, arranging]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reducedMotionRef.current = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /** A drag cannot outlive the component that started it. */
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  /**
   * End a gesture the grip itself will never finish.
   *
   * A block deleted mid-drag unmounts the button holding the pointer capture,
   * so no pointerup ever reaches it. Without this the autoscroll loop would go
   * on scrolling the page after the finger had lifted.
   */
  useEffect(() => {
    if (!drag) return;
    const stop = () => endDrag();
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    document.addEventListener("visibilitychange", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.removeEventListener("visibilitychange", stop);
    };
  }, [drag, endDrag]);

  /**
   * Measure after the browser has laid the board out.
   *
   * Keyed on the order alone, so it does not run while a block is in the air:
   * no rectangle is ever recorded with a drag transform baked into it, and the
   * hit test works against true cells. Page coordinates rather than viewport
   * ones, because the autoscroll moves the document under the gesture.
   */
  /**
   * Record every cell, in the scroller's own content coordinates.
   *
   * Split out of the effect so a drag can refresh it on the way in: the effect
   * is keyed on the order, and a window resize crossing a column breakpoint
   * moves every block without changing it, which would otherwise leave the hit
   * test aiming at a four-column layout that is now two columns wide.
   */
  const measureRects = useCallback(() => {
    scrollerRef.current = findScroller();
    const { x: scrollX, y: scrollY } = scrollOffset();
    const measured: PageRect[] = [];
    blockRefs.current.forEach((element, id) => {
      const rect = element.getBoundingClientRect();
      measured.push({
        id,
        left: rect.left + scrollX,
        top: rect.top + scrollY,
        right: rect.right + scrollX,
        bottom: rect.bottom + scrollY,
      });
    });
    rectsRef.current = measured;
  }, [findScroller, scrollOffset]);

  useLayoutEffect(() => {
    scrollerRef.current = findScroller();
    const next = new Map<string, PageRect>();
    const measured: PageRect[] = [];
    const { x: scrollX, y: scrollY } = scrollOffset();
    for (const item of order) {
      const element = blockRefs.current.get(item.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const page = {
        id: item.id,
        left: rect.left + scrollX,
        top: rect.top + scrollY,
        right: rect.right + scrollX,
        bottom: rect.bottom + scrollY,
      };
      next.set(item.id, page);
      measured.push(page);

      // CSS cannot transition a grid re-placement, so the blocks that moved are
      // animated from where they were. The delta is taken in page coordinates:
      // a viewport delta would count the page scrolling as movement and animate
      // every block for a reflow that never happened.
      const before = prevRectsRef.current.get(item.id);
      if (reducedMotionRef.current || !before) continue;
      if (item.id === skipFlipRef.current) continue;
      const dx = before.left - page.left;
      const dy = before.top - page.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
    }
    skipFlipRef.current = null;
    prevRectsRef.current = next;
    rectsRef.current = measured;
  }, [order, findScroller, scrollOffset]);

  /** A block whose words are taller than the size the creator picked. */
  useLayoutEffect(() => {
    if (!editable) return;
    const over = new Set<string>();
    blockRefs.current.forEach((element, id) => {
      const body = element.querySelector(".pb-body");
      if (body && body.scrollHeight > body.clientHeight + 2) over.add(id);
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOverflowIds(over);
  }, [order, editable]);

  /**
   * Let the block menu be dismissed the way every other popover can be.
   *
   * Without this the only way out is finding the same button again, and a
   * keyboard user has no way out at all.
   */
  useEffect(() => {
    if (!openMenuId) return;
    const openId = openMenuId;
    const closeOutside = (event: PointerEvent) => {
      const block = blockRefs.current.get(openId);
      if (block && event.target instanceof Node && block.contains(event.target)) {
        return;
      }
      setOpenMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenMenuId(null);
      blockRefs.current
        .get(openId)
        ?.querySelector<HTMLElement>(".pb-menu-button")
        ?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId]);

  /** Put focus back on the block a keyboard move carried across the board. */
  useEffect(() => {
    const id = focusAfterMoveRef.current;
    if (!id) return;
    focusAfterMoveRef.current = null;
    blockRefs.current.get(id)?.querySelector<HTMLElement>(".pb-grip")?.focus();
  });

  /**
   * Which slot the pointer is over, in page coordinates.
   *
   * Containment first, because the blocks are large and the pointer is inside
   * one almost always. Nearest centre is the fallback for the gaps the packing
   * leaves and for the empty area past the last block, which lands a block at
   * the end. elementFromPoint would be wrong here: the lifted block sits under
   * the pointer and would always answer itself.
   */
  function slotAtPoint(x: number, y: number, fallback: number) {
    const rects = rectsRef.current;
    let best = fallback;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index];
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return index;
      }
      const distance =
        (x - (rect.left + rect.right) / 2) ** 2 +
        (y - (rect.top + rect.bottom) / 2) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  async function commitMove(item: CreatorPortfolioItem, from: number, to: number) {
    const previous = order;
    setOrder((current) => moveItem(current, from, to));
    focusAfterMoveRef.current = item.id;
    setAnnouncement(
      t("app.valueMovedToPositionValue2OfValue3", {
        value: item.title,
        value2: to + 1,
        value3: previous.length,
      }),
    );
    const saved = await onMove?.(item.id, to);
    if (saved === false) {
      setOrder(previous);
      setAnnouncement(t("app.yourNewOrderCouldNotBeSaved"));
    }
  }

  function handleGripPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    index: number,
  ) {
    // Armed whenever the board is the owner's, even when there is nothing to
    // rearrange: the grip is also how a block's menu is opened, and a control
    // that silently does nothing is worse than one that does less.
    if (!editable) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const item = order[index];
    if (!item) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // A resize across a column breakpoint moves every block without changing
    // the order, so the rectangles from the last reflow can be a layout old.
    measureRects();
    const offset = scrollOffset();
    dragPointRef.current = { x: event.clientX, y: event.clientY };
    setOpenMenuId(null);
    setDrag({
      id: item.id,
      pointerId: event.pointerId,
      fromIndex: index,
      overIndex: index,
      grabPageX: event.clientX + offset.x,
      grabPageY: event.clientY + offset.y,
      dx: 0,
      dy: 0,
      clientX: event.clientX,
      clientY: event.clientY,
      active: false,
      canReorder: !busy && order.length > 1,
      menuWasOpen: openMenuId === item.id,
    });
  }

  /**
   * Redo the drag from a pointer position and wherever the scroller has got to.
   *
   * Shared by the move handler and the scroll loop, because a finger held still
   * at the edge fires no pointermove: without this the block would keep its old
   * offset while the content slid past it, walking out from under the finger and
   * freezing the target on whatever slot used to be there.
   */
  const applyDragPoint = useCallback(
    (clientX: number, clientY: number) => {
      const offset = scrollOffset();
      const pageX = clientX + offset.x;
      const pageY = clientY + offset.y;
      setDrag((current) => {
        if (!current) return current;
        const dx = pageX - current.grabPageX;
        const dy = pageY - current.grabPageY;
        // Six pixels, so a tap on the grip is still a tap and a tremor never
        // rearranges somebody's portfolio.
        const started =
          current.canReorder && (current.active || Math.hypot(dx, dy) >= 6);
        if (!started) return { ...current, dx, dy, clientX, clientY };
        return {
          ...current,
          dx,
          dy,
          clientX,
          clientY,
          active: true,
          overIndex: slotAtPoint(pageX, pageY, current.overIndex),
        };
      });
    },
    // slotAtPoint reads only refs, so it does not need to be a dependency.
    [scrollOffset],
  );

  function handleGripPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const clientX = event.clientX;
    const clientY = event.clientY;
    dragPointRef.current = { x: clientX, y: clientY };
    const offset = scrollOffset();
    const dx = clientX + offset.x - drag.grabPageX;
    const dy = clientY + offset.y - drag.grabPageY;
    const started = drag.canReorder && (drag.active || Math.hypot(dx, dy) >= 6);

    applyDragPoint(clientX, clientY);

    // Only a live drag scrolls. Gated on the threshold rather than on
    // drag.active, which is a render behind: a tap on a grip near the bottom of
    // a phone screen always wobbles a pixel or two, and scrolling the block and
    // its menu off the screen is not what that tap asked for.
    if (!started) {
      autoScrollRef.current.speed = 0;
      return;
    }
    // The edge is measured against whatever is actually scrolling: the modal
    // card for the owner's board, the window on a public listing.
    const scroller = scrollerRef.current;
    const bounds = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const edge = 72;
    autoScrollRef.current.speed =
      clientY < bounds.top + edge
        ? -12
        : clientY > bounds.bottom - edge
          ? 12
          : 0;
    if (!autoScrollRef.current.frame) {
      const step = () => {
        const state = autoScrollRef.current;
        if (state.speed) {
          const target = scrollerRef.current;
          if (target) target.scrollTop += state.speed;
          else window.scrollBy(0, state.speed);
          // The content moved under a finger that did not, so the offset and
          // the target slot both have to be worked out again.
          const live = dragPointRef.current;
          if (live) applyDragPoint(live.x, live.y);
        }
        state.frame = requestAnimationFrame(step);
      };
      autoScrollRef.current.frame = requestAnimationFrame(step);
    }
  }

  function releaseGrip(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleGripPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag;
    endDrag();
    releaseGrip(event);
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active) {
      // A tap, and only a tap. Measured rather than inferred from `active`,
      // which never becomes true on a board that cannot be rearranged - a long
      // deliberate drag there would otherwise open the menu on release.
      const moved = Math.hypot(current.dx, current.dy) >= 6;
      // Toggled against what the menu was doing before the press, because
      // pointerdown has already closed it: reading the live value here would
      // always find null and a second tap could never dismiss anything.
      if (!moved) setOpenMenuId(current.menuWasOpen ? null : current.id);
      return;
    }
    // The outlined block is the one it lands in front of. Dropping onto a slot
    // after its own means everything between shifts back by one, so the index
    // it actually takes is one lower - without this the bar means "before" on
    // a backward drag and "after" on a forward one, and there is no rule a
    // creator could learn from the first drag that holds for the second.
    const to =
      current.overIndex > current.fromIndex
        ? current.overIndex - 1
        : current.overIndex;
    if (to === current.fromIndex) return;
    const item = order[current.fromIndex];
    if (!item || item.id !== current.id) return;
    // It is already where the finger left it; the reflow should move the other
    // blocks around it, not fly this one back to the cell it came from.
    skipFlipRef.current = item.id;
    void commitMove(item, current.fromIndex, to);
  }

  function handleGripPointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    endDrag();
    releaseGrip(event);
  }

  /**
   * Arrow keys move a block one slot and commit it.
   *
   * Direct moves rather than a grab-and-drop mode: a mode is a state somebody
   * can get stuck in and has to be taught, while a committed move per keypress
   * is undone by pressing the other arrow. Up and down step by one slot too,
   * because with mixed block sizes "one row up" is not a fixed number of slots,
   * and announcing a position the block did not land in is worse than a slower
   * traversal.
   */
  function handleGripKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (!editable || busy) return;
    const step =
      event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : 0;
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? order.length - 1
          : step
            ? index + step
            : -1;
    if (to < 0 || to >= order.length || to === index) return;
    event.preventDefault();
    void commitMove(order[index], index, to);
  }

  const boardClass = [
    "pb-board",
    compact ? "is-compact" : "",
    editable ? "is-editable" : "is-readonly",
    drag?.active ? "is-arranging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={boardClass} ref={boardRef}>
      {editable && owner && (
        <div className="pb-identity">
          {owner.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={owner.avatar_url} alt="" loading="lazy" decoding="async" />
          ) : null}
          <div className="pb-identity-body">
            <p className="pb-eyebrow">{t("app.yourProfile")}</p>
            <h4>{owner.display_name}</h4>
            <p>{owner.bio || owner.roleLabel}</p>
            {/* The sentence the whole card exists for. Somebody filed an
                introduction as a piece of work because the page had nowhere
                else to put one, and a card that only showed their name would
                not have told them any different. */}
            <p className="pb-identity-note">
              {t("app.thisIsHowBusinessesSeeYouIt")}
            </p>
            <p>
              <a href="#profile">{t("app.editYourProfile")}</a>
            </p>
          </div>
        </div>
      )}

      {editable && (
        <p className="sr-only" id={instructionsId}>
          {t("app.dragABlockToMoveItOr")}
        </p>
      )}

      {order.length > 0 ? (
        <div className="pb-grid">
          {order.map((item, index) => {
            const spans = spansFor(item.block_size);
            const hasMedia = isPortfolioImage(item.media_url);
            const isDragging = Boolean(drag?.active) && drag?.id === item.id;
            // Where it would land. Only ever drawn on a block that is not the
            // one in the air, so a drag that has not left its own slot is quiet.
            const isTarget =
              Boolean(drag?.active) &&
              drag?.overIndex === index &&
              drag?.id !== item.id;
            const blockClass = [
              "pb-block",
              hasMedia ? "has-media" : "",
              isDragging ? "is-dragging" : "",
              isTarget ? "is-target" : "",
              openMenuId === item.id ? "is-open" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <article
                className={blockClass}
                data-accent={item.accent || undefined}
                data-focus={item.media_focus}
                data-size={item.block_size}
                key={item.id}
                ref={(element) => {
                  if (element) blockRefs.current.set(item.id, element);
                  else blockRefs.current.delete(item.id);
                }}
                style={
                  {
                    "--pb-w": spans.columns,
                    "--pb-w2": spans.columns2,
                    "--pb-h": spans.rows,
                    "--pb-dx": isDragging ? `${drag?.dx ?? 0}px` : "0px",
                    "--pb-dy": isDragging ? `${drag?.dy ?? 0}px` : "0px",
                  } as CSSProperties
                }
              >
                {hasMedia && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={t("app.coverImageForValue", { value: item.title })}
                    className="pb-media"
                    decoding="async"
                    loading="lazy"
                    src={item.media_url}
                  />
                )}

                {editable && (
                  <button
                    aria-describedby={instructionsId}
                    aria-label={t("app.moveValue", { value: item.title })}
                    className="pb-grip"
                    onKeyDown={(event) => handleGripKeyDown(event, index)}
                    onPointerCancel={handleGripPointerCancel}
                    onPointerDown={(event) => handleGripPointerDown(event, index)}
                    onPointerMove={handleGripPointerMove}
                    onPointerUp={handleGripPointerUp}
                    type="button"
                  >
                    ⠿
                  </button>
                )}

                {editable && (
                  <button
                    aria-expanded={openMenuId === item.id}
                    aria-haspopup="true"
                    aria-label={t("app.blockOptionsForValue", { value: item.title })}
                    className="pb-menu-button"
                    onClick={() =>
                      setOpenMenuId((id) => (id === item.id ? null : item.id))
                    }
                    type="button"
                  >
                    ⋯
                  </button>
                )}

                <div className="pb-body">
                  <span className="pb-kind">{item.kind.replaceAll("_", " ")}</span>
                  <h4 className="pb-title">{item.title}</h4>
                  {item.description && <p className="pb-note">{item.description}</p>}
                  <div className="pb-links">
                    {item.project_url && (
                      <a href={item.project_url} rel="noreferrer" target="_blank">
                        {t("app.viewWork")}
                      </a>
                    )}
                    {(item.social_urls ?? [])
                      // The column already refuses anything but https, and this
                      // refuses it again: an href is one of the few places a bad
                      // string from the database becomes something the browser
                      // acts on, and the check costs nothing.
                      .filter((url) => /^https:\/\//i.test(url))
                      .map((url) => (
                        <a
                          className="portfolio-social-ref"
                          href={url}
                          key={url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {socialLabel(url)}
                        </a>
                      ))}
                  </div>
                </div>

                {editable && overflowIds.has(item.id) && (
                  <small className="pb-overflow">
                    {t("app.thatTextIsLongerThanThis")}
                  </small>
                )}

                {editable && openMenuId === item.id && (
                  <div className="pb-menu">
                    <label>
                      {t("app.blockSize")}
                      <select
                        onChange={(event) =>
                          void onStyle?.(item.id, {
                            block_size: event.currentTarget
                              .value as PortfolioBlockSize,
                          })
                        }
                        value={isBlockSize(item.block_size) ? item.block_size : "medium"}
                      >
                        {PORTFOLIO_BLOCK_SIZES.map((entry) => (
                          <option key={entry.size} value={entry.size}>
                            {t(SIZE_LABELS[entry.size])}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      {t("app.accent")}
                      <select
                        onChange={(event) =>
                          void onStyle?.(item.id, {
                            accent: event.currentTarget.value as PortfolioAccent,
                          })
                        }
                        value={isAccent(item.accent) ? item.accent : ""}
                      >
                        {ACCENT_CHOICES.map((choice) => (
                          <option key={choice.label} value={choice.value}>
                            {t(choice.label)}
                          </option>
                        ))}
                      </select>
                    </label>

                    {hasMedia && (
                      <label>
                        {t("app.crop")}
                        <select
                          onChange={(event) =>
                            void onStyle?.(item.id, {
                              media_focus: event.currentTarget
                                .value as PortfolioMediaFocus,
                            })
                          }
                          value={isMediaFocus(item.media_focus) ? item.media_focus : "center"}
                        >
                          {FOCUS_CHOICES.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {t(choice.label)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <div className="pb-menu-actions">
                      <label>
                        {hasMedia ? t("app.replaceImage") : t("app.coverImage")}
                        <input
                          accept="image/jpeg,image/png,image/webp"
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = "";
                            if (file) onPickImage?.(item.id, file);
                          }}
                          type="file"
                        />
                      </label>
                      {hasMedia && (
                        <button
                          disabled={busy}
                          onClick={() => void onStyle?.(item.id, { media_url: "" })}
                          type="button"
                        >
                          {t("app.removeImage")}
                        </button>
                      )}
                      {looksLikeAnIntroduction(item) && onPromoteToProfile && (
                        <>
                          <small className="pb-hint">
                            {t("app.thisLooksLikeAnIntroductionNot")}
                          </small>
                          <button
                            disabled={busy}
                            onClick={() => onPromoteToProfile(item)}
                            type="button"
                          >
                            {t("app.moveItToYourProfile")}
                          </button>
                        </>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => onDelete?.(item.id)}
                        type="button"
                      >
                        {t("app.remove")}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        editable && (
          <p className="pb-empty">{t("app.nothingOnYourBoardYetPublishYour")}</p>
        )
      )}

      {editable && (
        <p aria-live="polite" className="sr-only" role="status">
          {announcement}
        </p>
      )}
    </div>
  );
}
