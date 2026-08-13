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
  if (mins < 1) return "agora";
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

type Channel = "instagram" | "facebook" | "whatsapp";

const CHANNEL_META: Record<Channel, {
  label: string;
  activeText: string;
  indicator: string;
  countBg: string;
  avatarGradient: string;
  agentDot: string;
  selectedRing: string;
}> = {
  instagram: {
    label: "Instagram",
    activeText: "text-fuchsia-300",
    indicator: "bg-fuchsia-500",
    countBg: "bg-fuchsia-500/15 text-fuchsia-300",
    avatarGradient: "from-purple-500 to-pink-500",
    agentDot: "bg-fuchsia-400",
    selectedRing: "ring-fuchsia-500/30",
  },
  facebook: {
    label: "Messenger",
    activeText: "text-sky-300",
    indicator: "bg-sky-500",
    countBg: "bg-sky-500/15 text-sky-300",
    avatarGradient: "from-sky-500 to-blue-600",
    agentDot: "bg-sky-400",
    selectedRing: "ring-sky-500/30",
  },
  whatsapp: {
    label: "WhatsApp",
    activeText: "text-emerald-300",
    indicator: "bg-emerald-500",
    countBg: "bg-emerald-500/15 text-emerald-300",
    avatarGradient: "from-emerald-500 to-green-600",
    agentDot: "bg-emerald-400",
    selectedRing: "ring-emerald-500/30",
  },
};

function ChannelIcon({ channel, className }: { channel: Channel; className?: string }) {
  if (channel === "instagram") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
      </svg>
    );
  }
  if (channel === "facebook") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 0C5.24 0 0 4.952 0 11.64c0 3.499 1.434 6.522 3.769 8.61a.96.96 0 01.323.683l.065 2.135a.96.96 0 001.347.849l2.381-1.051a.96.96 0 01.641-.047 13.07 13.07 0 003.474.468c6.76 0 12-4.952 12-11.64C24 4.952 18.76 0 12 0zm7.207 8.957l-3.525 5.593a1.8 1.8 0 01-2.604.48l-2.804-2.103a.72.72 0 00-.868.002l-3.786 2.874c-.505.383-1.165-.221-.826-.759l3.525-5.593a1.8 1.8 0 012.604-.48l2.804 2.103a.72.72 0 00.868-.002l3.786-2.874c.505-.383 1.165.221.826.759z"/>
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}

interface Props {
  conversations: ConversationWithLastMessage[];
  selectedId: string | null;
  onSelect: (conv: ConversationWithLastMessage) => void;
  unreadMap?: Record<string, number>;
}

