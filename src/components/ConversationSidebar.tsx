"use client";

import { useState } from "react";
import Image from "next/image";
import { ConversationWithLastMessage } from "@/lib/types";
import {
  CHANNELS,
  CHANNEL_LABEL,
  CHANNEL_TINT,
  getChannel,
  getInitials,
  displayName,
  waPhoneDigits,
  formatPhone,
  type Channel,
} from "@/lib/channel";
import {
  parseSearchQuery,
  matchConversationLocally,
  highlightSegments,
  mergeMatches,
  scoreOf,
  cleanClientText,
  snippetAround,
  MATCH_LABEL,
  type ParsedQuery,
  type SearchMatch,
} from "@/lib/conversation-search";
import ChannelIcon from "@/components/ChannelIcon";
import { useConversationSearch } from "@/components/useConversationSearch";

// Lista de conversas (04/11/2026, skill dashboard-design aplicada):
//  - a BUSCA fica no topo e cobre todos os canais: nome do perfil, telefone em
//    qualquer formato, endereço/ZIP ou trecho de mensagem; o que bateu aparece
//    destacado em cada resultado, com o rótulo da fonte (telefone, endereço…);
//  - fora da busca, abas por canal (controle segmentado que encolhe, não rola);
//  - seleção = tinta suave + anel fino; não lida = contador no acento; IA
//    pausada = anel âmbar no avatar (cor só onde precisa de gente);
//  - estados: esqueleto ao carregar, uma nota de erro mantendo a lista antiga,
//    vazio com a dica do que fazer.

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function subLine(conv: ConversationWithLastMessage, channel: Channel): string | null {
  if (channel === "instagram") return conv.username ? `@${conv.username}` : null;
  if (channel === "whatsapp") {
    const phone = formatPhone(waPhoneDigits(conv.igsid));
    return phone && phone !== conv.name ? phone : null;
  }
  return null;
}

