"use client";

import { useState } from "react";
import Image from "next/image";
import { ConversationWithLastMessage } from "@/lib/types";

function getInitials(name: string | null, username: string | null): string {
  const str = name || username || "?";
  return str.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
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

function isFacebook(igsid: string): boolean {
  return igsid?.startsWith("fb_") ?? false;
}

function isWhatsApp(igsid: string): boolean {
  return igsid?.startsWith("wa_") ?? false;
}

function getChannel(igsid: string): "instagram" | "facebook" | "whatsapp" {
  if (isFacebook(igsid)) return "facebook";
  if (isWhatsApp(igsid)) return "whatsapp";
  return "instagram";
}

interface Props {
  conversations: ConversationWithLastMessage[];
  selectedId: string | null;
  onSelect: (conv: ConversationWithLastMessage) => void;
  unreadMap?: Record<string, number>;
}

export default function ConversationSidebar({ conversations, selectedId, onSelect, unreadMap = {} }: Props) {
  const [tab, setTab] = useState<"instagram" | "facebook" | "whatsapp">("instagram");

  const filtered = conversations.filter((c) => getChannel(c.igsid) === tab);

  const igCount = conversations.filter((c) => getChannel(c.igsid) === "instagram").length;
  const fbCount = conversations.filter((c) => getChannel(c.igsid) === "facebook").length;
  const waCount = conversations.filter((c) => getChannel(c.igsid) === "whatsapp").length;

  return (
    <aside className="w-80 bg-gray-900 border-r border-gray-800 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-white font-bold text-lg">OzziFloors Agent</h1>
        <p className="text-gray-400 text-xs mt-0.5">AI Sales Dashboard</p>
      </div>

      {/* Platform tabs */}
      <div className="flex border-b border-gray-800">
        <button
          onClick={() => setTab("instagram")}
          className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
            tab === "instagram"
              ? "text-white border-b-2 border-purple-500 bg-gray-800"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
          </svg>
          Instagram
          {igCount > 0 && (
            <span className="bg-purple-600 text-white text-xs px-1.5 py-0.5 rounded-full">{igCount}</span>
          )}
        </button>
        <button
          onClick={() => setTab("facebook")}
          className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
            tab === "facebook"
              ? "text-white border-b-2 border-blue-500 bg-gray-800"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
          </svg>
          Messenger
          {fbCount > 0 && (
            <span className="bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded-full">{fbCount}</span>
          )}
        </button>
        <button
          onClick={() => setTab("whatsapp")}
          className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
            tab === "whatsapp"
              ? "text-white border-b-2 border-green-500 bg-gray-800"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          WhatsApp
          {waCount > 0 && (
            <span className="bg-green-600 text-white text-xs px-1.5 py-0.5 rounded-full">{waCount}</span>
          )}
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="p-6 text-center text-gray-500 text-sm">
            {tab === "facebook" ? "No Messenger conversations yet" : tab === "whatsapp" ? "No WhatsApp conversations yet" : "No Instagram conversations yet"}
          </div>
        )}
        {filtered.map((conv) => {
          const isSelected = conv.id === selectedId;
          const channel = getChannel(conv.igsid);
          const borderColor = channel === "facebook" ? "border-l-blue-500" : channel === "whatsapp" ? "border-l-green-500" : "border-l-purple-500";
          const avatarGradient = channel === "facebook" ? "from-blue-500 to-blue-700" : channel === "whatsapp" ? "from-green-500 to-green-700" : "from-purple-500 to-pink-500";
          const agentDot = channel === "facebook" ? "bg-blue-500" : channel === "whatsapp" ? "bg-green-500" : "bg-purple-500";
          const fallbackLabel = channel === "facebook" ? "Messenger User" : channel === "whatsapp" ? "WhatsApp User" : conv.igsid;
          const subLabel = channel === "facebook" ? "Messenger" : channel === "whatsapp" ? "WhatsApp" : `@${conv.username}`;
          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv)}
              className={`w-full text-left p-4 flex items-center gap-3 hover:bg-gray-800 transition-colors border-l-2 ${
                isSelected ? `${borderColor} bg-gray-800` : "border-l-transparent"
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
                  <div className={`w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-bold bg-gradient-to-br ${avatarGradient}`}>
                    {getInitials(conv.name, conv.username)}
                  </div>
                )}
                <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-gray-900 ${
                  conv.mode === "agent" ? agentDot : "bg-amber-500"
                }`} />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-white text-sm font-medium truncate">
                    {conv.name ?? conv.username ?? fallbackLabel}
                  </span>
                  <span className="text-gray-500 text-xs ml-2 flex-shrink-0">
                    {timeAgo(conv.last_message_at ?? conv.updated_at)}
                  </span>
                </div>
                {(conv.username || channel !== "instagram") && (
                  <p className="text-gray-400 text-xs truncate">{subLabel}</p>
                )}
                {conv.last_message && (
                  <p className={`text-xs truncate mt-0.5 ${(unreadMap[conv.id] ?? 0) > 0 ? "text-white font-medium" : "text-gray-500"}`}>
                    {conv.last_message}
                  </p>
                )}
              </div>

              {/* Unread badge */}
              {(unreadMap[conv.id] ?? 0) > 0 && (
                <span className="flex-shrink-0 bg-red-500 text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center ml-1">
                  {unreadMap[conv.id]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
