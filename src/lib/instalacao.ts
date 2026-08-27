import { isPureClosing, normalizeSmartPunct } from "@/lib/ai";
import type { Lang } from "@/lib/scheduler";

// ─── Etapa de INSTALAÇÃO (2026-08-25) ────────────────────────────────────────
// Caso Sarah McKnight, 25/08/2026: o aviso de véspera saiu "confirmed for
// Wednesday, August 26 at 5am" — a instalação era às 10am. O texto da data vem
// PRONTO de quem chama /api/confirmar-instalacao (o app operacional no Lovable,
// que dispara todo dia às 13:00 UTC); em 7 dos últimos 30 envios veio "5am",
// um horário em que ninguém instala piso. Duas defesas aqui:
//
//  1. sanitizeInstallDate(): horário fora da janela plausível (7h–19h) NUNCA
//     sai para o cliente — a mensagem vai só com a data e o dono é avisado para
//     confirmar a hora. Não "corrigimos" o horário: não sabemos qual é o certo.
//  2. formatInstallDateTime(): caminho robusto para o integrador mandar o
//     instante em ISO 8601 com fuso (`data_instalacao_iso`); nós formatamos em
//     horário da Flórida e o texto nunca mais depende do relógio de terceiros.
//
// E a regra do dono para a conversa DEPOIS do aviso (mesmo dia, 25/08):
//  • cliente agradece / confirma → só um 👍, nenhuma frase a mais;
//  • qualquer dúvida → uma frase dizendo que vai repassar ao Ozzi, que entra
//    em contato — e o dono é avisado. O bot NÃO responde a dúvida sozinho
//    (foi assim que um "5am???" quase virou conversa do bot com o cliente).

export const INSTALL_HOUR_MIN = 7; // 7am
export const INSTALL_HOUR_MAX = 19; // 7pm
export const INSTALL_TZ = "America/New_York";

// Quantos dias depois do aviso a conversa ainda é "etapa de instalação". Passado
// isso o cliente volta a ser tratado como cliente normal (obra já aconteceu).
export const INSTALL_STAGE_MAX_DAYS = 10;

// "at 5am", "at 5 am", "at 5:30am", "at 5 a.m.", "at 17:00", "às 5h", "a las 5am"
const TIME_TOKEN =
  /\s*(?:\bat|\b[àa]s?|\ba\s+las?)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|h\b)?(?![\d:])/i;

function parseHour24(h: string, ampm: string | undefined): number | null {
  const n = parseInt(h, 10);
  if (!Number.isFinite(n)) return null;
  const suf = (ampm ?? "").replace(/\./g, "").toLowerCase();
  if (suf === "am") return n === 12 ? 0 : n;
  if (suf === "pm") return n === 12 ? 12 : n + 12;
  if (n > 23) return null;
  return n; // "17:00", "5h" (24h, without am/pm)
}

export type SanitizedInstallDate = {
  text: string;
  // O trecho de horário removido ("5am"), ou null quando o texto saiu intacto.
  horarioSuspeito: string | null;
};

// Remove o horário do texto quando ele cai fora de 7h–19h. O resto do texto
// (dia da semana, data) fica como veio. Sem horário → intacto.
export function sanitizeInstallDate(raw: string): SanitizedInstallDate {
  const text = (raw ?? "").trim();
  const m = text.match(TIME_TOKEN);
  if (!m) return { text, horarioSuspeito: null };
  const hour = parseHour24(m[1], m[3]);
  if (hour === null) return { text, horarioSuspeito: null };
  if (hour >= INSTALL_HOUR_MIN && hour <= INSTALL_HOUR_MAX) return { text, horarioSuspeito: null };
  const token = m[0].trim().replace(/^(?:at|[àa]s?|a\s+las?)\s+/i, "");
  const cleaned = (text.slice(0, m.index) + text.slice((m.index ?? 0) + m[0].length))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/[,\s]+$/, "")
    .trim();
  return { text: cleaned || text, horarioSuspeito: token };
}

// Regra do dono 27/08/2026: o aviso de véspera NUNCA leva o horário do job.
// O texto diz que a instalação começa amanhã e que a equipe chega entre 10am e
// 11am com os materiais (INSTALL_ARRIVAL_WINDOW). Qualquer "at 9am"/"at 10:30am"
// que venha do integrador (texto livre ou ISO) é removido — plausível ou não.
export const INSTALL_ARRIVAL_WINDOW = "between 10am and 11am";

export function stripInstallTime(raw: string): string {
  const text = (raw ?? "").trim();
  const m = text.match(TIME_TOKEN);
  if (!m) return text;
  const cleaned = (text.slice(0, m.index) + text.slice((m.index ?? 0) + m[0].length))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/[,\s]+$/, "")
    .trim();
  return cleaned || text;
}

