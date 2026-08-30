"use client";

import { useEffect } from "react";

type ParallaxState = {
  current: number;
  max: number;
  speed: number;
};

const PARALLAX_SELECTOR = "[data-ss-parallax]";

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A single, shared scroll loop for every public-page depth layer.
 *
 * React never participates in a frame. The controller watches only nearby
 * elements and batches layout reads before compositor writes. The parallax
 * follows the already-smoothed scroll position directly instead of adding a
 * second easing loop that would make the page feel delayed.
 */
export default function ScrollParallax() {
  useEffect(() => {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>(PARALLAX_SELECTOR),
    );
    if (!elements.length) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const slowUpdates = window.matchMedia("(update: slow)");
    const compactViewport = window.matchMedia("(max-width: 760px)");
    const states = new Map<HTMLElement, ParallaxState>();
    const active = new Set<HTMLElement>();
    let frame = 0;

    for (const element of elements) {
      states.set(element, {
        current: 0,
        max: Math.abs(readNumber(element.dataset.ssParallaxMax, 32)),
        speed: readNumber(element.dataset.ssParallax, 0.06),
      });
    }

    const motionAllowed = () =>
      !reducedMotion.matches && !slowUpdates.matches;

    const reset = () => {
      for (const [element, state] of states) {
        state.current = 0;
        element.style.removeProperty("--ss-parallax-y");
        element.removeAttribute("data-ss-parallax-active");
      }
    };

    const draw = () => {
      frame = 0;
      if (!motionAllowed() || document.visibilityState !== "visible") {
        reset();
        return;
      }

      const viewportCenter = window.innerHeight / 2;
      const travelScale = compactViewport.matches ? 0.72 : 1;

      // Read first. Subtracting the current translate recovers the element's
      // layout position, so its own transform never feeds back into the math.
      for (const element of active) {
        const state = states.get(element);
        if (!state) continue;
        const rect = element.getBoundingClientRect();
        const layoutCenter = rect.top + rect.height / 2 - state.current;
        const distance = viewportCenter - layoutCenter;
        const limit = state.max * travelScale;
        state.current = Math.max(
          -limit,
          Math.min(limit, distance * state.speed * travelScale),
        );
        element.style.setProperty(
          "--ss-parallax-y",
          `${state.current.toFixed(2)}px`,
        );
      }
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(draw);
    };

    const observer = "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const element = entry.target as HTMLElement;
              if (entry.isIntersecting) {
                active.add(element);
                element.setAttribute("data-ss-parallax-active", "true");
              } else {
                active.delete(element);
                element.removeAttribute("data-ss-parallax-active");
              }
            }
            schedule();
          },
          { rootMargin: "22% 0px" },
        )
      : null;

    if (observer) {
      for (const element of elements) observer.observe(element);
    } else {
      for (const element of elements) active.add(element);
    }

    const onMotionPreference = () => {
      if (!motionAllowed()) reset();
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    reducedMotion.addEventListener("change", onMotionPreference);
    slowUpdates.addEventListener("change", onMotionPreference);
    compactViewport.addEventListener("change", schedule);
    schedule();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
      reducedMotion.removeEventListener("change", onMotionPreference);
      slowUpdates.removeEventListener("change", onMotionPreference);
      compactViewport.removeEventListener("change", schedule);
      reset();
    };
  }, []);

  return null;
}
