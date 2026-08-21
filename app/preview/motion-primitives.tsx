"use client";

import {
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type Variants,
} from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The scroll choreography for the rebranded marketing page.
 *
 * Everything here reads useReducedMotion and degrades to "just show it", and
 * every wrapper renders its children unconditionally, so a motion failure can
 * never cost the reader the content.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/** Fade, un-blur and rise. The blur is what makes it read as arriving. */
export function Reveal({
  children,
  delay = 0,
  as = "div",
  className,
}: {
  children: ReactNode;
  delay?: number;
  as?: "div" | "section" | "p" | "h2" | "li";
  className?: string;
}) {
  const reduce = useReducedMotion();
  const Component = motion[as];

  if (reduce) {
    return <div className={className}>{children}</div>;
  }

  return (
    <Component
      className={className}
      initial={{ opacity: 0, y: 18, filter: "blur(6px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ duration: 0.55, ease: EASE, delay }}
    >
      {children}
    </Component>
  );
}

const containerVariants: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.07 } },
};

const childVariants: Variants = {
  hidden: { opacity: 0, y: 18, filter: "blur(6px)" },
  shown: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.55, ease: EASE },
  },
};

/** A group whose children arrive one after another rather than together. */
export function Stagger({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();

  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      variants={containerVariants}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={childVariants}>
      {children}
    </motion.div>
  );
}

/** Counts a real figure up the first time it is seen. */
export function CountUp({
  value,
  prefix = "",
  className,
}: {
  value: number;
  prefix?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const progress = useMotionValue(0);
  const spring = useSpring(progress, { duration: 900, bounce: 0 });
  const shown = useTransform(spring, (latest) =>
    `${prefix}${Math.round(latest)}`,
  );

  useEffect(() => {
    if (inView && !reduce) progress.set(value);
  }, [inView, progress, reduce, value]);

  // The server already rendered the true figure. Only swap in the animated
  // one on the client, so the correct number is in the HTML either way.
  if (reduce) {
    return (
      <span className={className}>
        {prefix}
        {value}
      </span>
    );
  }

  return (
    <span className={className} ref={ref}>
      <motion.span>{shown}</motion.span>
    </span>
  );
}

/** Hero lines, which are already in view and so animate on load. */
export function HeroLine({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20, filter: "blur(7px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.7, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}