// "2026-08-26T14:00:00.000Z" → "Wednesday, August 26 at 10am" (Flórida).
// Devolve null se o ISO for inválido — o chamador cai no texto livre.
export function formatInstallDateTime(iso: string): string | null {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const d = new Date(iso.trim());
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: INSTALL_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minute = get("minute");
  const ampm = get("dayPeriod").toLowerCase();
  const time = minute === "00" ? `${get("hour")}${ampm}` : `${get("hour")}:${minute}${ampm}`;
  return `${get("weekday")}, ${get("month")} ${get("day")} at ${time}`;
}

// ─── Conversa depois do aviso ─────────────────────────────────────────────────

// Acknowledgment curto que NÃO é pergunta: "ok", "perfect", "sounds good",
// "yes", "got it", "see you tomorrow", um emoji, "👍". Mensagem com "?" ou
// palavra de pergunta nunca é ack.
const ACK_WORDS =
  /^(?:ok(?:ay)?|k|kk|perfect|perfecto|perfeito|great|awesome|cool|sure|yes|yep|yeah|ya|si|sí|sim|claro|dale|vale|listo|got it|noted|sounds? (?:good|great|perfect)|that (?:works|sounds (?:good|great|better))|all good|good|nice|alright|all right|will do|see (?:you|ya)(?: (?:then|tomorrow|soon|there))?|nos vemos(?: mañana)?|até (?:amanhã|lá)|ha+|haha+|lol)[\s!.…]*$/i;
const QUESTION_MARKERS =
  /\?|\b(?:what|when|where|why|which|who|how|can|could|would|will|is|are|do|does|did|should|qué|que|cuándo|cuando|dónde|donde|cómo|como|por qué|porque|puede|pueden|quando|onde|pode|podem)\b/i;

export function isInstallAck(raw: string): boolean {
  const t = normalizeSmartPunct(raw ?? "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  // Só emoji / símbolos (👍, ❤️, 🙏, "!!")
  if (!/[a-z0-9À-ɏ]/i.test(t)) return true;
  if (QUESTION_MARKERS.test(t)) return false;
  if (isPureClosing(t)) return true;
  if (t.length > 60) return false;
  // Junta várias frases curtas de ack: "Perfect! See you tomorrow" / "Ok thanks"
  const chunks = t.split(/[.!,]+\s*|\s{2,}/).map((c) => c.trim()).filter(Boolean);
  if (chunks.length === 0) return false;
  return chunks.every((c) => ACK_WORDS.test(c) || isPureClosing(c));
}

// Frase única, sem pronome para o Ozzi, sem prometer horário ou resposta.
export function installHandoffMessage(lang: Lang): string {
  if (lang === "es") return "Le paso su mensaje a Ozzi, quien se comunicará con usted en breve.";
  if (lang === "pt") return "Vou repassar sua mensagem ao Ozzi, que entrará em contato em breve.";
  return "I'll pass this along to Ozzi, who will get in touch with you shortly.";
}

export const INSTALL_STAGE_ALERT =
  "Cliente em etapa de INSTALACAO respondeu ao aviso. O agente so disse que vai repassar ao Ozzi, nao respondeu a duvida. Responda voce.";

export function installTimeAlert(params: { nome: string | null; horarioSuspeito: string; dataEnviada: string }): string {
  const quem = params.nome ? `${params.nome}` : "o cliente";
  return (
    `AVISO DE INSTALACAO SEM HORARIO: o sistema mandou "${params.horarioSuspeito}" para ${quem}, ` +
    `horario em que ninguem instala. A mensagem foi enviada SO com a data (${params.dataEnviada}). ` +
    `Confirme a hora certa com o cliente e corrija o horario do job no app.`
  );
}

// Reconhece o aviso NOSSO em qualquer versão: "installation is confirmed for"
// (até 26/08/2026) e "installation starts tomorrow" (a partir de 27/08/2026).
export const INSTALL_CONFIRMATION_RE = /installation (?:is confirmed for|starts tomorrow)/i;

// A confirmação ainda vale como "etapa de instalação"? Só se foi enviada por
// NÓS (role assistant) há no máximo INSTALL_STAGE_MAX_DAYS dias. Linhas sem
// created_at (evals antigos) contam como recentes.
export function findRecentInstallationConfirmation(
  rows: Array<{ role: string; content: string; created_at?: string | null }>,
  now: Date = new Date(),
  maxDays: number = INSTALL_STAGE_MAX_DAYS
): { content: string; created_at: string | null } | null {
  for (let i = (rows ?? []).length - 1; i >= 0; i--) {
    const m = rows[i];
    if (m.role !== "assistant" || !INSTALL_CONFIRMATION_RE.test(m.content ?? "")) continue;
    if (!m.created_at) return { content: m.content, created_at: null };
    const at = new Date(m.created_at).getTime();
    if (Number.isNaN(at)) return { content: m.content, created_at: m.created_at };
    const ageDays = (now.getTime() - at) / 86_400_000;
    if (ageDays <= maxDays) return { content: m.content, created_at: m.created_at };
    return null; // a mais recente já é velha → não é mais etapa de instalação
  }
  return null;
}
