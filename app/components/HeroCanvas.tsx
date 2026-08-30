"use client";

import dynamic from "next/dynamic";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Client boundary for the WebGL hero.
 *
 * `ssr: false` is only legal inside a Client Component, and the scene genuinely
 * cannot be server-rendered: it needs a real canvas and a GL context. Keeping
 * the boundary here means the page itself stays a Server Component and three.js
 * never enters the server bundle.
 *
 * No loading state on purpose. The scene is ambient, so a placeholder would be
 * more distracting than its absence, and the hero is designed to stand on its
 * type alone.
 */
const HeroScene = dynamic(() => import("./HeroScene"), { ssr: false });

class HeroSceneBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailure();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function HeroCanvas() {
  const [ready, setReady] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const retries = useRef(0);
  const retryTimer = useRef<number | null>(null);

  const recoverScene = useCallback(() => {
    setReady(false);

    // A context can be lost when the GPU is briefly oversubscribed or the tab
    // is backgrounded. Remounting creates a fresh renderer; the CSS field stays
    // visible throughout, so recovery never exposes a blank or broken layer.
    if (retries.current >= 2 || retryTimer.current !== null) return;
    retries.current += 1;
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      setSceneKey((current) => current + 1);
      setReady(true);
    }, retries.current * 650);
  }, []);

  useEffect(() => {
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    // The CSS inventory planes carry the same meaning without WebGL. Keep the
    // heavy scene off small screens, reduced-motion sessions, and data-saver
    // connections where its subtle depth is not worth the download.
    if (
      connection?.saveData ||
      window.matchMedia("(max-width: 767px)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    if ("requestIdleCallback" in window) {
      const idle = window.requestIdleCallback(() => setReady(true), {
        timeout: 1200,
      });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = setTimeout(() => setReady(true), 600);
    return () => clearTimeout(timer);
  }, []);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
      }
    },
    [],
  );

  return ready ? (
    <HeroSceneBoundary key={sceneKey} onFailure={recoverScene}>
      <HeroScene onContextLost={recoverScene} />
    </HeroSceneBoundary>
  ) : null;
}
