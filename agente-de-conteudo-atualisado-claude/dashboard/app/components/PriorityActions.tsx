"use client";

import { useState } from "react";

interface PriorityActionsProps {
  actions: string[];
}

const accentColors = [
  { border: "border-[#ffffff]", bg: "bg-[#ffffff]/5", num: "text-[#ffffff]", numBg: "bg-[#ffffff]/10" },
  { border: "border-[#8a8a8a]", bg: "bg-[#8a8a8a]/5", num: "text-[#8a8a8a]", numBg: "bg-[#8a8a8a]/10" },
  { border: "border-emerald-500", bg: "bg-emerald-500/5", num: "text-emerald-400", numBg: "bg-emerald-500/10" },
  { border: "border-sky-500", bg: "bg-sky-500/5", num: "text-sky-400", numBg: "bg-sky-500/10" },
  { border: "border-violet-500", bg: "bg-violet-500/5", num: "text-violet-400", numBg: "bg-violet-500/10" },
];

export default function PriorityActions({ actions }: PriorityActionsProps) {
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  if (!actions?.length) return null;

  const completedCount = checked.size;
  const totalCount = actions.length;
  const progressPct = (completedCount / totalCount) * 100;

  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-[#111111] overflow-hidden animate-fade-in-up delay-400">
      {/* Header */}
      <div className="relative px-5 py-4 border-b border-[#1f1f1f]">
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[#ffffff] to-[#8a8a8a]" />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#ffffff]/10 border border-[#ffffff]/20">
              <svg
                className="w-4 h-4 text-[#ffffff]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-bold text-[#f5f5f5]">Priority Actions</h2>
              <p className="text-xs text-[#6b6b6b]">
                {completedCount}/{totalCount} completed
              </p>
            </div>
          </div>

          {/* Progress ring */}
          <div className="relative w-10 h-10">
            <svg className="w-10 h-10 -rotate-90" viewBox="0 0 40 40">
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                stroke="#1f1f1f"
                strokeWidth="3"
              />
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                stroke="url(#progress-gradient)"
                strokeWidth="3"
                strokeDasharray={`${2 * Math.PI * 16}`}
                strokeDashoffset={`${2 * Math.PI * 16 * (1 - progressPct / 100)}`}
                strokeLinecap="round"
                className="transition-all duration-500"
              />
              <defs>
                <linearGradient id="progress-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="100%" stopColor="#8a8a8a" />
                </linearGradient>
              </defs>
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-[#f5f5f5]">
              {Math.round(progressPct)}%
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3 h-0.5 rounded-full bg-[#1f1f1f] overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#ffffff] to-[#8a8a8a] transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Action list */}
      <div className="p-4 space-y-2">
        {actions.map((action, i) => {
          const color = accentColors[i % accentColors.length];
          const isDone = checked.has(i);

          return (
            <button
              key={i}
              onClick={() => toggle(i)}
              className={`w-full text-left flex items-start gap-3 p-3 rounded-xl border-l-2 transition-all duration-200 group ${color.border} ${color.bg} hover:opacity-90 active:scale-[0.99]`}
            >
              {/* Number / check */}
              <span
                className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-200 ${
                  isDone
                    ? "bg-emerald-500 text-white"
                    : `${color.numBg} ${color.num}`
                }`}
              >
                {isDone ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>

              {/* Text */}
              <span
                className={`text-xs leading-relaxed transition-all duration-200 ${
                  isDone ? "line-through text-[#6b6b6b]" : "text-[#a1a1a1]"
                }`}
              >
                {action}
              </span>
            </button>
          );
        })}
      </div>

      {completedCount === totalCount && totalCount > 0 && (
        <div className="px-5 pb-5">
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-center">
            <p className="text-xs font-semibold text-emerald-400">
              All actions completed! Great work.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
