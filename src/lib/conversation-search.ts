// ─── BUSCA DE CLIENTE NO PAINEL (04/11/2026) ────────────────────────────────
//
// O dono precisa achar a conversa pelo que o CLIENTE mandou: telefone (em
// qualquer formato, até só os 4 últimos dígitos), endereço/ZIP, nome do perfil
// ou um trecho de mensagem — em todos os canais de uma vez. Este arquivo é a
// parte PURA (sem banco, sem React): interpretar a busca, casar localmente com
// o que já está na tela, destacar o trecho que bateu e montar o recorte.
// A rota /api/conversations/search usa as mesmas funções para o histórico.
// Testado em src/evals/conversation-search-verify.ts.

import { waPhoneDigits, formatPhone } from "./channel";

export type SearchMode = "none" | "phone" | "text";

export interface ParsedQuery {
  raw: string;
  mode: SearchMode;
  /** Só os dígitos da busca (modo telefone: o que se procura). */
  digits: string;
  /** Palavras normalizadas (modo texto), sem caracteres reservados do PostgREST. */
  words: string[];
}

export type MatchKind = "telefone" | "endereco" | "nome" | "visita" | "mensagem";

export interface SearchMatch {
  kind: MatchKind;
  /** Trecho onde a busca bateu (já limpo de [SYSTEM:] etc.). */
  text: string;
  /** Quando foi dito/marcado (ISO), se houver. */
  at?: string | null;
}

export const MATCH_LABEL: Record<MatchKind, string> = {
  telefone: "telefone",
  endereco: "endereço",
  nome: "nome",
  visita: "visita",
  mensagem: "mensagem",
};

// Peso para ordenar: dado de identificação (telefone, visita, endereço) acima
// de nome, que fica acima de mensagem solta.
export const MATCH_SCORE: Record<MatchKind, number> = {
  telefone: 50,
  visita: 45,
  endereco: 40,
  nome: 30,
  mensagem: 10,
};

/** Limpa injeções internas antes de mostrar/buscar texto do cliente. */
export function cleanClientText(content: string | null | undefined): string {
  return (content ?? "")
    .replace(/\[Floor plan analysis:[\s\S]*?\]/g, "[planta]")
    .replace(/\[SYSTEM:[\s\S]*?\]/g, "")
    .replace(/\[Voice:[\s\S]*?\]/g, "[áudio]")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tira acento mantendo o MESMO comprimento (índices alinhados com o original). */
export function foldAccents(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch.length > 1) { out += ch; continue; } // emoji/surrogate: não mexe
    const base = ch.normalize("NFD")[0];
    out += base.length === 1 ? base : ch;
  }
  return out;
}

