"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import type { ReportHistoryItem } from "@/app/lib/types";

interface ReportSidebarProps {
  history: ReportHistoryItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d, yyyy");
  } catch {
    return dateStr;
  }
}

function formatDateShort(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

export default function ReportSidebar({
  history,
  activeId,
  onSelect,
}: ReportSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (!history.length) return null;

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:flex flex-col bg-[#0d0d0d] border-r border-[#1f1f1f] transition-all duration-300 ${
          collapsed ? "w-14" : "w-56"
        } shrink-0`}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-[#1f1f1f]">
          {!collapsed && (
            <span className="text-[10px] font-semibold text-[#6b6b6b] uppercase tracking-wider">
              Report History
            </span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto p-1.5 rounded-lg text-[#6b6b6b] hover:text-[#a1a1a1] hover:bg-[#1a1a1a] transition-colors"
            title={collapsed ? "Expand" : "Collapse"}
          >
            <svg
              className={`w-4 h-4 transition-transform ${collapsed ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* Report list */}
        <div className="flex-1 overflow-y-auto py-2">
          {history.map((report, i) => {
            const isActive = report.id === activeId;
            return (
              <button
                key={report.id}
                onClick={() => onSelect(report.id)}
                className={`w-full text-left px-3 py-2.5 transition-all duration-150 group relative ${
                  isActive
                    ? "bg-[#ffffff]/10 border-r-2 border-[#ffffff]"
                    : "hover:bg-[#1a1a1a]"
                }`}
                title={collapsed ? formatDate(report.analysis_date || report.created_at) : undefined}
              >
                {collapsed ? (
                  <div className="flex flex-col items-center gap-0.5">
                    <span
                      className={`text-[10px] font-bold ${
                        isActive ? "text-[#ffffff]" : "text-[#6b6b6b]"
                      }`}
                    >
                      #{report.run_number}
                    </span>
                    {i === 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#ffffff]" />
                    )}
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          isActive
                            ? "bg-[#ffffff]/20 text-[#ffffff]"
                            : "bg-[#1f1f1f] text-[#6b6b6b]"
                        }`}
                      >
                        Run #{report.run_number}
                      </span>
                      {i === 0 && (
                        <span className="text-[9px] font-medium text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                          Latest
                        </span>
                      )}
                    </div>
                    <p
                      className={`text-xs mt-1 ${
                        isActive ? "text-[#f5f5f5]" : "text-[#a1a1a1]"
                      }`}
                    >
                      {formatDate(report.analysis_date || report.created_at)}
                    </p>
                    {report.executive_summary && !isActive && (
                      <p className="text-[10px] text-[#6b6b6b] mt-0.5 line-clamp-1 leading-relaxed">
                        {report.executive_summary.slice(0, 60)}...
                      </p>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Mobile horizontal date scroller */}
      <div className="lg:hidden bg-[#0d0d0d] border-b border-[#1f1f1f] px-4 py-2 overflow-x-auto flex gap-2 scrollbar-hide">
        {history.map((report, i) => {
          const isActive = report.id === activeId;
          return (
            <button
              key={report.id}
              onClick={() => onSelect(report.id)}
              className={`shrink-0 flex flex-col items-center px-3 py-1.5 rounded-xl transition-all duration-150 border ${
                isActive
                  ? "bg-[#ffffff]/10 border-[#ffffff]/30 text-[#ffffff]"
                  : "bg-[#111111] border-[#2a2a2a] text-[#6b6b6b] hover:text-[#a1a1a1]"
              }`}
            >
              <span className="text-[9px] font-bold uppercase tracking-wide">
                #{report.run_number}
              </span>
              <span className="text-[10px] font-medium">
                {formatDateShort(report.analysis_date || report.created_at)}
              </span>
              {i === 0 && (
                <span className="w-1 h-1 rounded-full bg-emerald-500 mt-0.5" />
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
