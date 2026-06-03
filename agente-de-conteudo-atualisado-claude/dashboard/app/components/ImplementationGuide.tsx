"use client";

import ReactMarkdown from "react-markdown";

interface ImplementationGuideProps {
  content: string;
}

export default function ImplementationGuide({ content }: ImplementationGuideProps) {
  if (!content) return null;

  return (
    <div className="rounded-2xl border border-[#2a2a2a] bg-[#111111] overflow-hidden animate-fade-in-up delay-300">
      {/* Header */}
      <div className="relative px-6 py-4 bg-gradient-to-r from-[#ffffff]/10 via-[#8a8a8a]/5 to-transparent border-b border-[#2a2a2a]">
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[#ffffff] via-[#8a8a8a] to-transparent" />
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
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-bold text-[#f5f5f5]">Implementation Guide</h2>
            <p className="text-xs text-[#6b6b6b]">Actionable steps to integrate today's insights</p>
          </div>
        </div>
      </div>

      {/* Markdown content */}
      <div className="p-6 prose-dark">
        <ReactMarkdown
          components={{
            h1: ({ children }) => (
              <h1 className="text-xl font-bold text-[#f5f5f5] mt-0 mb-4 pb-2 border-b border-[#2a2a2a]">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-base font-bold text-[#f5f5f5] mt-6 mb-3 flex items-center gap-2">
                <span className="w-1 h-4 rounded-full bg-gradient-to-b from-[#ffffff] to-[#8a8a8a]" />
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-sm font-semibold text-[#d4d4d4] mt-4 mb-2">
                {children}
              </h3>
            ),
            p: ({ children }) => (
              <p className="text-sm text-[#a1a1a1] leading-relaxed mb-3">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="space-y-1.5 mb-4 pl-0 list-none">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="space-y-1.5 mb-4 pl-0 list-none">{children}</ol>
            ),
            li: ({ children }) => (
              <li className="flex items-start gap-2.5 text-sm text-[#a1a1a1]">
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[#ffffff] mt-2" />
                <span className="leading-relaxed">{children}</span>
              </li>
            ),
            code: ({ children, className }) => {
              const isBlock = className?.includes("language-");
              if (isBlock) {
                return (
                  <div className="my-3 rounded-xl overflow-hidden border border-[#2a2a2a]">
                    <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d0d0d] border-b border-[#2a2a2a]">
                      <div className="flex gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#2a2a2a]" />
                        <span className="w-2.5 h-2.5 rounded-full bg-[#2a2a2a]" />
                        <span className="w-2.5 h-2.5 rounded-full bg-[#2a2a2a]" />
                      </div>
                      <span className="text-[10px] text-[#6b6b6b] font-mono">
                        {className?.replace("language-", "") ?? "code"}
                      </span>
                    </div>
                    <pre className="bg-[#0a0a0a] p-4 overflow-x-auto">
                      <code className={`text-xs text-[#e5e5e5] font-mono leading-relaxed ${className ?? ""}`}>
                        {children}
                      </code>
                    </pre>
                  </div>
                );
              }
              return (
                <code className="bg-[#1a1a1a] border border-[#2a2a2a] text-[#8a8a8a] px-1.5 py-0.5 rounded text-xs font-mono">
                  {children}
                </code>
              );
            },
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-[#ffffff] pl-4 my-3 text-sm text-[#6b6b6b] italic">
                {children}
              </blockquote>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-[#f5f5f5]">{children}</strong>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#ffffff] hover:text-[#8a8a8a] transition-colors underline underline-offset-2"
              >
                {children}
              </a>
            ),
            hr: () => <hr className="border-[#2a2a2a] my-4" />,
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
