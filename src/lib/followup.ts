// ─── One-shot follow-up for hot leads that went quiet mid-scheduling ────────
// The 2026-07-09 six-day review found the single biggest booking leak: leads
// who engaged (named their floor type / got the visit offer) and then simply
// went silent — the bot never spoke again and the lead died. 221 engaged leads
// → 113 visit offers → only 46 bookings in 6 days. This module sends AT MOST
// ONE gentle follow-up per conversation, ever, to exactly that segment.
//
// HARD GUARDS (all must pass — this must never become spam):
//  • last message in the convo is OURS and is a scheduling ask/offer
//  • the client actually engaged (≥1 real, non-FAQ-button message after our
//    first reply — ad-button ghosts and accidental taps are never followed up)
//  • the client did NOT defer/decline ("I'll reach out when ready", "no
//    thanks", "te aviso", "vou falar com meu marido" → we respect it, no nudge)
//  • our last message is not already a handoff/deferral-ack
//  • timing: ≥3h of silence, and within the channel's messaging window
//    (Meta 24h policy → ≤22h for IG/Messenger; WhatsApp via Z-API → ≤46h)
//  • never twice: any prior follow-up marker in the convo disqualifies it
//  • mode=agent, not booked, platform not paused, ET daytime only, ≤25/run
import { containsSchedulingOffer } from "@/lib/ai";

export type FollowupMsg = { role: string; content: string; created_at: string };
export type Channel = "instagram" | "facebook" | "whatsapp";
export type Lang = "en" | "es" | "pt";

export function channelOfIgsid(igsid: string): Channel {
  if (igsid.startsWith("wa_")) return "whatsapp";
  if (igsid.startsWith("fb_")) return "facebook";
  return "instagram";
}

// The exact one-shot nudge, per language. 2 sentences, no prices, no invented
// slots, no dashes/emoji (owner rules). The opening phrase doubles as the
// dedup MARKER — never reword it without updating FOLLOWUP_MARKER.
export function followupTemplate(lang: Lang): string {
  if (lang === "pt")
    return "Oi, passando só para saber se quer agendar sua visita gratuita de orçamento! Levo todas as amostras para você escolher o piso e já sair com o preço exato.";
  if (lang === "es")
    return "Hola, solo para dar seguimiento, ¿quieres que agendemos tu visita gratis para el estimado? Llevo todas las muestras para que escojas tu piso y tengas el precio exacto al momento.";
  return "Hi, just checking in, want me to get your free estimate visit scheduled? I bring all the samples so you can pick your floor and get the exact price on the spot.";
}

// Detects a follow-up we already sent (any language) — ONE per conversation, ever.
// A nudge escrita pela IA é gravada no banco com o sufixo [SYSTEM: FOLLOWUP_NUDGE]
// (nunca enviado ao cliente), então o marcador também o reconhece.
export const FOLLOWUP_MARKER = /just checking in, want me to get your free estimate|solo para dar seguimiento|passando s[oó] para saber se quer agendar|\[SYSTEM: FOLLOWUP_NUDGE\]/i;
export const FOLLOWUP_DB_SUFFIX = "\n\n[SYSTEM: FOLLOWUP_NUDGE]";

// Meta ad FAQ quick-reply buttons — a tap is NOT genuine engagement. A lead
// whose only "messages" are these templates is a browse/mis-tap ghost and must
// never receive a follow-up (58% of leads are one-tap ghosts per the review).
const FAQ_BUTTON = /^\s*(?:what type of materials are included|what is the installation process|do you offer any discounts for larger spaces|is labor cost also \$?4,?500|can i customize the design|what is included in the materials package|is installation cost included in the price|is installation labor cost extra|schedule a quote)\s*\??\s*$/i;