export default function ConversationSidebar({ conversations, selectedId, onSelect, unreadMap = {} }: Props) {
  const [tab, setTab] = useState<Channel>("instagram");
  const [query, setQuery] = useState("");

  const counts: Record<Channel, number> = {
    instagram: conversations.filter((c) => getChannel(c.igsid) === "instagram").length,
    facebook: conversations.filter((c) => getChannel(c.igsid) === "facebook").length,
    whatsapp: conversations.filter((c) => getChannel(c.igsid) === "whatsapp").length,
  };

  const q = query.trim().toLowerCase();
  const filtered = conversations
    .filter((c) => getChannel(c.igsid) === tab)
    .filter((c) => {
      if (!q) return true;
      return (
        (c.name ?? "").toLowerCase().includes(q) ||
        (c.username ?? "").toLowerCase().includes(q) ||
        (c.last_message ?? "").toLowerCase().includes(q)
      );
    });

  return (
    <aside className="w-full flex flex-col h-full min-h-0">
      {/* Channel tabs */}
      <div className="flex shrink-0 border-b border-white/[0.06] px-2 pt-1">
        {(Object.keys(CHANNEL_META) as Channel[]).map((ch) => {
          const meta = CHANNEL_META[ch];
          const active = tab === ch;
          return (
            <button
              key={ch}
              onClick={() => setTab(ch)}
              className={`relative flex-1 min-w-0 h-11 flex items-center justify-center gap-1.5 text-xs font-semibold rounded-t-lg transition-colors ${
                active ? `${meta.activeText} bg-white/[0.04]` : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <ChannelIcon channel={ch} className="w-4 h-4" />
              <span className="hidden sm:inline lg:hidden xl:inline truncate">{meta.label}</span>
              {counts[ch] > 0 && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${meta.countBg}`}>
                  {counts[ch]}
                </span>
              )}
              {active && <span className={`absolute bottom-0 inset-x-3 h-0.5 rounded-full ${meta.indicator}`} />}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="shrink-0 px-3 pt-3 pb-1.5">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar conversa..."
            className="w-full h-10 rounded-xl bg-zinc-900 border border-white/[0.08] pl-9 pr-3 text-base lg:text-sm text-white placeholder:text-zinc-500 outline-none focus:border-fuchsia-500/40 focus:ring-2 focus:ring-fuchsia-500/15 transition-colors"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5 space-y-0.5">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center animate-fade-in">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.06] grid place-items-center text-zinc-500">
              <ChannelIcon channel={tab} className="w-6 h-6" />
            </div>
            <p className="text-zinc-400 text-sm">
              {q
                ? "Nenhuma conversa encontrada para essa busca"
                : `Nenhuma conversa no ${CHANNEL_META[tab].label} ainda`}
            </p>
          </div>
        )}
        {filtered.map((conv) => {
          const isSelected = conv.id === selectedId;
          const channel = getChannel(conv.igsid);
          const meta = CHANNEL_META[channel];
          const unread = unreadMap[conv.id] ?? 0;
          const fallbackLabel = channel === "facebook" ? "Cliente Messenger" : channel === "whatsapp" ? "Cliente WhatsApp" : conv.igsid;
          const subLabel = channel === "instagram" ? (conv.username ? `@${conv.username}` : null) : meta.label;
          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv)}
              className={`w-full text-left px-2.5 py-2.5 flex items-center gap-3 rounded-xl transition-colors ${
                isSelected
                  ? `bg-white/[0.07] ring-1 ${meta.selectedRing}`
                  : "hover:bg-white/[0.04] active:bg-white/[0.06]"
              }`}
            >
              {/* Avatar */}
              <div className="relative shrink-0">
                {conv.profile_pic ? (
                  <Image
                    src={conv.profile_pic}
                    alt={conv.name ?? "Cliente"}
                    width={44}
                    height={44}
                    className="w-11 h-11 rounded-full object-cover"
                    unoptimized
                  />
                ) : (
                  <div className={`w-11 h-11 rounded-full grid place-items-center text-white text-sm font-bold bg-gradient-to-br ${meta.avatarGradient}`}>
                    {getInitials(conv.name, conv.username)}
                  </div>
                )}
                <span
                  title={conv.mode === "agent" ? "IA respondendo" : "Atendimento manual"}
                  className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-zinc-950 ${
                    conv.mode === "agent" ? meta.agentDot : "bg-amber-400"
                  }`}
                />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-sm truncate ${unread > 0 ? "text-white font-semibold" : "text-zinc-100 font-medium"}`}>
                    {conv.name ?? conv.username ?? fallbackLabel}
                  </span>
                  <span className="text-zinc-500 text-[11px] shrink-0 tabular-nums">
                    {timeAgo(conv.last_message_at ?? conv.updated_at)}
                  </span>
                </div>
                {subLabel && (
                  <p className="text-zinc-500 text-[11px] truncate leading-tight">{subLabel}</p>
                )}
                {conv.last_message && (
                  <p className={`text-xs truncate mt-0.5 ${unread > 0 ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>
                    {conv.last_message}
                  </p>
                )}
              </div>

              {/* Unread badge */}
              {unread > 0 && (
                <span className="shrink-0 bg-red-600 text-white text-[11px] font-bold min-w-[20px] h-5 px-1 rounded-full grid place-items-center">
                  {unread}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
