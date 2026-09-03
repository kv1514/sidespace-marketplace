"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

/**
 * A 360 photo or 360 video of a space, looked around by dragging.
 *
 * Equirectangular input - the whole surroundings flattened into a 2:1 image,
 * which is what every 360 camera and phone panorama mode exports - is painted
 * on the inside of a sphere with the camera at its centre, the standard
 * three.js panorama. Drag turns the camera; the wheel or a pinch zooms. No
 * gyroscope: iOS asks for motion permission through a dialog that reads as a
 * warning, and dragging is enough to walk the space.
 *
 * Loaded on demand through next/dynamic, so three.js is fetched only on a
 * listing that has a 360 walkthrough.
 */

export type PanoramaKind = "photo360" | "video360";

type Props = {
  src: string;
  kind: PanoramaKind;
  /** Read out for screen readers, and shown while loading. */
  label: string;
};

const FOV_MIN = 40;
const FOV_MAX = 100;
const FOV_START = 75;
const RADIUS = 500;

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

export default function PanoramaViewer({ src, kind, label }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const movedRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [moved, setMoved] = useState(false);

  // State starts fresh with the component: the parent keys it by source, so
  // a different file is a new viewer rather than a reset inside this one.
  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    movedRef.current = false;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "low-power" });
    } catch {
      // No WebGL (a locked-down browser, a remote desktop). The flat
      // fallback below still shows the file.
      queueMicrotask(() => setStatus("failed"));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label);
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV_START, 1, 1, RADIUS * 2.2);
    const geometry = new THREE.SphereGeometry(RADIUS, 60, 40);
    // Painted on the inside, seen from the centre.
    geometry.scale(-1, 1, 1);

    let disposed = false;
    let frame = 0;
    let video: HTMLVideoElement | null = null;
    let texture: THREE.Texture;
    const material = new THREE.MeshBasicMaterial();

    const fail = () => {
      if (disposed) return;
      setStatus("failed");
      teardown();
    };
    const ready = () => {
      if (!disposed) setStatus("ready");
    };

    if (kind === "video360") {
      video = document.createElement("video");
      // The bucket answers with access-control-allow-origin: *, which is
      // what lets a video paint into WebGL at all.
      video.crossOrigin = "anonymous";
      video.playsInline = true;
      video.loop = true;
      video.muted = true;
      video.preload = "metadata";
      video.addEventListener("loadedmetadata", ready);
      video.addEventListener("error", fail);
      video.addEventListener("play", () => {
        if (!disposed) setPlaying(true);
      });
      video.addEventListener("pause", () => {
        if (!disposed) setPlaying(false);
      });
      video.src = src;
      videoRef.current = video;
      texture = new THREE.VideoTexture(video);
    } else {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin("anonymous");
      texture = loader.load(src, ready, undefined, fail);
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    // A 4096-wide equirectangular image is not a power of two on every
    // device; plain linear filtering needs no mipmaps and looks fine.
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    material.map = texture;
    scene.add(new THREE.Mesh(geometry, material));

    // Where the camera looks, in degrees, and how wide.
    let lon = 0;
    let lat = 0;
    let fov = FOV_START;
    // Wheel zoom only once the viewer has been touched; before that the wheel
    // scrolls the page it sits in, as a reader expects.
    let engaged = false;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;

    const setFov = (next: number) => {
      fov = clamp(next, FOV_MIN, FOV_MAX);
      camera.fov = fov;
      camera.updateProjectionMatrix();
    };
    const onPointerDown = (event: PointerEvent) => {
      engaged = true;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      const last = pointers.get(event.pointerId);
      if (!last) return;
      const current = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, current);
      if (pointers.size >= 2) {
        const [a, b] = Array.from(pointers.values());
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance && distance) setFov(fov * (pinchDistance / distance));
        pinchDistance = distance;
        return;
      }
      // Slower when zoomed in, so a drag moves the picture the same distance
      // on screen whatever the zoom.
      const speed = 0.2 * (fov / FOV_START);
      lon -= (current.x - last.x) * speed;
      lat = clamp(lat + (current.y - last.y) * speed, -85, 85);
      if (!movedRef.current) {
        movedRef.current = true;
        setMoved(true);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (!pointers.size) canvas.style.cursor = "grab";
      pinchDistance = 0;
    };
    const onWheel = (event: WheelEvent) => {
      if (!engaged) return;
      event.preventDefault();
      setFov(fov + event.deltaY * 0.05);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const target = new THREE.Vector3();
    const loop = () => {
      if (disposed) return;
      const phi = THREE.MathUtils.degToRad(90 - lat);
      const theta = THREE.MathUtils.degToRad(lon);
      target.set(
        RADIUS * Math.sin(phi) * Math.cos(theta),
        RADIUS * Math.cos(phi),
        RADIUS * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(target);
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();

    function teardown() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        if (videoRef.current === video) videoRef.current = null;
      }
      texture.dispose();
      material.dispose();
      geometry.dispose();
      renderer.dispose();
      canvas.remove();
    }
    return teardown;
  }, [src, kind, label]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.muted = muted;
      video.play().catch(() => setStatus("failed"));
    } else {
      video.pause();
    }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    if (videoRef.current) videoRef.current.muted = next;
  }

  if (status === "failed") {
    // The file still shows, flat: a 360 video plays like any video and a 360
    // photo appears as the wide strip it is. Better than a blank box.
    return kind === "video360" ? (
      <video
        className="pano-fallback"
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={label}
      />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img className="pano-fallback" src={src} alt={label} />
    );
  }

  return (
    <div className={`pano-viewer${status === "ready" ? " is-ready" : ""}`}>
      <div ref={mountRef} className="pano-canvas" />
      {status === "loading" && (
        <span className="pano-status" role="status">
          Loading the 360° view…
        </span>
      )}
      {status === "ready" && !moved && (
        <span className="pano-hint" aria-hidden="true">
          Drag to look around
        </span>
      )}
      {kind === "video360" && status === "ready" && (
        <div className="pano-controls">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause the 360° video" : "Play the 360° video"}
          >
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? "Turn the sound on" : "Turn the sound off"}
          >
            {muted ? "Sound off" : "Sound on"}
          </button>
        </div>
      )}
    </div>
  );
}
