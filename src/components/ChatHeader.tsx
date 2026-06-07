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
    <div className="bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        {/* Avatar */}
        {conversation.profile_pic ? (
          <Image
            src={conversation.profile_pic}
            alt={conversation.name ?? "User"}
            width={48}
            height={48}
            className="rounded-full object-cover"
            unoptimized
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold">
            {getInitials(conversation.name, conversation.username)}
          </div>
        )}

        {/* Name + badges */}
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-white font-semibold text-base">
              {conversation.name ?? conversation.username ?? conversation.igsid}
            </h2>
            {conversation.is_user_follow_business && (
              <span className="text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded-full">
                Follows you
              </span>
            )}
            {conversation.is_business_follow_user && (
              <span className="text-xs bg-pink-900 text-pink-300 px-2 py-0.5 rounded-full">
                You follow
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {conversation.username && (
              <span className="text-gray-400 text-sm">@{conversation.username}</span>
            )}
            {conversation.follower_count != null && (
              <span className="text-gray-500 text-xs">
                · {conversation.follower_count.toLocaleString()} followers
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Mode toggle */}
      {/* Per-conversation AI pause / reactivate */}
      <div className="flex items-center gap-3">
        {/* Current status of THIS conversation */}
        <span
          className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full ${
            isAgent ? "bg-green-900 text-green-300" : "bg-amber-900 text-amber-300"
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${isAgent ? "bg-green-400" : "bg-amber-400"}`} />
          {isAgent ? "IA ATIVA" : "IA PAUSADA"}
        </span>

        {/* Action button — the label is the action that happens on click */}
        <button
          onClick={onToggleMode}
          disabled={isTogglingMode}
          title={
            isAgent
              ? "Pausar a IA apenas nesta conversa. Você passa a responder manualmente."
              : "Reativar a IA nesta conversa, ela volta a responder automaticamente."
          }
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all disabled:opacity-60 ${
            isAgent
              ? "bg-amber-600 hover:bg-amber-700 text-white"
              : "bg-green-600 hover:bg-green-700 text-white"
          }`}
        >
          {isTogglingMode ? (
            "..."
          ) : isAgent ? (
            <>
              <span className="text-base">⏸️</span>
              Pausar IA
            </>
          ) : (
            <>
              <span className="text-base">▶️</span>
              Reativar IA
            </>
          )}
        </button>
      </div>
    </div>
  );
}
