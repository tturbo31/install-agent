"use client";

import Image from "next/image";
import { ConversationWithLastMessage } from "@/lib/types";
import { CHANNEL_LABEL, CHANNEL_TINT, getChannel, getInitials, displayName, waPhoneDigits, formatPhone } from "@/lib/channel";

interface Props {
  conversation: ConversationWithLastMessage;
  onToggleMode: () => void;
  isTogglingMode: boolean;
  onBack?: () => void;
}

export default function ChatHeader({ conversation, onToggleMode, isTogglingMode, onBack }: Props) {
  const isAgent = conversation.mode === "agent";
  const channel = getChannel(conversation.igsid);
  const tint = CHANNEL_TINT[channel];
  const phone = formatPhone(waPhoneDigits(conversation.igsid));

  // Mesmo nome da lista (channel.ts → displayName): nunca o id cru quando há algo melhor.
  const title = displayName(conversation, channel);
  const details: string[] = [];
  if (channel === "instagram") {
    if (conversation.username && conversation.username !== title) details.push(`@${conversation.username}`);
    if (conversation.follower_count != null) details.push(`${conversation.follower_count.toLocaleString("pt-BR")} seguidores`);
  } else if (channel === "whatsapp") {
    if (phone && phone !== title) details.push(phone);
    details.push(CHANNEL_LABEL.whatsapp);
  } else if (conversation.name || conversation.username) {
    details.push(CHANNEL_LABEL.facebook); // sem nome o título já diz "Cliente Messenger"
  }

  return (
    <header className="shrink-0 h-14 lg:h-16 bg-page border-b border-line pl-2 pr-3 sm:px-4 flex items-center gap-2 sm:gap-3">
      {/* Voltar para a lista — só no celular */}
      {onBack && (
        <button
          onClick={onBack}
          aria-label="Voltar para a lista de conversas"
          className="lg:hidden shrink-0 w-10 h-10 grid place-items-center rounded-xl text-ink-2 hover:text-ink hover:bg-soft transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
      )}

      {/* Identidade */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {conversation.profile_pic ? (
          <Image
            src={conversation.profile_pic}
            alt=""
            width={40}
            height={40}
            className="w-10 h-10 rounded-full object-cover shrink-0"
            unoptimized
          />
        ) : (
          <div className={`w-10 h-10 rounded-full grid place-items-center text-[13px] font-semibold shrink-0 ${tint.bg} ${tint.text}`}>
            {getInitials(conversation.name, conversation.username)}
          </div>
        )}

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-ink font-semibold text-[14px] tracking-tight truncate">{title}</h2>
            {/* No celular as decorações somem antes de o nome cortar (layout.md → phones) */}
            {conversation.is_user_follow_business && (
              <span className="hidden sm:inline shrink-0 text-[11px] font-medium bg-accent/10 text-accent px-2 py-0.5 rounded-full">
                te segue
              </span>
            )}
          </div>
          <div className="text-[12px] text-muted truncate tabular-nums">
            {details[0]}
            {details.slice(1).map((d) => (
              <span key={d} className="hidden sm:inline"> · {d}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Estado da IA + controle desta conversa */}
      <div className="flex items-center gap-2.5 shrink-0">
        <span
          className={`hidden md:flex items-center gap-1.5 text-[12px] font-medium px-2.5 h-7 rounded-full ${
            isAgent ? "text-muted" : "bg-warn/10 text-warn"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${isAgent ? "bg-up" : "bg-warn"}`} />
          {isAgent ? "IA ativa" : "IA pausada"}
        </span>

        <button
          onClick={onToggleMode}
          disabled={isTogglingMode}
          title={
            isAgent
              ? "Pausar a IA só nesta conversa: você passa a responder."
              : "Ligar a IA de novo nesta conversa."
          }
          className={`h-9 px-3.5 sm:px-4 rounded-xl text-[13px] font-semibold transition-colors disabled:opacity-60 whitespace-nowrap ${
            isAgent ? "bg-warn text-on-warn hover:brightness-110" : "bg-accent text-on-accent hover:brightness-110"
          }`}
        >
          {isTogglingMode ? "…" : isAgent ? "Pausar IA" : "Reativar IA"}
        </button>
      </div>
    </header>
  );
}
