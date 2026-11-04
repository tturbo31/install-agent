"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationWithLastMessage } from "@/lib/types";
import { parseSearchQuery, type SearchMatch } from "@/lib/conversation-search";

export interface ServerSearchResult {
  conversation: ConversationWithLastMessage;
  matches: SearchMatch[];
}

export interface ServerSearchState {
  status: "idle" | "loading" | "ok" | "error";
  results: ServerSearchResult[];
  /** Alguma fonte (agenda, funil…) falhou: resultado incompleto. */
  partial: boolean;
}

const IDLE: ServerSearchState = { status: "idle", results: [], partial: false };

/**
 * Busca no servidor com atraso de 250 ms depois da última tecla; uma resposta
 * que chega depois de uma busca mais nova é ignorada (snippets.md → stale).
 * Os resultados antigos ficam na tela enquanto os novos carregam.
 */
export function useConversationSearch(query: string): ServerSearchState {
  const [state, setState] = useState<ServerSearchState>(IDLE);
  const seq = useRef(0);

  useEffect(() => {
    const parsed = parseSearchQuery(query);
    if (parsed.mode === "none") {
      seq.current++;
      setState(IDLE);
      return;
    }
    const n = ++seq.current;
    setState((s) => ({ ...s, status: "loading" }));
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(parsed.raw)}`);
        if (n !== seq.current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { results?: ServerSearchResult[]; partial?: boolean };
        if (n !== seq.current) return;
        setState({ status: "ok", results: data.results ?? [], partial: !!data.partial });
      } catch {
        if (n === seq.current) setState((s) => ({ ...s, status: "error" }));
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return state;
}
