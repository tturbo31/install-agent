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

// Job SEM vendedor (regra do dono 22/10/2026, caso Jeff Jacobs): o aviso sai do
// mesmo jeito e o contato para dúvidas é o Ozzi, (561) 674-8334. Antes a frase
// do contato era simplesmente omitida — e o app nem chamava o agente.
export const INSTALL_FALLBACK_CONTACT = { nome: "Ozzi", telefone: "(561) 674-8334" } as const;

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
// "Perfect we are ready" (Nathalie, WA 27/09/2026) não era ack e virou
// "I'll pass this along to Ozzi, who will get in touch": quem confirma que está
// pronto para a instalação de amanhã só precisa do 👍.
const ACK_WORDS =
  /^(?:(?:ok(?:ay)?|perfect|perfecto|perfeito|great|awesome|yes|yep|si|sí|sim|sure|alright|listo)[\s,!.]+)?(?:ok(?:ay)?|k|kk|perfect|perfecto|perfeito|great|awesome|cool|sure|yes|yep|yeah|ya|si|sí|sim|claro|dale|vale|listo|got it|noted|sounds? (?:good|great|perfect)|that (?:works|sounds (?:good|great|better))|all good|good|nice|alright|all right|will do|see (?:you|ya)(?: (?:then|tomorrow|soon|there))?|nos vemos(?: mañana)?|até (?:amanhã|lá)|ha+|haha+|lol|(?:we(?:'re| are)?|i(?:'m| am)?|im|estamos|estoy|estou)?\s*(?:all\s+)?(?:ready|set|listos?|prontos?)(?:\s+(?:for\s+)?(?:you|tomorrow|them|it|mañana|amanhã))?|confirmed|confirmado|confirmo|(?:i|we)(?:'ll| will)?\s+be\s+(?:here|home|there|ready|waiting)(?:\s+for\s+(?:you|them))?|estaremos(?: aquí| en casa)?|aqui estaremos|(?:ahí|ahi|aquí|aqui|allí|alli)?\s*(?:los|lo|la|las|te|les)\s+esper(?:amos|o)|(?:por mi parte\s+)?todo (?:bien|ok|listo)|tudo (?:bem|certo|ok))[\s!.…]*$/i;
// Saudação na frente não muda o que vem depois: "Hi thank you, we will be
// here" (Teresa, 08/09/2026) e "Buenos días ahí los esperamos, por mi parte
// todo bien" (Harry, 01/10/2026) viravam handoff em vez do 👍.
const GREETING_PREFIX =
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|gm|hola|buenos? d[ií]as|buenas(?: tardes| noches)?|bom dia|boa tarde|boa noite|oi|ol[aá])[\s,!.]*/i;
const QUESTION_MARKERS =
  /\?|\b(?:what|when|where|why|which|who|how|can|could|would|will|is|are|do|does|did|should|qué|que|cuándo|cuando|dónde|donde|cómo|como|por qué|porque|puede|pueden|quando|onde|pode|podem)\b/i;

export function isInstallAck(raw: string): boolean {
  const t0 = normalizeSmartPunct(raw ?? "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t0) return false;
  // Só emoji / símbolos (👍, ❤️, 🙏, "!!")
  if (!/[a-z0-9À-ɏ]/i.test(t0)) return true;
  // Saudação inicial e emoji/símbolo no fim não contam ("Hi thank you",
  // "todo bien 👍"); o "?" fica, porque ele decide o que é pergunta.
  const t = t0.replace(GREETING_PREFIX, "").replace(/[^\p{L}\p{N}?]+$/u, "").trim();
  if (!t) return false; // só "Hi"/"Hello": a pessoa vai falar algo, melhor o handoff
  // "Perfect we are ready" / "Ok we will be here" (Nathalie, 27/09/2026): o
  // "are"/"will" dos marcadores de pergunta não desfaz um ack inteiro (o ack
  // nunca termina em "?", então uma pergunta de verdade não passa aqui).
  if (t.length <= 60 && ACK_WORDS.test(t)) return true;
  const isAckChunk = (c: string) => ACK_WORDS.test(c) || isPureClosing(c);
  // Junta várias frases curtas de ack: "Perfect! See you tomorrow" / "Ok thanks"
  const chunks = t
    .split(/[.!,]+\s*|\s{2,}/)
    .map((c) => c.replace(GREETING_PREFIX, "").replace(/[^\p{L}\p{N}?]+$/u, "").trim())
    .filter(Boolean);
  // "Hi thank you, we will be here..!!!!!!" / "Ok,,,i be there" (08/09 e
  // 18/10/2026): pedaços curtos de ack valem ANTES dos marcadores de pergunta,
  // desde que nada termine em "?". Aqui só a lista fechada de acks pode conter
  // "will"/"do"; um fecho genérico com marcador ("Yes I do have questions I
  // will reach to Alex") continua sendo dúvida.
  const isAckChunkEarly = (c: string) => ACK_WORDS.test(c) || (!QUESTION_MARKERS.test(c) && isPureClosing(c));
  if (t.length <= 60 && !/\?/.test(t) && chunks.length > 0 && chunks.every(isAckChunkEarly)) return true;
  if (QUESTION_MARKERS.test(t)) return false;
  if (isPureClosing(t)) return true;
  if (t.length > 60) return false;
  return chunks.length > 0 && chunks.every(isAckChunk);
}

// Frase única, sem prometer horário, resposta ou retorno: regra do dono
// 14/09/2026 (nunca "o Ozzi entra em contato", dar o número). O dono continua
// avisado pelo INSTALL_STAGE_ALERT.
export function installHandoffMessage(lang: Lang): string {
  if (lang === "es") return "Para cualquier detalle de su instalación, lo mejor es hablar directo con Ozzi al (561) 674-8334.";
  if (lang === "pt") return "Para qualquer detalhe da sua instalação, o melhor é falar direto com o Ozzi no (561) 674-8334.";
  return "For anything about your installation, the best is to reach Ozzi directly at (561) 674-8334.";
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
    // Aviso enviado por engano e retratado (22/10/2026): não é etapa de instalação.
    if (isRetractedInstallNotice(m.content)) continue;
    if (!m.created_at) return { content: m.content, created_at: null };
    const at = new Date(m.created_at).getTime();
    if (Number.isNaN(at)) return { content: m.content, created_at: m.created_at };
    const ageDays = (now.getTime() - at) / 86_400_000;
    if (ageDays <= maxDays) return { content: m.content, created_at: m.created_at };
    return null; // a mais recente já é velha → não é mais etapa de instalação
  }
  return null;
}

// ─── Trava de duplicidade do aviso (21/10/2026) ───────────────────────────────
// A rotina do Lovable roda UMA vez por dia (13:00 UTC). Uma segunda chamada
// para o mesmo telefone dentro de INSTALL_DEDUP_HOURS é repetição (retry do
// integrador, rodada dupla, dois jobs do mesmo cliente no mesmo dia) e NÃO um
// aviso novo: o cliente não pode receber "starts tomorrow" duas vezes. 20h e
// não 24h para a rodada de amanhã (24h depois) nunca ser barrada por atraso de
// relógio. Job remarcado para outra semana passa normalmente.
export const INSTALL_DEDUP_HOURS = 20;

export function isDuplicateInstallNotice(
  rows: Array<{ role: string; content: string; created_at?: string | null }>,
  now: Date = new Date()
): boolean {
  const hit = findRecentInstallationConfirmation(rows, now, INSTALL_DEDUP_HOURS / 24);
  // Linha sem created_at (histórico antigo) não prova nada sobre "hoje".
  return !!hit && !!hit.created_at;
}

// ─── Aviso RETRATADO (22/10/2026) ─────────────────────────────────────────────
// Caso Dayana (786) 877-0477: o aviso de véspera saiu para uma cliente SEM obra
// marcada ("You have the wrong number"). A linha dele no histórico ganha este
// prefixo e, a partir daí, não vale como etapa de instalação (handoff/👍), não
// barra o próximo aviso como duplicado e não entra no contexto de
// "INSTALLATION CONFIRMED" do cérebro (ai.ts repete o marcador para não criar
// import circular). O texto original fica preservado depois do marcador.
export const INSTALL_RETRACTED_PREFIX = "[RETRATADO";

export function isRetractedInstallNotice(content: string | null | undefined): boolean {
  return (content ?? "").trimStart().startsWith(INSTALL_RETRACTED_PREFIX);
}

export function retractInstallNoticeText(original: string, motivo: string, quando: string): string {
  return `${INSTALL_RETRACTED_PREFIX} ${quando}: aviso de instalação enviado por engano — ${motivo}] ${original}`;
}

// ─── A data do aviso tem que ser AMANHÃ (22/10/2026) ─────────────────────────
// O texto diz "starts tomorrow, <data>". Se a data que o app mandou não é o dia
// seguinte na Flórida, a mensagem está errada por construção e NÃO sai (409 ao
// integrador → revisão manual no app; dono avisado). Formatos aceitos: o do
// Lovable ("Friday, October 23"), com ou sem dia da semana/ano/horário,
// "Oct 23", "23 de octubre", "10/23/2026", "2026-10-23". Texto sem data
// reconhecível ("TBD") NÃO bloqueia por si (fica registrado) — a trava da
// plataforma continua valendo para ele.
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, enero: 1, ene: 1, janeiro: 1,
  feb: 2, february: 2, febrero: 2, fevereiro: 2, fev: 2,
  mar: 3, march: 3, marzo: 3, marco: 3,
  apr: 4, april: 4, abril: 4, abr: 4,
  may: 5, mayo: 5, maio: 5, mai: 5,
  jun: 6, june: 6, junio: 6, junho: 6,
  jul: 7, july: 7, julio: 7, julho: 7,
  aug: 8, august: 8, agosto: 8, ago: 8,
  sep: 9, sept: 9, september: 9, septiembre: 9, setiembre: 9, setembro: 9, set: 9,
  oct: 10, october: 10, octubre: 10, outubro: 10, out: 10,
  nov: 11, november: 11, noviembre: 11, novembro: 11,
  dec: 12, december: 12, diciembre: 12, dezembro: 12, dez: 12, dic: 12,
};

