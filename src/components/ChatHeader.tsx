"use client";

import Image from "next/image";
import { ConversationWithLastMessage } from "@/lib/types";

interface Props {
  conversation: ConversationWithLastMessage;
  onToggleMode: () => void;
  isTogglingMode: boolean;
  onBack?: () => void;
}

function getInitials(name: string | null, username: string | null): string {
  const str = name || username || "?";
  return str
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function ChatHeader({ conversation, onToggleMode, isTogglingMode, onBack }: Props) {
  const isAgent = conversation.mode === "agent";

  return (
    <header className="shrink-0 h-16 bg-zinc-900/60 backdrop-blur-md border-b border-white/[0.06] pl-2 pr-3 sm:px-4 flex items-center gap-2 sm:gap-3">
      {/* Back to list — mobile only */}
      {onBack && (
        <button
          onClick={onBack}
          aria-label="Voltar para a lista de conversas"
          className="lg:hidden shrink-0 w-10 h-10 grid place-items-center rounded-xl text-zinc-300 hover:text-white hover:bg-white/[0.06] active:scale-95 transition-all"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
      )}

      {/* Identity */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {conversation.profile_pic ? (
          <Image
            src={conversation.profile_pic}
            alt={conversation.name ?? "Cliente"}
            width={40}
            height={40}
            className="w-10 h-10 rounded-full object-cover shrink-0"
            unoptimized
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 grid place-items-center text-white text-sm font-bold shrink-0">
            {getInitials(conversation.name, conversation.username)}
          </div>
        )}

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-white font-semibold text-sm tracking-tight truncate">
              {conversation.name ?? conversation.username ?? conversation.igsid}
            </h2>
            {conversation.is_user_follow_business && (
              <span className="shrink-0 text-[10px] font-semibold bg-fuchsia-500/15 text-fuchsia-300 px-2 py-0.5 rounded-full">
                te segue
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-400 truncate">
            {conversation.username ? `@${conversation.username}` : conversation.igsid}
            {conversation.follower_count != null && ` · ${conversation.follower_count.toLocaleString()} seguidores`}
          </div>
        </div>
      </div>

      {/* AI status + per-conversation control */}
      <div className="flex items-center gap-2.5 shrink-0">
        <span
          className={`hidden md:flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${
            isAgent
              ? "bg-emerald-500/10 border-emerald-400/20 text-emerald-300"
              : "bg-amber-500/10 border-amber-400/20 text-amber-300"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isAgent ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
          {isAgent ? "IA ativa" : "IA pausada"}
        </span>

        <button
          onClick={onToggleMode}
          disabled={isTogglingMode}
          title={
            isAgent
              ? "Pausar a IA apenas nesta conversa. Você passa a responder manualmente."
              : "Reativar a IA nesta conversa, ela volta a responder automaticamente."
          }
          className={`h-10 px-3.5 sm:px-4 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-95 disabled:opacity-60 whitespace-nowrap ${
            isAgent
              ? "bg-amber-400 hover:bg-amber-300 text-zinc-950 shadow-lg shadow-amber-950/30"
              : "bg-emerald-400 hover:bg-emerald-300 text-zinc-950 shadow-lg shadow-emerald-950/30"
          }`}
        >
          {isTogglingMode ? "..." : isAgent ? "Pausar IA" : "Reativar IA"}
        </button>
      </div>
    </header>
  );
}
