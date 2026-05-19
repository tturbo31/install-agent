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
      <button
        onClick={onToggleMode}
        disabled={isTogglingMode}
        className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all disabled:opacity-60 ${
          isAgent
            ? "bg-purple-600 hover:bg-purple-700 text-white"
            : "bg-amber-600 hover:bg-amber-700 text-white"
        }`}
      >
        {isAgent ? (
          <>
            <span className="text-base">🤖</span>
            AI Mode
          </>
        ) : (
          <>
            <span className="text-base">👤</span>
            Human Mode
          </>
        )}
      </button>
    </div>
  );
}
