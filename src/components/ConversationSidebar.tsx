"use client";

import Image from "next/image";
import { ConversationWithLastMessage } from "@/lib/types";

function getInitials(name: string | null, username: string | null): string {
  const str = name || username || "?";
  return str
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

interface Props {
  conversations: ConversationWithLastMessage[];
  selectedId: string | null;
  onSelect: (conv: ConversationWithLastMessage) => void;
}

export default function ConversationSidebar({ conversations, selectedId, onSelect }: Props) {
  return (
    <aside className="w-80 bg-gray-900 border-r border-gray-800 flex flex-col h-full">
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-white font-bold text-lg">Instagram DMs</h1>
        <p className="text-gray-400 text-xs mt-0.5">AI Agent Dashboard</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <div className="p-6 text-center text-gray-500 text-sm">
            No conversations yet
          </div>
        )}
        {conversations.map((conv) => {
          const isSelected = conv.id === selectedId;
          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv)}
              className={`w-full text-left p-4 flex items-center gap-3 hover:bg-gray-800 transition-colors border-l-2 ${
                isSelected
                  ? "border-l-purple-500 bg-gray-800"
                  : "border-l-transparent"
              }`}
            >
              {/* Avatar */}
              <div className="relative flex-shrink-0">
                {conv.profile_pic ? (
                  <Image
                    src={conv.profile_pic}
                    alt={conv.name ?? "User"}
                    width={44}
                    height={44}
                    className="rounded-full object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-11 h-11 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-sm font-bold">
                    {getInitials(conv.name, conv.username)}
                  </div>
                )}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-gray-900 ${
                    conv.mode === "agent" ? "bg-purple-500" : "bg-amber-500"
                  }`}
                />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-white text-sm font-medium truncate">
                    {conv.name ?? conv.username ?? conv.igsid}
                  </span>
                  <span className="text-gray-500 text-xs ml-2 flex-shrink-0">
                    {timeAgo(conv.last_message_at ?? conv.updated_at)}
                  </span>
                </div>
                {conv.username && (
                  <p className="text-gray-400 text-xs truncate">@{conv.username}</p>
                )}
                {conv.last_message && (
                  <p className="text-gray-500 text-xs truncate mt-0.5">
                    {conv.last_message}
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