export function isAdFaqButton(text: string): boolean {
  return FAQ_BUTTON.test((text || "").split(/\n\n?\[SYSTEM:/)[0]);
}

// Client told us their plan — respect it, never nudge. EN/ES/PT.
const CLIENT_DEFERRAL = /\b(?:no,?\s+thanks?|not interested|stop|unsubscribe|wrong (?:person|number)|by accident|accidentally|didn'?t mean|just browsing|no longer|already (?:hired|found|done|booked)|i'?ll?\s+(?:reach|call|text|message|contact|get back|let (?:you|u) know|think about|keep you in mind|be in touch)|will (?:reach|call|contact|get back|let you know)|when (?:i'?m|we'?re|i am|it'?s) ready|out of town|on vacation|next (?:week|month|year)|talk to my|ask my (?:husband|wife|partner)|check with my|keep in touch|keep you posted|no me interesa|equivocad\w*|sin querer|te aviso|les? avis(?:o|amos)|luego (?:te|les?)|cuando (?:regrese|vuelva|est[ée]|lo consulte|consulte)|consultar(?:lo)? con|lo pienso|d[ée]jame pensarlo|depois (?:eu )?(?:aviso|falo|chamo|entro em contato)|te aviso|aviso voc[eê]s?|sem interesse|cliquei sem querer|vou (?:pensar|ver|falar com))\b/i;

export function isClientDeferral(text: string): boolean {
  return CLIENT_DEFERRAL.test((text || "").split(/\n\n?\[SYSTEM:/)[0]);
}

// Our own last line already acknowledged a deferral or handed off to a human —
// a nudge on top of "no problem, reach out whenever!" contradicts ourselves.
const BOT_CLOSED_LOOP = /\breach out (?:when(?:ever)?|as soon as|any\s?time)|when(?:ever)? you(?:'re| are) ready|just (?:message|text|reach out to) me|no (?:problem|rush|worries),? just|team (?:will |to )?reach(?:es)? out|someone will (?:get|reach|contact)|connect you with ozzi|reach ozzi directly|we don'?t (?:cover|service|serve)|outside our (?:area|service)|only serve the miami|don'?t take projects under|me avisa|cuando (?:lo )?consulten|les aviso|puedes? contactar|contact[aá]|entra em contato|s[oó] (?:me )?(?:chamar|avisar)|qualquer coisa/i;

export function botClosedTheLoop(text: string): boolean {
  return BOT_CLOSED_LOOP.test(text || "");
}

// Our last message keeps the door open on scheduling: a slot offer/scheduling
// question (containsSchedulingOffer), a visit/estimate proposal, or one of our
// qualifying asks (floor type / scope). These are the "waiting on the client"
// shapes worth one nudge.
const SCHEDULING_ASK = /\b(?:free|in.?person)\s+(?:visit|estimate|quote)\b|\bcome (?:by|out|over|measure)\b|\bmeasure (?:everything|in person)\b|\bvisit\b[^.!?]{0,60}\bfree\b|one area or (?:the )?(?:whole|entire) house|whole house or|tile[^.!?]{0,30}vinyl[^.!?]{0,30}hardwood|which (?:one|type|floor)[^.!?]{0,40}\?|square (?:feet|footage)[^.!?]{0,30}\?|s[oó] uma [aá]rea ou|una sola [aá]rea o|visita (?:gratis|gratuita)/i;

export function isSchedulingAsk(text: string): boolean {
  const t = text || "";
  return containsSchedulingOffer(t) || SCHEDULING_ASK.test(t);
}

// Language of the conversation. The client's own words decide when they carry
// a signal; when they don't (a bare address, a name, FAQ-button English), we
// trust the language of OUR OWN last reply — the model already language-matched
// the client, so following up in a different language than the running
// conversation is always wrong (caught on the 2026-07-09 dry run: a Spanish
// lead whose last messages were just her address was about to get English).
const PT_SIGNALS = /(?:^|[\s!.,?¡¿])(?:olá|oi|bom dia|boa (?:tarde|noite))(?![a-zà-ÿ])|[ãõç]|\b(?:você|voce|obrigad\w*|orçamento|orcamento|preciso de|banheiro|cozinha|amostras para você|gratuita)\b/i;
const ES_SIGNALS = /[¿¡]|(?:^|[\s!.,?])(?:hola|buenas|buenos)(?![a-zà-ÿ])|\b(?:cu[aá]nto|cu[aá]ndo|precio|cuesta|necesito|quiero|busco|porcelanato|cer[aá]mica|cotizaci[oó]n|presupuesto|gracias|cita|pueden?|darme|horarios?|muestras|pie cuadrado|escoja?s?|viernes|jueves|lunes|martes|s[aá]bado|domingo)\b/i;

export function pickLang(userTexts: string[], lastBotText?: string): Lang {
  const blob = userTexts.slice(-6).join(" ");
  // PT first (mirrors ai.ts: PT context beats the shared piso/casa vocabulary).
  if (PT_SIGNALS.test(blob)) return "pt";
  if (ES_SIGNALS.test(blob)) return "es";
  // Client text carries no signal → follow the conversation's existing language.
  const bot = lastBotText || "";
  if (PT_SIGNALS.test(bot)) return "pt";
  if (ES_SIGNALS.test(bot)) return "es";
  return "en";
}

const H = 3600_000;
// Channel messaging windows, measured from the CLIENT's last message. Meta
// enforces the 24h standard-messaging window (22h keeps margin); Z-API
// WhatsApp has no such window, so we allow catching yesterday's leads too.
const WINDOW_H: Record<Channel, { min: number; max: number }> = {
  instagram: { min: 3, max: 22 },
  facebook: { min: 3, max: 22 },
  whatsapp: { min: 3, max: 46 },
};

export type FollowupDecision = { eligible: boolean; reason: string; lang: Lang };

// Pure eligibility decision for one conversation. `messages` must be the FULL
// history in ascending order; `nowMs` injected for testability.
export function decideFollowup(igsid: string, messages: FollowupMsg[], nowMs: number): FollowupDecision {
  const strip = (c: string) => (c || "").split(/\n\n?\[SYSTEM:/)[0];
  const lastBot = [...messages].reverse().find((m) => m.role === "assistant");
  const lang = pickLang(
    messages.filter((m) => m.role === "user").map((m) => strip(m.content)),
    lastBot?.content
  );
  const no = (reason: string): FollowupDecision => ({ eligible: false, reason, lang });

  if (!messages.length) return no("empty");
  if (messages.some((m) => m.role === "assistant" && FOLLOWUP_MARKER.test(m.content))) return no("already-followed-up");

  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return no("client-has-last-word"); // unanswered client msg is a different problem
  if (botClosedTheLoop(last.content)) return no("bot-closed-loop");
  if (!isSchedulingAsk(last.content)) return no("last-bot-msg-not-a-scheduling-ask");

  // Genuine engagement: at least one real (non-FAQ-button) client message AFTER
  // our first reply. One-tap ad ghosts never qualify.
  const firstBotIdx = messages.findIndex((m) => m.role === "assistant");
  const engaged = messages.some(
    (m, i) => i > firstBotIdx && m.role === "user" && strip(m.content).trim().length > 0 && !isAdFaqButton(m.content)
  );
  if (!engaged) return no("never-genuinely-engaged");

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return no("no-user-message");
  if (isClientDeferral(lastUser.content)) return no("client-deferred");

  const win = WINDOW_H[channelOfIgsid(igsid)];
  const ageH = (nowMs - Date.parse(lastUser.created_at)) / H;
  if (!Number.isFinite(ageH)) return no("bad-timestamp");
  if (ageH < win.min) return no(`too-fresh(${ageH.toFixed(1)}h)`);
  if (ageH > win.max) return no(`window-closed(${ageH.toFixed(1)}h)`);
  // Our own last line must also have had ≥2.5h with no answer.
  const botAgeH = (nowMs - Date.parse(last.created_at)) / H;
  if (Number.isFinite(botAgeH) && botAgeH < 2.5) return no(`bot-msg-too-fresh(${botAgeH.toFixed(1)}h)`);

  return { eligible: true, reason: "ok", lang };
}

// Daytime guard: only message clients 9:00–20:59 America/New_York.
export function isEtDaytime(nowMs: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(nowMs))
  );
  return hour >= 9 && hour <= 20;
}

// ─── The sweep: query, decide, send ─────────────────────────────────────────
// Framework-free so the /api/followup route stays thin AND a local
// `npx tsx` dry-run can exercise the exact production path with zero sends.
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase";
import { sendFacebookMessage } from "@/lib/facebook";
import { sendInstagramMessage } from "@/lib/instagram";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { removeDashes, removeEmojis, stripWrappingQuotes } from "@/lib/ai";
import { promisesDiscount } from "@/lib/quote-followup";

// ─── Nudge personalizada pela IA (2026-07-17) ───────────────────────────────
// Pedido do dono: o follow-up do Direct deve primeiro ENTENDER o contexto da
// conversa (por que o cliente não seguiu) e falar disso, não mandar sempre a
// mesma frase. A IA lê o final da conversa e escreve 1-2 frases retomando
// exatamente o ponto que ficou aberto; o template fixo vira fallback (IA fora
// do ar / texto reprovado nos guardas). Os guardas de ELEGIBILIDADE (deferral,
// janela de 24h da Meta, 1 nudge por conversa, ≤25/run) continuam idênticos.
const NUDGE_SYSTEM = `You are Ozzi's assistant for Ozzi Floors (flooring installation, South Florida). A potential client was mid-conversation about their floors, we offered to schedule the free in-person estimate visit, and they went quiet. Write ONE short re-engagement message.

Write ONLY the message text. Rules:
1. Write in the language you are told. 1 or 2 short sentences, like a real person texting. No emoji, no dashes (use commas or periods), no links, no markdown, no bracket tags.
2. START from what THEY left hanging: their last question, the floor type or area they mentioned, the thing they were deciding. Reference it naturally so it feels personal, never generic.
3. END by warmly inviting them to schedule the free estimate visit (samples come along, exact price on the spot). Do NOT name any specific day, date, or time, you do not know the real schedule.
4. NEVER mention, offer, or hint at a discount, deal, or better price. NEVER invent prices, sizes, or facts not present in the conversation. You may repeat a price WE already stated there.
5. No pressure, one gentle nudge.`;

let _nudgeAnthropic: Anthropic | null = null;
function nudgeClient(): Anthropic {
  if (!_nudgeAnthropic) {
    _nudgeAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 2, timeout: 25_000 });
  }
  return _nudgeAnthropic;
}

const LANG_LABEL: Record<Lang, string> = { en: "English", es: "Spanish", pt: "Portuguese" };

function sanitizeNudge(text: string): string {
  return stripWrappingQuotes(removeEmojis(removeDashes(text ?? "")))
    .replace(/\[[A-Z_]+(?::[\s\S]*?)?\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Escreve a nudge personalizada; devolve null quando o texto não passa nos
// guardas (aí o chamador usa o template fixo comprovado).
export async function composeColdLeadNudge(messages: FollowupMsg[], lang: Lang): Promise<string | null> {
  try {
    const tail = messages
      .slice(-10)
      .map((m) => `${m.role === "user" ? "Client" : "Us"}: ${(m.content || "").split(/\n\n?\[SYSTEM:/)[0].slice(0, 350)}`)
      .join("\n");
    const res = await nudgeClient().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      system: NUDGE_SYSTEM,
      messages: [
        {
          role: "user" as const,
          content: `Language to write in: ${LANG_LABEL[lang]}\n\nConversation (oldest first):\n${tail}\n\nWrite the re-engagement message now.`,
        },
      ],
    });
    const block = res.content[0];
    const text = sanitizeNudge(block?.type === "text" ? block.text : "");
    if (text.length < 20 || text.length > 360) return null;
    if (promisesDiscount(text)) return null;
    if (/https?:\/\//i.test(text)) return null;
    return text;
  } catch (err) {
    console.error("[FOLLOWUP] nudge AI failed, using template:", err);
    return null;
  }
}

const MAX_SENDS_PER_RUN = 25; // hard cap — a bug can never mass-message
const SCAN_WINDOW_H = 48;

type ConvRow = { id: string; igsid: string; name: string | null; username: string | null; mode: string; booking_confirmed: boolean | null; updated_at: string };

export type SweepResult = {
  ranAt: string;
  dry: boolean;
  quietHours?: boolean;
  scanned: number;
  eligible: number;
  sent: Array<{ igsid: string; channel: Channel; name: string; lang: Lang; ok: boolean; error?: string }>;
  skippedReasons: Record<string, number>;
};

async function isChannelPaused(channel: Channel): Promise<boolean> {
  if (channel === "instagram" && process.env.INSTAGRAM_PAUSED === "true") return true;
  if (channel === "facebook" && process.env.MESSENGER_PAUSED === "true") return true;
  try {
    const { data } = await supabaseAdmin.from("platform_settings").select("paused").eq("platform", channel).single();
    return data?.paused === true;
  } catch {
    return false; // missing row = not paused (matches webhook behavior)
  }
}

export async function runFollowupSweep(opts: { dry: boolean; now?: number }): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const result: SweepResult = { ranAt: new Date(now).toISOString(), dry: opts.dry, scanned: 0, eligible: 0, sent: [], skippedReasons: {} };
  const skip = (reason: string) => { result.skippedReasons[reason] = (result.skippedReasons[reason] || 0) + 1; };

  // Live sends only during ET daytime; a dry run may inspect at any hour.
  if (!opts.dry && !isEtDaytime(now)) {
    result.quietHours = true;
    return result;
  }

  const paused: Record<Channel, boolean> = {
    instagram: await isChannelPaused("instagram"),
    facebook: await isChannelPaused("facebook"),
    whatsapp: await isChannelPaused("whatsapp"),
  };

  const cutoff = new Date(now - SCAN_WINDOW_H * 3600_000).toISOString();
  const { data: convs, error } = await supabaseAdmin
    .from("instagram_conversations")
    .select("id, igsid, name, username, mode, booking_confirmed, updated_at")
    .gte("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`followup conv query: ${error.message}`);

  const candidates = ((convs ?? []) as ConvRow[]).filter((c) => {
    if (c.mode !== "agent") { skip("mode-human"); return false; }
    if (c.booking_confirmed === true) { skip("already-booked"); return false; }
    if (paused[channelOfIgsid(c.igsid)]) { skip("channel-paused"); return false; }
    return true;
  });
  result.scanned = candidates.length;

  // Fetch every candidate's messages in chunked bulk queries, group by convo.
  const byConv = new Map<string, FollowupMsg[]>();
  for (let i = 0; i < candidates.length; i += 80) {
    const ids = candidates.slice(i, i + 80).map((c) => c.id);
    const { data: msgs, error: mErr } = await supabaseAdmin
      .from("instagram_messages")
      .select("conversation_id, role, content, created_at")
      .in("conversation_id", ids)
      .order("created_at", { ascending: true });
    if (mErr) throw new Error(`followup msg query: ${mErr.message}`);
    for (const m of msgs ?? []) {
      const arr = byConv.get(m.conversation_id) ?? [];
      arr.push({ role: m.role, content: m.content, created_at: m.created_at });
      byConv.set(m.conversation_id, arr);
    }
  }

  for (const conv of candidates) {
    if (result.sent.length >= MAX_SENDS_PER_RUN) { skip("run-cap-reached"); continue; }
    const messages = byConv.get(conv.id) ?? [];
    const decision = decideFollowup(conv.igsid, messages, now);
    if (!decision.eligible) { skip(decision.reason.replace(/\(.*\)/, "")); continue; }

    result.eligible++;
    const channel = channelOfIgsid(conv.igsid);
    const name = conv.name || conv.username || conv.igsid;
    if (opts.dry) {
      result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: false, error: "DRY-RUN (not sent)" });
      continue;
    }
    // IA personaliza a partir da conversa; template comprovado é o fallback.
    const text = (await composeColdLeadNudge(messages, decision.lang)) ?? followupTemplate(decision.lang);
    try {
      if (channel === "whatsapp") {
        const r = await sendWhatsAppMessage(conv.igsid.slice(3), text);
        if (!r.ok) { result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: false, error: r.error }); continue; }
      } else if (channel === "facebook") {
        await sendFacebookMessage(conv.igsid.slice(3), text);
      } else {
        await sendInstagramMessage(conv.igsid, text);
      }
      // Record it exactly like the webhooks do, so the panel shows it and the
      // FOLLOWUP_MARKER dedup can never let a second nudge through. O sufixo
      // [SYSTEM: FOLLOWUP_NUDGE] (só no banco) garante o dedup mesmo com texto
      // personalizado pela IA.
      await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: text + FOLLOWUP_DB_SUFFIX });
      await supabaseAdmin.from("instagram_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);
      result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: true });
      console.log(`[FOLLOWUP] sent (${channel}/${decision.lang}) to ${name}`);
    } catch (err) {
      result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: false, error: String(err).slice(0, 200) });
      console.error(`[FOLLOWUP] send failed for ${conv.igsid}:`, err);
    }
  }

  console.log(`[FOLLOWUP] sweep done: scanned=${result.scanned} eligible=${result.eligible} sent=${result.sent.filter((s) => s.ok).length} dry=${opts.dry}`);
  return result;
}
