"use client";

import { useEffect } from "react";

const DESKTOP_QUERY = "(hover: hover) and (pointer: fine) and (min-width: 761px)";

/**
 * Adds Lenis only where smooth wheel scrolling is useful. The controller is
 * intentionally lazy and manually driven: it does not add React work to a
 * frame, and it stops its RAF as soon as Lenis has settled.
 */
export default function SmoothScroll() {
  useEffect(() => {
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const slowUpdates = window.matchMedia("(update: slow)");
    let disposed = false;
    let loading = false;
    let destroyInstance: (() => void) | null = null;

    const canUseSmoothScroll = () =>
      desktop.matches &&
      !reducedMotion.matches &&
      !slowUpdates.matches &&
      document.visibilityState === "visible";

    const stop = () => {
      destroyInstance?.();
      destroyInstance = null;
    };

    const start = async () => {
      if (disposed || loading || destroyInstance || !canUseSmoothScroll()) {
        return;
      }

      loading = true;

      try {
        const { default: Lenis } = await import("lenis");
        if (disposed || destroyInstance || !canUseSmoothScroll()) return;

        const lenis = new Lenis({
          anchors: true,
          autoRaf: false,
          // A slightly quicker lerp keeps wheel input responsive while still
          // carrying enough momentum to feel continuous.
          lerp: 0.16,
          smoothWheel: true,
          // Touch scrolling stays browser-native on the public mobile layout.
          syncTouch: false,
          stopInertiaOnNavigate: true,
        });
        let frame = 0;

        const schedule = () => {
          if (!frame) frame = window.requestAnimationFrame(draw);
        };

        const draw = (time: number) => {
          frame = 0;
          lenis.raf(time);

          if (lenis.isScrolling === "smooth") schedule();
        };

        const unsubscribeVirtualScroll = lenis.on("virtual-scroll", schedule);
        const unsubscribeScroll = lenis.on("scroll", () => {
          if (lenis.isScrolling === "smooth") schedule();
        });
        const onClick = (event: MouseEvent) => {
          if (
            event.target instanceof Element &&
            event.target.closest("a[href]")
          ) {
            schedule();
          }
        };
        const onResize = () => schedule();

        // Capture schedules anchor transitions before Lenis handles the link.
        // The listener is passive and never interferes with browser input.
        document.addEventListener("click", onClick, true);
        window.addEventListener("resize", onResize, { passive: true });
        schedule();

        destroyInstance = () => {
          if (frame) window.cancelAnimationFrame(frame);
          unsubscribeVirtualScroll();
          unsubscribeScroll();
          document.removeEventListener("click", onClick, true);
          window.removeEventListener("resize", onResize);
          lenis.destroy();
        };
      } catch {
        // Native scrolling remains the safe fallback if the optional chunk
        // cannot load (offline navigation, blocked script, or an old cache).
      } finally {
        loading = false;
      }
    };

    const onEnvironmentChange = () => {
      if (canUseSmoothScroll()) void start();
      else stop();
    };

    const onVisibilityChange = () => {
      if (canUseSmoothScroll()) void start();
      else stop();
    };

    desktop.addEventListener("change", onEnvironmentChange);
    reducedMotion.addEventListener("change", onEnvironmentChange);
    slowUpdates.addEventListener("change", onEnvironmentChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void start();

    return () => {
      disposed = true;
      stop();
      desktop.removeEventListener("change", onEnvironmentChange);
      reducedMotion.removeEventListener("change", onEnvironmentChange);
      slowUpdates.removeEventListener("change", onEnvironmentChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
