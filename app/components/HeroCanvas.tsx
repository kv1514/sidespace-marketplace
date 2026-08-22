"use client";

import dynamic from "next/dynamic";

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

export default function HeroCanvas() {
  return <HeroScene />;
}