/** Palavra segura para ILIKE dentro de or=(…) do PostgREST: sem , . ( ) " % _ * \ : */
export function sanitizeWord(w: string): string {
  return w.replace(/[,.()"'%_*\\:]/g, "").trim();
}

/** Regex (POSIX e JS) que acha os dígitos em ordem, com qualquer coisa que não seja dígito no meio. */
export function digitsPattern(digits: string): string {
  return digits.split("").join("[^0-9]*");
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const q = (raw ?? "").trim();
  const digits = q.replace(/\D/g, "");
  const letters = (q.match(/\p{L}/gu) ?? []).length;
  if (q.length < 2) return { raw: q, mode: "none", digits, words: [] };
  // "954 123 4567", "(561) 674-8334", "8334", "33056": número puro → procura os dígitos em ordem.
  if (digits.length >= 4 && letters < 3) return { raw: q, mode: "phone", digits, words: [] };
  // Ponto e vírgula separam palavras: "jose.silva" (um @) acha "José Silva" e "jose.silva".
  const words = foldAccents(q.toLowerCase())
    .split(/[\s.,;]+/)
    .map(sanitizeWord)
    .filter((w) => w.length >= 2 || /^\d+$/.test(w));
  if (words.length === 0) return { raw: q, mode: "none", digits, words: [] };
  return { raw: q, mode: "text", digits, words };
}

/** Todas as palavras aparecem no texto (sem acento, sem caixa)? */
export function textHasAllWords(text: string | null | undefined, words: string[]): boolean {
  if (!text || words.length === 0) return false;
  const folded = foldAccents(text.toLowerCase());
  return words.every((w) => folded.includes(w));
}

export function textHasDigits(text: string | null | undefined, digits: string): boolean {
  if (!text || !digits) return false;
  return text.replace(/\D/g, "").includes(digits);
}

// Endereço de rua ou ZIP da Flórida: só decide o RÓTULO do match ("endereço"
// em vez de "mensagem"); nunca filtra nada.
const STREET_RE = /\b\d{1,6}\s*(?:[nsew]\.?\s*)?[a-z0-9]+(?:\s+[a-z0-9.]+){0,4}\s*\b(?:st|street|ave|avenue|rd|road|dr|drive|ct|court|ln|lane|blvd|boulevard|way|pl|place|ter|terrace|cir|circle|hwy|pkwy|trail|trl|loop)\b/i;
const ZIP_RE = /\b3[0-4]\d{3}\b/;
export function looksLikeAddress(text: string): boolean {
  return STREET_RE.test(text) || ZIP_RE.test(text);
}

const PHONE_SPAN_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
/** Busca por dígitos: os dígitos estão dentro de um telefone? Senão, endereço/ZIP; senão, só mensagem. */
export function classifyDigitsMatch(clean: string, digits: string): MatchKind {
  for (const m of clean.matchAll(PHONE_SPAN_RE)) {
    if (m[0].replace(/\D/g, "").includes(digits)) return "telefone";
  }
  return looksLikeAddress(clean) ? "endereco" : "mensagem";
}

export interface LocalRow {
  igsid: string;
  name: string | null;
  username: string | null;
  last_message: string | null;
  last_message_at?: string | null;
}

/** Match com o que já está carregado na lista (nome, @, número do WhatsApp, última mensagem). */
export function matchConversationLocally(row: LocalRow, q: ParsedQuery): SearchMatch | null {
  if (q.mode === "none") return null;
  if (q.mode === "phone") {
    const wa = waPhoneDigits(row.igsid);
    if (wa && wa.includes(q.digits)) return { kind: "telefone", text: formatPhone(wa) };
    const last = cleanClientText(row.last_message);
    if (textHasDigits(last, q.digits)) return { kind: classifyDigitsMatch(last, q.digits), text: last, at: row.last_message_at };
    return null;
  }
  const profile = `${row.name ?? ""} ${row.username ?? ""}`;
  if (textHasAllWords(profile, q.words)) return { kind: "nome", text: (row.name ?? row.username ?? "").trim() };
  const last = cleanClientText(row.last_message);
  if (textHasAllWords(last, q.words)) return { kind: looksLikeAddress(last) ? "endereco" : "mensagem", text: last, at: row.last_message_at };
  return null;
}

export interface Segment { text: string; hit: boolean }

/** Divide o texto em trechos marcando onde a busca bateu (para o <mark>). */
export function highlightSegments(text: string, q: ParsedQuery): Segment[] {
  if (!text) return [];
  if (q.mode === "none") return [{ text, hit: false }];
  const ranges: Array<[number, number]> = [];
  if (q.mode === "phone") {
    const re = new RegExp(digitsPattern(q.digits), "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  } else {
    const folded = foldAccents(text.toLowerCase());
    for (const w of q.words) {
      let from = 0;
      while (from <= folded.length) {
        const i = folded.indexOf(w, from);
        if (i < 0) break;
        ranges.push([i, i + w.length]);
        from = i + Math.max(1, w.length);
      }
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: text.slice(pos, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** Recorte curto em volta do primeiro trecho que bateu ("…105 Bandol St, Port St…"). */
export function snippetAround(text: string, q: ParsedQuery, radius = 48): string {
  const clean = cleanClientText(text);
  if (clean.length <= radius + 10) return clean;
  const segs = highlightSegments(clean, q);
  let idx = 0;
  for (const s of segs) {
    if (s.hit) break;
    idx += s.text.length;
  }
  const hitLen = segs.find((s) => s.hit)?.text.length ?? 0;
  if (hitLen === 0) return clean.slice(0, radius * 2) + (clean.length > radius * 2 ? "…" : "");
  // Janela de ~2×radius em volta do trecho; se o trecho está perto do fim, corta o começo
  // (senão a linha truncada da lista esconde justamente o que bateu).
  const start = Math.max(0, idx - radius);
  const end = Math.min(clean.length, Math.max(idx + hitLen + radius, start + 2 * radius + hitLen));
  return (start > 0 ? "…" : "") + clean.slice(start, end) + (end < clean.length ? "…" : "");
}

/** Grupo or=(…) do PostgREST: todas as palavras em UMA das colunas (acento e sem acento). */
export function orGroupAllWords(columns: string[], words: string[]): string {
  const parts = columns.map((col) => {
    const ands = words.map((w) => `${col}.ilike.*${w}*`);
    return ands.length === 1 ? ands[0] : `and(${ands.join(",")})`;
  });
  return parts.join(",");
}

/** igsid guardado no e-mail do booking ("ia-wa_15613037754@instagram.ozzifloors.com"). */
export function igsidFromBookingEmail(email: string | null | undefined): string | null {
  const m = /^ia-([^@]+)@/.exec(email ?? "");
  return m ? m[1] : null;
}

/** Junta matches de várias fontes para a mesma conversa: sem repetir, no máximo 3, mais fortes primeiro. */
export function mergeMatches(...lists: Array<SearchMatch[] | undefined>): SearchMatch[] {
  const seen = new Set<string>();
  const all: SearchMatch[] = [];
  for (const list of lists) {
    for (const m of list ?? []) {
      const key = `${m.kind}|${m.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(m);
    }
  }
  all.sort((a, b) => MATCH_SCORE[b.kind] - MATCH_SCORE[a.kind]);
  return all.slice(0, 3);
}

/** Nota da conversa: o match mais forte manda; cada match extra vale só +1 (duas visitas
 *  remarcadas não passam na frente de visita + endereço). */
export function scoreOf(matches: SearchMatch[]): number {
  if (matches.length === 0) return 0;
  return Math.max(...matches.map((m) => MATCH_SCORE[m.kind])) + (matches.length - 1);
}
