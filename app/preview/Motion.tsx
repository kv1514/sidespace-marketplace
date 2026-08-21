"use client";

import { useEffect } from "react";

/**
 * Scroll motion for the preview route.
 *
 * Deliberately not a library: the whole page is server-rendered and this is the
 * only client JS on it, so it stays a few hundred bytes rather than pulling in
 * an animation runtime.
 *
 * Two behaviours:
 *   [data-reveal]  fades and un-blurs upward as it enters the viewport, with a
 *                  stagger applied per item inside a group.
 *   [data-count]   counts a figure up to its real value once, when first seen.
 *
 * Robustness matters more than the effect here. Hiding content in JavaScript
 * and waiting for a callback to bring it back is a bet, and the failure mode is
 * a permanently blank page. Three things de-risk it:
 *
 *   1. Nothing is hidden until we have confirmed the browser can animate.
 *   2. Anything already inside the viewport is revealed immediately, by
 *      measuring, so above-the-fold content never depends on the observer.
 *   3. A watchdog reveals everything if the observer has not delivered a single
 *      entry shortly after arming. IntersectionObserver is tied to the
 *      rendering lifecycle, so a throttled, backgrounded or non-compositing
 *      renderer can starve it indefinitely, and that must not cost the reader
 *      the page.
 *
 * All of it is skipped under prefers-reduced-motion.
 */
export default function Motion() {
  useEffect(() => {
    const revealables = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    const counters = Array.from(
      document.querySelectorAll<HTMLElement>("[data-count]"),
    );

    const showAll = () => {
      for (const el of revealables) el.dataset.reveal = "in";
    };
    const settleCounters = () => {
      for (const el of counters) {
        const target = Number(el.dataset.count ?? 0);
        el.textContent = `${el.dataset.countPrefix ?? ""}${target}`;
      }
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      showAll();
      return;
    }

    const inViewport = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    };

    // Hide only what is genuinely below the fold. Anything on screen at mount
    // is left alone, so the first paint never flickers and never depends on a
    // callback arriving.
    const deferred: HTMLElement[] = [];
    for (const el of revealables) {
      if (inViewport(el)) {
        el.dataset.reveal = "in";
      } else {
        el.dataset.reveal = "out";
        deferred.push(el);
      }
    }

    let delivered = false;
    let watchdog = 0;

    const revealObserver = new IntersectionObserver(
      (entries) => {
        delivered = true;
        window.clearTimeout(watchdog);
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const delay = Number(el.dataset.revealDelay ?? 0);
          window.setTimeout(() => {
            el.dataset.reveal = "in";
          }, delay);
          revealObserver.unobserve(el);
        }
      },
      // Fire a little before the element is fully on screen so the motion reads
      // as the page arriving, not as a jump once it is already visible.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    for (const el of deferred) revealObserver.observe(el);

    // If the observer has not produced a single callback by now, the renderer
    // is not driving it. Give the reader the page rather than the effect.
    watchdog = window.setTimeout(() => {
      if (!delivered) {
        revealObserver.disconnect();
        showAll();
        settleCounters();
      }
    }, 2500);

    const countObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          countObserver.unobserve(el);

          const target = Number(el.dataset.count ?? 0);
          const prefix = el.dataset.countPrefix ?? "";
          if (!Number.isFinite(target) || target <= 0) {
            el.textContent = `${prefix}${target}`;
            continue;
          }

          const duration = 900;
          const start = performance.now();
          const tick = (now: number) => {
            const progress = Math.min((now - start) / duration, 1);
            // Ease out cubic: fast first, settles on the real number.
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = `${prefix}${Math.round(target * eased)}`;
            if (progress < 1) requestAnimationFrame(tick);
            else el.textContent = `${prefix}${target}`;
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.4 },
    );

    for (const el of counters) countObserver.observe(el);

    return () => {
      window.clearTimeout(watchdog);
      revealObserver.disconnect();
      countObserver.disconnect();
    };
  }, []);

  return null;
}
