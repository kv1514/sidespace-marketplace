import type { AffinityEvent, InteractionKind } from "./recommend";

/**
 * The browser half of the analytics spine.
 *
 * Two jobs that look like one and are not:
 *
 *   1. Send impressions and clicks to the server, so an owner can see how many
 *      people met their listing. Aggregate, never per-person.
 *   2. Keep a short private log of what THIS browser looked at, so the "For
 *      you" row can be personal without anyone's browsing history having to be
 *      read back out of the database to do it.
 *
 * The second one is why the affinity log lives in localStorage rather than
 * being queried per page load. It works signed out, it costs no round trip, and
 * the taste profile never leaves the device. Likes and offers are recorded here
 * too even though they are never POSTed - the server already has those in
 * `listing_likes` and `campaign_requests`, and duplicating them would put the
 * same fact in two places.
 *
 * Every storage call is wrapped: Safari in private mode throws on
 * localStorage, and a member browsing listings must never be shown an error
 * because a measurement failed.
 */

const VISITOR_STORAGE_KEY = "sidespace.visitor";
const AFFINITY_STORAGE_KEY = "sidespace.affinity";
const ENDPOINT = "/api/listings/events";

/** Enough history to be personal, little enough to stay small and current. */
const MAX_AFFINITY_EVENTS = 200;
const AFFINITY_MAX_AGE_MS = 60 * 86_400_000;

/** Kinds the server records. Likes and offers it already knows about. */
type ServerEventKind = "impression" | "click";

type QueuedEvent = { listingId: string; kind: ServerEventKind };

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode, or storage full. Measurement is not worth an exception.
  }
}

/**
 * A random id for this browser, created once.
 *
 * It is not an identity. It exists so the same person scrolling past a card
 * twice counts once, and so two listings the same person looked at can be
 * paired later. Nothing about who they are is stored with it.
 */
export function visitorKey() {
  if (typeof window === "undefined") return "";
  const existing = readStorage(VISITOR_STORAGE_KEY);
  if (existing) return existing;
  const created =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `v-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  writeStorage(VISITOR_STORAGE_KEY, created);
  return created;
}

const pending = new Map<string, QueuedEvent>();
let flushTimer: number | null = null;
let listenersBound = false;

function sendNow() {
  if (typeof window === "undefined" || !pending.size) return;
  const events = [...pending.values()];
  pending.clear();
  const key = visitorKey();
  if (!key) return;
  const payload = JSON.stringify({ visitorKey: key, events });
  try {
    // A beacon survives the page going away, which is exactly when the last
    // impressions of a session are worth keeping.
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Dropped. The next impression will carry the next batch.
  }
}

function bindListeners() {
  if (listenersBound || typeof document === "undefined") return;
  listenersBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendNow();
  });
  window.addEventListener("pagehide", sendNow);
}

function enqueue(listingId: string, kind: ServerEventKind) {
  if (typeof window === "undefined" || !listingId) return;
  bindListeners();
  pending.set(`${listingId}:${kind}`, { listingId, kind });
  if (flushTimer !== null) return;
  // Batched, so a fast scroll past twenty cards is one request, not twenty.
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    sendNow();
  }, 4000);
}

function readAffinity(): AffinityEvent[] {
  if (typeof window === "undefined") return [];
  const raw = readStorage(AFFINITY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is AffinityEvent =>
        Boolean(entry) &&
        typeof entry.listingId === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.at === "number",
    );
  } catch {
    return [];
  }
}

/** This browser's own history, pruned. Safe to call during render. */
export function affinityEvents(nowMs = Date.now()): AffinityEvent[] {
  return readAffinity().filter((event) => nowMs - event.at < AFFINITY_MAX_AGE_MS);
}

function rememberAffinity(listingId: string, kind: InteractionKind, nowMs: number) {
  if (typeof window === "undefined" || !listingId) return;
  const events = readAffinity();
  // One entry per listing and kind: looking at something ten times should not
  // crowd out everything else they were interested in.
  const key = `${listingId}:${kind}`;
  const kept = events.filter((event) => `${event.listingId}:${event.kind}` !== key);
  kept.push({ listingId, kind, at: nowMs });
  const trimmed = kept
    .filter((event) => nowMs - event.at < AFFINITY_MAX_AGE_MS)
    .slice(-MAX_AFFINITY_EVENTS);
  writeStorage(AFFINITY_STORAGE_KEY, JSON.stringify(trimmed));
}

/** A card was genuinely on screen. */
export function trackImpression(listingId: string, nowMs = Date.now()) {
  enqueue(listingId, "impression");
  rememberAffinity(listingId, "impression", nowMs);
}

/** They opened it. */
export function trackClick(listingId: string, nowMs = Date.now()) {
  enqueue(listingId, "click");
  rememberAffinity(listingId, "click", nowMs);
}

/** Local only - `listing_likes` is already the record of this. */
export function trackLike(listingId: string, nowMs = Date.now()) {
  rememberAffinity(listingId, "like", nowMs);
}

/** Local only - `campaign_requests` is already the record of this. */
export function trackOffer(listingId: string, nowMs = Date.now()) {
  rememberAffinity(listingId, "offer", nowMs);
}

/**
 * Watches listing cards and reports the ones a person actually reached.
 *
 * Counting every card the page renders would be easier and would lie: a
 * listing five rows below the fold has not been seen by anyone. A card has to
 * be half visible for a full second before it counts, which is roughly the
 * point at which somebody has looked at it rather than scrolled past it.
 *
 * Returns a teardown function.
 */
export function watchListingImpressions(root: ParentNode | null) {
  if (typeof window === "undefined" || !root) return () => {};
  if (typeof IntersectionObserver === "undefined") return () => {};

  const dwelling = new Map<Element, number>();
  const counted = new WeakSet<Element>();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const element = entry.target;
        const listingId = (element as HTMLElement).dataset?.listingId ?? "";
        if (!listingId || counted.has(element)) {
          observer.unobserve(element);
          continue;
        }
        if (entry.isIntersecting) {
          if (dwelling.has(element)) continue;
          const timer = window.setTimeout(() => {
            dwelling.delete(element);
            counted.add(element);
            observer.unobserve(element);
            trackImpression(listingId);
          }, 1000);
          dwelling.set(element, timer);
        } else {
          const timer = dwelling.get(element);
          if (timer !== undefined) {
            window.clearTimeout(timer);
            dwelling.delete(element);
          }
        }
      }
    },
    { threshold: 0.5 },
  );

  for (const card of root.querySelectorAll("[data-listing-id]")) {
    observer.observe(card);
  }

  return () => {
    for (const timer of dwelling.values()) window.clearTimeout(timer);
    dwelling.clear();
    observer.disconnect();
  };
}