function Highlighted({ text, q }: { text: string; q: ParsedQuery }) {
  return (
    <>
      {highlightSegments(text, q).map((s, i) =>
        s.hit ? (
          <mark key={i} className="bg-accent/25 text-ink rounded-[3px] px-px">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  );
}

/** Uma linha de match: rótulo da fonte + trecho recortado em volta do que bateu. */
function MatchLine({ m, q }: { m: SearchMatch; q: ParsedQuery }) {
  // "visita": "12/10 13:00 — nome · telefone · endereço" → data fica, o resto é recortado.
  const dash = m.kind === "visita" ? m.text.indexOf(" — ") : -1;
  const prefix = dash > 0 ? m.text.slice(0, dash) : null;
  const body = dash > 0 ? m.text.slice(dash + 3) : m.text;
  const shown = m.kind === "nome" ? body : snippetAround(body, q, 20);
  return (
    <p className="flex items-center gap-1.5 mt-0.5 text-[12px] text-ink-2 leading-snug min-w-0">
      <span className="shrink-0 text-[10px] font-medium text-muted ring-1 ring-inset ring-line rounded px-1 leading-4">
        {MATCH_LABEL[m.kind]}
      </span>
      <span className="truncate">
        {prefix && <span className="text-muted tabular-nums">{prefix} · </span>}
        <Highlighted text={shown} q={q} />
      </span>
    </p>
  );
}

function Avatar({
  conv,
  channel,
  showChannel,
}: {
  conv: ConversationWithLastMessage;
  channel: Channel;
  showChannel: boolean;
}) {
  const tint = CHANNEL_TINT[channel];
  const paused = conv.mode === "human";
  return (
    <div className="relative shrink-0" aria-label={paused ? "IA pausada nesta conversa" : undefined} title={paused ? "IA pausada — atendimento manual" : undefined}>
      {conv.profile_pic ? (
        <Image
          src={conv.profile_pic}
          alt=""
          width={40}
          height={40}
          className={`w-10 h-10 rounded-full object-cover ${paused ? "ring-2 ring-warn" : ""}`}
          unoptimized
        />
      ) : (
        <div
          className={`w-10 h-10 rounded-full grid place-items-center text-[13px] font-semibold ${tint.bg} ${tint.text} ${
            paused ? "ring-2 ring-warn" : ""
          }`}
        >
          {getInitials(conv.name, conv.username)}
        </div>
      )}
      {showChannel && (
        <span
          title={CHANNEL_LABEL[channel]}
          className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-page grid place-items-center ${tint.text}`}
        >
          <ChannelIcon channel={channel} className="w-3 h-3" />
        </span>
      )}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden className="space-y-px animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="px-2.5 py-2.5 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-soft shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 rounded bg-soft w-1/2" />
            <div className="h-2.5 rounded bg-soft w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface Props {
  /** null = primeira carga ainda não chegou. */
  conversations: ConversationWithLastMessage[] | null;
  listError: string | null;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (conv: ConversationWithLastMessage) => void;
  unreadMap?: Record<string, number>;
}

type Row = { conv: ConversationWithLastMessage; matches: SearchMatch[]; score: number };

export default function ConversationSidebar({
  conversations,
  listError,
  onRetry,
  selectedId,
  onSelect,
  unreadMap = {},
}: Props) {
  const [tab, setTab] = useState<Channel>("instagram");
  const [query, setQuery] = useState("");

  const parsed = parseSearchQuery(query);
  const searching = parsed.mode !== "none";
  const server = useConversationSearch(query);
  const loaded = conversations ?? [];

  const counts: Record<Channel, number> = { instagram: 0, facebook: 0, whatsapp: 0 };
  for (const c of loaded) counts[getChannel(c.igsid)]++;

  let rows: Row[];
  if (!searching) {
    rows = loaded.filter((c) => getChannel(c.igsid) === tab).map((conv) => ({ conv, matches: [], score: 0 }));
  } else {
    const map = new Map<string, Row>();
    for (const conv of loaded) {
      const m = matchConversationLocally(conv, parsed);
      if (m) map.set(conv.id, { conv, matches: [m], score: 0 });
    }
    for (const r of server.results) {
      const existing = map.get(r.conversation.id);
      const conv = existing?.conv ?? loaded.find((c) => c.id === r.conversation.id) ?? r.conversation;
      map.set(r.conversation.id, { conv, matches: mergeMatches(existing?.matches, r.matches), score: 0 });
    }
    const t = (c: ConversationWithLastMessage) => new Date(c.last_message_at ?? c.updated_at).getTime();
    rows = [...map.values()]
      .map((r) => ({ ...r, score: scoreOf(r.matches) }))
      .sort((a, b) => b.score - a.score || t(b.conv) - t(a.conv));
  }

  const resultWord = rows.length === 1 ? "resultado" : "resultados";

  return (
    <aside className="w-full flex flex-col h-full min-h-0 bg-side">
      {/* Busca — o que o dono mais usa fica em cima, à esquerda */}
      <div className="shrink-0 px-3 pt-3 pb-2">
        <label className="relative block">
          <span className="sr-only">Buscar cliente por nome, telefone ou endereço</span>
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
            placeholder="Nome, telefone ou endereço"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className="w-full h-10 rounded-xl bg-card border border-line pl-9 pr-9 text-base lg:text-[14px] text-ink placeholder:text-muted outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 transition-colors"
          />
          {query && (
            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center">
              {server.status === "loading" ? (
                <span
                  role="status"
                  aria-label="Buscando no histórico"
                  className="w-7 h-7 grid place-items-center text-muted"
                >
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-line-strong border-t-accent animate-spin" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Limpar busca"
                  title="Limpar busca (Esc)"
                  className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-soft transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </span>
          )}
        </label>
        {searching && (
          <p className="flex flex-wrap items-center gap-x-1.5 px-1 pt-2 text-[12px] text-muted tabular-nums" aria-live="polite">
            <span>{rows.length} {resultWord} · todos os canais</span>
            {server.status === "error" && (
              <span className="text-down" title="A busca no histórico de mensagens e na agenda falhou; só o que já está na lista foi conferido.">· histórico indisponível</span>
            )}
            {server.status === "ok" && server.partial && (
              <span className="text-warn" title="Uma das fontes (agenda ou funil) não respondeu; o resultado pode estar incompleto.">· parcial</span>
            )}
          </p>
        )}
      </div>

      {/* Abas por canal — somem na busca, que cobre todos os canais */}
      {!searching && (
        <div role="tablist" aria-label="Canal" className="flex shrink-0 gap-1 px-3 pb-2">
          {CHANNELS.map((ch) => {
            const active = tab === ch;
            return (
              <button
                key={ch}
                role="tab"
                aria-selected={active}
                title={CHANNEL_LABEL[ch]}
                onClick={() => setTab(ch)}
                className={`flex-1 min-w-0 h-9 flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-accent/[.08] text-ink ring-1 ring-inset ring-accent/20"
                    : "text-muted hover:bg-soft hover:text-ink-2"
                }`}
              >
                <ChannelIcon channel={ch} className={`w-4 h-4 shrink-0 ${active ? CHANNEL_TINT[ch].text : ""}`} />
                <span className="hidden sm:inline lg:hidden xl:inline truncate">{CHANNEL_LABEL[ch]}</span>
                {counts[ch] > 0 && (
                  <span className={`tabular-nums text-[11px] leading-none ${active ? "text-ink-2" : "text-muted"}`}>{counts[ch]}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {listError && (
        <div role="alert" className="mx-3 mb-2 shrink-0 flex items-center justify-between gap-2 rounded-lg bg-down/10 text-down text-[12px] px-3 py-2">
          <span>{listError}</span>
          <button type="button" onClick={onRetry} className="font-medium underline-offset-2 hover:underline shrink-0">
            Tentar de novo
          </button>
        </div>
      )}

      {/* Lista */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations === null && !listError && <SkeletonRows />}

        {conversations !== null && rows.length === 0 && (
          <div className="px-6 py-12 text-center">
            <p className="text-ink-2 text-[14px] font-medium">
              {searching ? `Nenhum cliente com “${parsed.raw}”` : `Nenhuma conversa no ${CHANNEL_LABEL[tab]} ainda`}
            </p>
            <p className="text-muted text-[13px] mt-1.5 leading-relaxed">
              {searching
                ? server.status === "loading"
                  ? "Conferindo o histórico de mensagens e a agenda…"
                  : "Tente só os 4 últimos dígitos do telefone, o número da casa ou o @ do perfil."
                : "As conversas aparecem aqui assim que um cliente mandar mensagem."}
            </p>
          </div>
        )}

        <ul data-list="conversations" aria-label={searching ? "Resultados da busca" : `Conversas no ${CHANNEL_LABEL[tab]}`} className="space-y-px">
        {rows.map(({ conv, matches }) => {
          const isSelected = conv.id === selectedId;
          const channel = getChannel(conv.igsid);
          const unread = unreadMap[conv.id] ?? 0;
          const last = cleanClientText(conv.last_message);
          const sub = subLine(conv, channel);
          return (
            <li key={conv.id}>
            <button
              type="button"
              aria-current={isSelected ? "true" : undefined}
              onClick={() => onSelect(conv)}
              className={`w-full text-left px-2.5 py-2.5 flex items-start gap-3 rounded-xl transition-colors ${
                isSelected ? "bg-accent/[.07] ring-1 ring-inset ring-accent/20" : "hover:bg-soft/70 active:bg-soft"
              }`}
            >
              <Avatar conv={conv} channel={channel} showChannel={searching} />

              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-[14px] truncate text-ink ${unread > 0 ? "font-semibold" : "font-medium"}`}>
                    {displayName(conv, channel)}
                  </span>
                  <span className="text-muted text-[11px] shrink-0 tabular-nums">
                    {timeAgo(conv.last_message_at ?? conv.updated_at)}
                  </span>
                </div>

                {searching ? (
                  matches.slice(0, 2).map((m, i) => <MatchLine key={i} m={m} q={parsed} />)
                ) : (
                  <>
                    {sub && <p className="text-muted text-[12px] truncate leading-snug tabular-nums">{sub}</p>}
                    {last && (
                      <p className={`text-[13px] truncate mt-0.5 ${unread > 0 ? "text-ink-2 font-medium" : "text-muted"}`}>{last}</p>
                    )}
                  </>
                )}
              </div>

              {unread > 0 && (
                <span
                  aria-label={`${unread} ${unread === 1 ? "mensagem nova" : "mensagens novas"}`}
                  className="shrink-0 mt-0.5 bg-accent text-on-accent text-[11px] font-semibold min-w-5 h-5 px-1.5 rounded-full grid place-items-center tabular-nums"
                >
                  {unread}
                </span>
              )}
            </button>
            </li>
          );
        })}
        </ul>
      </div>
    </aside>
  );
}