// "YYYY-MM-DD" de um instante, no fuso dado.
export function dayInTz(now: Date, tz: string = INSTALL_TZ): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function tomorrowInTz(now: Date, tz: string = INSTALL_TZ): string {
  return shiftDay(dayInTz(now, tz), 1);
}

function validDay(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

// Sem ano no texto: o ano (anterior, atual ou seguinte) que deixa a data mais
// perto de hoje — "January 1" mandado em 31/12 é o ano que vem.
function closestYear(m: number, d: number, today: string): string | null {
  const y0 = Number(today.slice(0, 4));
  const ref = Date.parse(`${today}T12:00:00Z`);
  let best: string | null = null;
  let bestDist = Infinity;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const iso = validDay(y, m, d);
    if (!iso) continue;
    const dist = Math.abs(Date.parse(`${iso}T12:00:00Z`) - ref);
    if (dist < bestDist) {
      best = iso;
      bestDist = dist;
    }
  }
  return best;
}

function fullYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return raw.length === 2 ? 2000 + n : n;
}

export function parseInstallDateText(raw: string, now: Date = new Date(), tz: string = INSTALL_TZ): string | null {
  const today = dayInTz(now, tz);
  const t = (raw ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  // 1) ISO: 2026-10-23
  const iso = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  // 2) mês por extenso + dia: "october 23", "oct. 23rd, 2026"
  for (const m of t.matchAll(/([a-z]{3,})\.?,? (\d{1,2})(?:st|nd|rd|th)?\b(?:,? (\d{4})\b)?/g)) {
    const mon = MONTHS[m[1]];
    if (!mon) continue;
    const y = fullYear(m[3]);
    return y ? validDay(y, mon, Number(m[2])) : closestYear(mon, Number(m[2]), today);
  }
  // 3) dia + mês por extenso: "23 de octubre", "23 october 2026"
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?: de)? ([a-z]{3,})\b(?:(?: de)? (\d{4})\b)?/g)) {
    const mon = MONTHS[m[2]];
    if (!mon) continue;
    const y = fullYear(m[3]);
    return y ? validDay(y, mon, Number(m[1])) : closestYear(mon, Number(m[1]), today);
  }
  // 4) numérico americano: 10/23, 10/23/2026, 10/23/26 (dia/mês se o 1º não cabe em mês)
  const num = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (num) {
    let mon = Number(num[1]);
    let day = Number(num[2]);
    if (mon > 12 && day <= 12) [mon, day] = [day, mon];
    const y = fullYear(num[3]);
    return y ? validDay(y, mon, day) : closestYear(mon, day, today);
  }
  return null;
}

