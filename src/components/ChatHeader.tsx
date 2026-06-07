"use client";

import Image from "next/image";
import { ConversationWithLastMessage } from "@/lib/types";

interface Props {
  conversation: ConversationWithLastMessage;
  onToggleMode: () => void;
  isTogglingMode: boolean;
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

export default function ChatHeader({ conversation, onToggleMode, isTogglingMode }: Props) {
  const isAgent = conversation.mode === "agent";

  return (
    <header className="flex-shrink-0 h-16 bg-gray-900 border-b border-gray-800 px-5 flex items-center justify-between gap-3">
      {/* Left: avatar + identity (can shrink/truncate) */}
      <div className="flex items-center gap-3 min-w-0">
        {conversation.profile_pic ? (
          <Image
            src={conversation.profile_pic}
            alt={conversation.name ?? "User"}
            width={40}
            height={40}
            className="rounded-full object-cover flex-shrink-0"
            unoptimized
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
            {getInitials(conversation.name, conversation.username)}
          </div>
        )}

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-white font-semibold text-sm truncate">
              {conversation.name ?? conversation.username ?? conversation.igsid}
            </h2>
            {conversation.is_user_follow_business && (
              <span className="flex-shrink-0 text-[10px] bg-violet-500/15 text-violet-300 px-1.5 py-0.5 rounded-full">
                te segue
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {conversation.username ? `@${conversation.username}` : conversation.igsid}
            {conversation.follower_count != null && ` · ${conversation.follower_count.toLocaleString()} seguidores`}
          </div>
        </div>
      </div>

      {/* Right: per-conversation AI control (never overlaps — fixed width, no shrink) */}
      <div className="flex items-center gap-2.5 flex-shrink-0">
        <span
          className={`hidden md:flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
            isAgent ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isAgent ? "bg-emerald-400" : "bg-amber-400"}`} />
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
          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60 whitespace-nowrap ${
            isAgent
              ? "bg-amber-500/90 hover:bg-amber-500 text-gray-950"
              : "bg-emerald-500/90 hover:bg-emerald-500 text-gray-950"
          }`}
        >
          {isTogglingMode ? "..." : isAgent ? "Pausar IA" : "Reativar IA"}
        </button>
      </div>
    </header>
  );
}
