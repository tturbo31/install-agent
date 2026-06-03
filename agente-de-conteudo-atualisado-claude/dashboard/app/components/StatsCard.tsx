"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface StatsCardProps {
  label: string;
  value: number | string;
  icon: ReactNode;
  suffix?: string;
  description?: string;
  delay?: number;
  gradient?: "orange" | "amber" | "green" | "blue";
}

const gradients = {
  orange: "from-white/[0.08] to-white/[0.02]",
  amber:  "from-white/[0.06] to-white/[0.015]",
  green:  "from-white/[0.05] to-white/[0.01]",
  blue:   "from-white/[0.04] to-white/[0.01]",
};

const iconColors = {
  orange: "text-white",
  amber:  "text-[#d4d4d4]",
  green:  "text-[#a1a1a1]",
  blue:   "text-[#8a8a8a]",
};

const borderColors = {
  orange: "border-white/20",
  amber:  "border-white/15",
  green:  "border-white/10",
  blue:   "border-white/10",
};

function AnimatedNumber({ target }: { target: number }) {
  const [current, setCurrent] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const duration = 900;

  useEffect(() => {
    if (target === 0) return;

    const animate = (timestamp: number) => {
      if (startRef.current === null) startRef.current = timestamp;
      const elapsed = timestamp - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCurrent(Math.round(eased * target));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target]);

  return <>{current.toLocaleString()}</>;
}

export default function StatsCard({
  label,
  value,
  icon,
  suffix = "",
  description,
  delay = 0,
  gradient = "orange",
}: StatsCardProps) {
  const isNumeric = typeof value === "number";

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border ${borderColors[gradient]} bg-gradient-to-br ${gradients[gradient]} bg-[#111111] p-5 animate-fade-in-up card-hover`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Subtle top border accent */}
      <div
        className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-current to-transparent opacity-30 ${iconColors[gradient]}`}
      />

      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-[#6b6b6b] uppercase tracking-wider mb-2">
            {label}
          </p>
          <p className="text-3xl font-bold text-[#f5f5f5] leading-none tabular-nums">
            {isNumeric ? (
              <AnimatedNumber target={value as number} />
            ) : (
              value
            )}
            {suffix && (
              <span className="text-lg text-[#a1a1a1] ml-1">{suffix}</span>
            )}
          </p>
          {description && (
            <p className="text-xs text-[#6b6b6b] mt-2 leading-relaxed">
              {description}
            </p>
          )}
        </div>

        <div
          className={`shrink-0 p-2.5 rounded-xl bg-[#1a1a1a] border border-[#2a2a2a] ${iconColors[gradient]}`}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}