export type InstallDateCheck = {
  status: "ok" | "nao_e_amanha" | "nao_interpretada";
  data: string | null; // a data lida do texto (YYYY-MM-DD)
  amanha: string; // amanhã na Flórida (YYYY-MM-DD)
};

export function checkInstallDateIsTomorrow(raw: string, now: Date = new Date(), tz: string = INSTALL_TZ): InstallDateCheck {
  const amanha = tomorrowInTz(now, tz);
  const data = parseInstallDateText(raw, now, tz);
  if (!data) return { status: "nao_interpretada", data: null, amanha };
  return { status: data === amanha ? "ok" : "nao_e_amanha", data, amanha };
}

// Alertas ao dono quando o aviso NÃO sai (22/10/2026). Sem acento, como as
// outras notificações (notifyOwners).
export function installBlockedAlert(params: { nome: string | null; telefone: string; dataRecebida: string; motivo: string }): string {
  const quem = params.nome ? `${params.nome} (${params.telefone})` : params.telefone;
  return (
    `AVISO DE INSTALACAO BLOQUEADO (nada foi enviado): o app chamou o agente para ${quem} ` +
    `com instalacao "${params.dataRecebida}", mas ${params.motivo}. ` +
    `Se a instalacao for real, confira o job no app e mande o aviso manualmente.`
  );
}

export function installUnverifiedAlert(params: { nome: string | null; telefone: string; dataRecebida: string; erro: string }): string {
  const quem = params.nome ? `${params.nome} (${params.telefone})` : params.telefone;
  return (
    `AVISO DE INSTALACAO NAO ENVIADO: nao consegui conferir na plataforma se ${quem} tem obra marcada ` +
    `para "${params.dataRecebida}" (${params.erro}). Se a instalacao for real, mande o aviso manualmente.`
  );
}
