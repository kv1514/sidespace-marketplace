"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

/**
 * The hero scene: a slow drift of rectangular panels in depth.
 *
 * The idea is literal rather than decorative. Every panel is a piece of
 * advertising space, a window, a counter card, a car door, a story, floating
 * in the marketplace. They are proportioned like the real things (a wide shop
 * window, a tall phone story, a square counter card) and tinted from the
 * SideSpace palette, so the shape language matches what the product sells.
 *
 * Restraint is deliberate: this sits behind cream and ink type, so the panels
 * are near-tonal with only a few carrying the yellow. Anything louder would
 * fight the copy it is behind.
 */

/* Mirrors the CSS tokens in globals.css. These cannot read var(--paper) - the
   scene paints into a WebGL context, not the DOM - so they are duplicated here
   and must be updated alongside the palette. Before the rebrand this pair was
   #ffcf03 acid yellow and #fe6e00 orange, which stayed loudly saturated after
   the sheet went cream and made the hero read as a different product. */
const PAPER = "#fbf7e6";
const PAPER_2 = "#f3edd6";
const WHITE = "#fffdf3";
const SIGNAL = "#f3b44a";
const EMBER = "#c77e0a";

type Panel = {
  position: [number, number, number];
  rotation: [number, number, number];
  size: [number, number];
  color: string;
  drift: number;
  spin: number;
};

/** Deterministic pseudo-random so the server and client agree and the layout
 *  is stable between renders. Seeded LCG, not Math.random. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function buildPanels(count: number): Panel[] {
  const random = makeRandom(20260821);
  // Real-world proportions: a shop window, a phone story, a counter card.
  const shapes: Array<[number, number]> = [
    [1.6, 0.95],
    [0.62, 1.15],
    [1.0, 1.0],
    [1.9, 0.7],
    [0.8, 1.35],
  ];
  const palette = [WHITE, PAPER, PAPER_2, WHITE, PAPER, SIGNAL, PAPER_2, EMBER];

  return Array.from({ length: count }, () => {
    const shape = shapes[Math.floor(random() * shapes.length)];
    const scale = 0.55 + random() * 0.5;
    return {
      position: [
        (random() - 0.5) * 13,
        (random() - 0.5) * 7.5,
        -random() * 11,
      ],
      rotation: [
        (random() - 0.5) * 0.34,
        (random() - 0.5) * 0.7,
        (random() - 0.5) * 0.22,
      ],
      size: [shape[0] * scale, shape[1] * scale],
      // Yellow and coral are rare on purpose: roughly one panel in eight.
      color: palette[Math.floor(random() * palette.length)],
      drift: 0.1 + random() * 0.22,
      spin: (random() - 0.5) * 0.1,
    } as Panel;
  });
}

function Panels({ reduce }: { reduce: boolean }) {
  const group = useRef<THREE.Group>(null);
  const panels = useMemo(() => buildPanels(34), []);
  const { viewport } = useThree();

  useFrame((state, delta) => {
    if (!group.current) return;

    if (!reduce) {
      for (const child of group.current.children) {
        child.position.y += child.userData.drift * delta * 0.28;
        child.rotation.z += child.userData.spin * delta * 0.16;
        // Recycle upward drift so the field never empties.
        if (child.position.y > 4.4) child.position.y = -4.4;
      }
    }

    // Pointer parallax, damped. The whole field leans a few degrees toward
    // the cursor, which gives the depth away without anything moving fast.
    const targetX = state.pointer.y * 0.06;
    const targetY = state.pointer.x * 0.12;
    group.current.rotation.x +=
      (targetX - group.current.rotation.x) * Math.min(delta * 2.2, 1);
    group.current.rotation.y +=
      (targetY - group.current.rotation.y) * Math.min(delta * 2.2, 1);
  });

  // Pull the field in on narrow viewports so panels do not crowd the type.
  const spread = Math.min(1, viewport.width / 10);

  return (
    <group ref={group} scale={[Math.max(spread, 0.62), 1, 1]}>
      {panels.map((panel, index) => (
        <mesh
          key={index}
          position={panel.position}
          rotation={panel.rotation}
          userData={{ drift: panel.drift, spin: panel.spin }}
        >
          <planeGeometry args={panel.size} />
          <meshStandardMaterial
            color={panel.color}
            roughness={0.86}
            metalness={0}
            side={THREE.DoubleSide}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}
    </group>
  );
}

function Scene({ reduce }: { reduce: boolean }) {
  return (
    <>
      {/* Cream key light from above so panels read as paper, not plastic. */}
      <ambientLight intensity={1.5} color={PAPER} />
      <directionalLight position={[3, 6, 6]} intensity={1.5} color={WHITE} />
      <directionalLight position={[-5, -2, 3]} intensity={0.5} color={SIGNAL} />
      {/* Fog in the ground colour, so depth fades into the page rather than
          ending at a visible edge. */}
      <fog attach="fog" args={[PAPER, 7, 19]} />
      <Panels reduce={reduce} />
    </>
  );
}

function ContextMonitor({ onContextLost }: { onContextLost: () => void }) {
  const { gl } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };

    canvas.addEventListener("webglcontextlost", handleContextLost, false);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
    };
  }, [gl, onContextLost]);

  return null;
}

export default function HeroScene({
  onContextLost,
}: {
  onContextLost: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  // WebGL is not guaranteed: locked-down browsers, some embedded webviews and
  // machines with blocklisted drivers have none. Probe once, lazily, before a
  // Canvas is ever mounted, because failing inside it takes the section down.
  // Safe during render because this component is client-only (ssr: false), so
  // `document` always exists by the time it runs.
  const [canRender] = useState(() => {
    try {
      const canvas = document.createElement("canvas");
      return Boolean(
        canvas.getContext("webgl2") ??
          canvas.getContext("webgl") ??
          canvas.getContext("experimental-webgl"),
      );
    } catch {
      return false;
    }
  });

  // Nothing pauses an "always" frameloop on its own: r3f keeps a rAF running
  // for the life of the Canvas, so the hero kept compositing at full rate
  // while scrolled a page away and while the tab sat in the background,
  // burning battery for an animation nobody could see.
  const [active, setActive] = useState(true);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let onScreen = true;
    const sync = () =>
      setActive(onScreen && document.visibilityState === "visible");
    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        sync();
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  // Renders nothing rather than something broken. The hero is designed to
  // stand on its own type, so this is a missing flourish, not a hole.
  if (!canRender) return null;

  return (
    <div ref={hostRef} style={{ width: "100%", height: "100%" }}>
      <Canvas
        aria-hidden="true"
        camera={{ position: [0, 0, 8], fov: 42 }}
        dpr={[1, 1.6]}
        fallback={null}
        // The scene is ambient. Never let it fight the main thread for input.
        frameloop={reduce || !active ? "demand" : "always"}
        gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
        style={{ pointerEvents: "none" }}
      >
        <ContextMonitor onContextLost={onContextLost} />
        <Scene reduce={reduce} />
      </Canvas>
    </div>
  );
}
