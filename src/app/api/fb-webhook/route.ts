import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { sendFacebookMessage, fetchFacebookProfile, downloadFacebookAttachment, fetchAdCreative } from "@/lib/facebook";
import { notifyOwners } from "@/lib/whatsapp";
import { alertPausedBacklog, retryFailedSends } from "@/lib/delivery";
import { SEND_FAILED_DB_SUFFIX } from "@/lib/outbound-text";
import { getAIResponse, analyzeImageFromBase64, transcribeAudioFromBuffer, stripForbiddenTags, detectLargeLeadSqft, isPureClosing, isPureClosingBurst, isRescheduleRequest, questionSwallowedByBooking, isCancelRequest, containsSchedulingOffer, isJobSeeker, isLowCreditError, CREDIT_ALERT, containsBookingInfo, isAskingForBookingInfo, detectAdFlooringType, adFlooringTypeNote, classifyAdCreativeType, isConsecutiveDuplicate, adRetapNudge, unansweredUserBurst, isVisitDetailQuestion, pastVisitSystemNote, assertsExistingAppointment, type AdFlooringType } from "@/lib/ai";
import { verifyMetaSignature } from "@/lib/verify-meta";
import { AD_REPLY_NOTE } from "@/lib/system-prompt";
import { loadGlobalCorrections, isStructuredCorrection } from "@/lib/corrections";
import { trackConversationMetrics } from "@/lib/metrics";
import { createBooking, cancelClientBooking, rescheduleClientBooking, getRealAvailabilityContext, getEasternDateContext, detectLang, bookingSuccessMessage, bookingFailureHandoffMessage, slotConflictRecoveryMessage, rescheduleSuccessMessage, aiOutageHandoffMessage, getClientBookingSnapshot, visitDetailsMessage, appointmentMismatchHandoffMessage, isRealPhoneNumber, needPhoneMessage, resolveClientName, reconcileBookingWeekday, reconcileOfferedDates, clientConfirmedSlot, needSlotConfirmationMessage, bookedTimeSeenInConversation, needTimeChoiceMessage, isRealAddress, needAddressMessage, addressHasStreetNumber, bookingAddressHasZip, needZipMessage, clientProvidedName, needNameMessage } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { funilOnInboundMessage, funilOnBookingConfirmed, maybeRunFunilSilenceCheck, persistirAnuncioDaConversa, dadosDeAnuncioDaConversa } from "@/lib/funil";
import { capturarRawFunil, capturarWebhookRaw } from "@/lib/funil-raw";

export const maxDuration = 60;

const RESPONSE_DELAY_MS = 10000;

const FB_PAGE_ID = process.env.FACEBOOK_PAGE_ID ?? "";

// ─── Webhook verification ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

// ─── Safety net: strip slot-conflict sentences and hard-fallback ──────────
function stripSlotConflictLanguage(text: string): string {
  let cleaned = text
    .replace(/[^.!?\n]*\b(?:slot|time\s*slot|appointment|visit|horário|hora)\b[^.!?\n]*\b(?:taken|unavailable|booked|not\s+available|no\s+longer\s+available|just\s+got\s+taken|already\s+(?:taken|booked)|foi\s+ocupad|ocupad)\b[^.!?\n]*[.!?]/gi, "")
    .replace(/[^.!?\n]*\b(?:can|could|would)\b[^.!?\n]*\b(?:pick|choose|select|suggest|prefer)\b[^.!?\n]*\b(?:another|different|other)\b[^.!?\n]*\b(?:time|day|slot|date|hora|dia)\b[^.!?\n]*[.!?]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (
    /\b(?:slot|appointment|horário|hora)\b[^.!?\n]{0,60}\b(?:taken|unavailable|booked|not\s+available|no\s+longer)\b/i.test(cleaned) ||
    /\b(?:taken|unavailable|booked)\b[^.!?\n]{0,60}\b(?:slot|appointment|horário)\b/i.test(cleaned) ||
    /\bcan you (?:pick|choose|suggest|select) (?:another|a different)\b/i.test(cleaned)
  ) {
    cleaned = "You're welcome, see you then!";
  }

  return cleaned || "You're welcome, see you then!";
}

// ─── [BOOK:...] processor ─────────────────────────────────────────────────
async function processBookingCommand(
  aiResponse: string,
  psid: string,
  conversationId: string,
  isAlreadyBooked: boolean,
  lang: "es" | "en",
  isReschedule: boolean = false,
  history: Array<{ role: string; content: string }> = []
): Promise<{ response: string; booked: boolean }> {
  if (isAlreadyBooked && !isReschedule) {
    return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
  }
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return { response: aiResponse, booked: false };
  try {
    const bookingData = JSON.parse(bookingMatch[1]);

    // DETERMINISTIC weekday↔date guard: the model sometimes writes the wrong
    // day's date for the weekday the client picked (a "Thursday" visit was
    // booked on Friday). Snap it back before anything is written. See
    // reconcileBookingWeekday.
    if (bookingData.date) {
      const rec = reconcileBookingWeekday(bookingData.date, history);
      if (rec.corrected) {
        console.warn(`[FB] booking date corrected: ${rec.reason}`);
        bookingData.date = rec.date;
      }
    }

    // SLOT CONFIRMATION guard: never book a day/time the client never picked.
    // The model booked a slot off an address+phone the client volunteered
    // without ever choosing one of the offered times (RODOLFO, 2026-07-16).
    if (bookingData.date && bookingData.time && !clientConfirmedSlot(history)) {
      console.warn(`[FB] booking blocked — client never picked a specific slot; asking to choose`);
      return { response: needSlotConfirmationMessage(lang), booked: false };
    }

    // TIME-INVENTION guard: the client picked a DAY but the booked HOUR never
    // appeared in the conversation → the model invented it (AXEL, 2026-07-30:
    // offer was "miércoles a las 3pm o el jueves?", client said "jueves", model
    // booked 9am; the seller drove out at 9am, the client expected 3pm). Block
    // and re-offer with that day's real open times.
    if (bookingData.date && bookingData.time && !bookedTimeSeenInConversation(history, bookingData.time)) {
      console.warn(`[FB] booking blocked — time ${bookingData.time} never appeared in the conversation; asking client to choose`);
      return { response: await needTimeChoiceMessage(lang, bookingData.date), booked: false };
    }

    // ── Reschedule: move the existing visit to the new date/time. Address/phone
    //    are copied from the saved booking, so only the new date/time are needed. ──
    if (isReschedule) {
      if (!bookingData.date || !bookingData.time) {
        return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim(), booked: false };
      }
      const r = await rescheduleClientBooking(`fb_${psid}`, bookingData.date, bookingData.time, {
        name: bookingData.name,
        phone: bookingData.phone,
        address: bookingData.address,
        notes: bookingData.notes,
      });
      if (r.success) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conversationId);
        // FUNIL: remarcação confirmada → agendamento_marcado com a NOVA data.
        waitUntil(funilOnBookingConfirmed(conversationId, `fb_${psid}`, {
          date: bookingData.date, time: bookingData.time, phone: bookingData.phone, name: bookingData.name, address: bookingData.address,
        }));
        return { response: rescheduleSuccessMessage(lang), booked: true };
      }
      // Do NOT pause: an automatic failure must never permanently silence the lead
      // (mode="human" is only for a deliberate owner takeover).
      console.warn(`[FB] Reschedule failed (${r.error}) for ${bookingData.date} ${bookingData.time} — handing off (staying active)`);
      return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
    }

    // Address must be REAL — the model once wrote the literal "pending" to slip
    // past a bare empty-check and Ozzi got a Sunday visit with nowhere to go.
    // Ask for the address instead of shipping the model's "confirmed" text
    // without an actual booking behind it.
    // The address must be COMPLETE: street number + street, not just a city.
    if (!isRealAddress(bookingData.address) || !addressHasStreetNumber(bookingData.address)) {
      console.warn(`[FB] booking blocked — address not usable (${JSON.stringify(bookingData.address ?? null)}); asking for it`);
      return { response: needAddressMessage(lang), booked: false };
    }
    // ZIP guard (owner rule 2026-08-01): the address is only complete with the
    // ZIP CODE, and it must be one the CLIENT typed — never one the model
    // inferred from the city. Ask for it instead of booking a guessed route.
    if (!bookingAddressHasZip(bookingData.address, history)) {
      console.warn(`[FB] booking blocked — address without a client-given zip (${JSON.stringify(bookingData.address ?? null)}); asking for it`);
      return { response: needZipMessage(lang), booked: false };
    }
    // Require a REAL phone number — never book with a non-number like "Messenger"
    // (client said "Call me in Messenger"). Re-ask instead of confirming a visit
    // the team cannot call; the client's next message (the number) then books.
    if (!isRealPhoneNumber(bookingData.phone)) {
      console.warn(`[FB] Booking blocked — phone not a real number (${JSON.stringify(bookingData.phone)})`);
      return { response: needPhoneMessage(lang), booked: false };
    }
    // Owner rule (2026-07-27): the visit is confirmed ONLY with the client's
    // NAME, address, and phone — all given by the client in the conversation.
    // A profile display name is not the client giving their name; if they never
    // typed it, ask for it instead of booking.
    if (!clientProvidedName(bookingData.name, history)) {
      console.warn(`[FB] booking blocked — client never gave their name (${JSON.stringify(bookingData.name ?? null)}); asking for it`);
      return { response: needNameMessage(lang), booked: false };
    }

    // Always book under the real client name: prefer a name the client typed,
    // then the saved Messenger profile name, then the handle. Never just "Client".
    const { data: convName } = await supabaseAdmin
      .from("instagram_conversations")
      .select("name, username")
      .eq("id", conversationId)
      .single();
    const clientName = resolveClientName(
      [bookingData.name, convName?.name, convName?.username],
      "Facebook Client"
    );

    // O ANÚNCIO VAI JUNTO PARA O CALENDÁRIO (01/08/2026). Até aqui o Messenger
    // mandava a string fixa "Facebook Messenger" — o Instagram já resolvia o
    // criativo persistido e o Facebook, que é o canal de maior volume, não.
    // Resultado na agenda: visita de anúncio do FB sem imagem nem título.
    const adPersistido = await dadosDeAnuncioDaConversa(conversationId).catch(() => null);
    const creativeRef =
      adPersistido?.contrato.ad_title ?? adPersistido?.ad_name ?? adPersistido?.ad_id ?? "Facebook Messenger";
    const creativeImage = adPersistido?.contrato.ad_media_url ?? undefined;

    const result = await createBooking({
      clientName,
      clientPhone: bookingData.phone ?? "",
      clientAddress: bookingData.address ?? "",
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
      notes: [bookingData.notes ?? "", "Facebook Messenger", creativeRef !== "Facebook Messenger" ? `Ad: ${creativeRef}` : ""]
        .filter(Boolean)
        .join(" | "),
      creative: creativeRef,
      creativeImage,
      channel: "facebook",
      igsid: `fb_${psid}`,
    });

    if (result.success) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      // FUNIL: visita confirmada → agendamento_marcado (data_visita em ISO).
      waitUntil(funilOnBookingConfirmed(conversationId, `fb_${psid}`, {
        date: bookingData.date, time: bookingData.time, phone: bookingData.phone, name: bookingData.name, address: bookingData.address,
      }));
      // A question asked in the SAME burst as the booking details is answered
      // first — the canned confirmation used to discard it, and booking_confirmed
      // then silenced the client for good (Kenny Abbasi, 2026-07-31).
      const pending = questionSwallowedByBooking(aiResponse, history);
      if (pending) console.log("[FB] answering the question sent with the booking details before confirming");
      return { response: pending ? `${pending}\n\n${bookingSuccessMessage(lang)}` : bookingSuccessMessage(lang), booked: true };
    } else if (result.error === "already_booked") {
      console.warn("[FB] Duplicate booking blocked by scheduler guard");
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
    }

    // Slot the client picked is full but OTHER slots may be open: offer the
    // soonest remaining one instead of handing off (never say it was "taken").
    // Keep the AI active so the client's next pick books normally.
    if (/^No availability/i.test(result.error ?? "")) {
      const recovery = await slotConflictRecoveryMessage(lang);
      if (recovery) {
        console.warn(`[FB] Slot ${bookingData.date} ${bookingData.time} full — offering alternative slots`);
        return { response: recovery, booked: false };
      }
    }

    // Booking genuinely failed (system error, or nothing open at all) — never
    // claim a false "slot just taken". Hand the hot lead to Ozzi but do NOT pause
    // the bot: an automatic failure must never permanently silence the lead
    // (mode="human" is only for a deliberate owner takeover).
    console.warn(`[FB] Booking failed (${result.error}) for ${bookingData.date} ${bookingData.time} — handing off to owner (staying active)`);
    return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
  } catch (err) {
    console.error("FB booking error:", err);
    return { response: aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim(), booked: false };
  }
}

// ─── [NOTIFY_OWNER] processor ─────────────────────────────────────────────
async function processNotifyOwner(
  aiResponse: string,
  conversationId: string,
  clientName: string | null,
  clientId: string
): Promise<string> {
  if (!/\[NOTIFY_OWNER\]/i.test(aiResponse)) return aiResponse;
  const clean = aiResponse.replace(/\[NOTIFY_OWNER\]/gi, "").trim();
  try {
    const { data: recentMsgs } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(8);
    await notifyOwners({
      platform: "Messenger",
      clientName,
      clientId,
      recentMessages: (recentMsgs ?? []).reverse(),
    });
  } catch (err) {
    console.error("FB processNotifyOwner error:", err);
  }
  return clean;
}

// ─── [CANCEL_BOOKING] processor ──────────────────────────────────────────
async function processCancelCommand(
  aiResponse: string,
  psid: string,
  conversationId: string
): Promise<string> {
  if (!/\[CANCEL_BOOKING\]/i.test(aiResponse)) return aiResponse;
  const clean = aiResponse.replace(/\[CANCEL_BOOKING\]/gi, "").trim();
  try {
    const result = await cancelClientBooking(`fb_${psid}`);
    if (result.success) {
      console.log(`FB: Cancelled ${result.cancelled} booking(s) for ${psid}`);
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: false })
        .eq("id", conversationId);
    }
  } catch (err) {
    console.error("FB cancel error:", err);
  }
  return clean;
}

// ─── Main message handler ─────────────────────────────────────────────────
async function handleFbMessage(body: Record<string, unknown>) {
  try {
    const { data: fbSetting } = await supabaseAdmin
      .from("platform_settings")
      .select("paused")
      .eq("platform", "facebook")
      .single();
    if (fbSetting?.paused) return;

    const entry = (body.entry as Record<string, unknown>[])?.[0];
    const messaging = (entry?.messaging as Record<string, unknown>[])?.[0];
    if (!messaging) return;

    // Echoes: a message SENT by the page. Two very different cases:
    //  (a) the bot's own API send echoing back — must be IGNORED (it is already
    //      saved to history; recording it as [Treino] would poison the owner
    //      corrections with every bot reply once message_echoes is subscribed);
    //  (b) a HUMAN typing from the Page Inbox (the owner taking over) — record
    //      it as [Treino] so the brain sees the correction AND pause the
    //      conversation (mode=human): on 2026-07-08 the owner manually offered
    //      Saturday 3pm, the bot could not see it and re-offered its own slots
    //      right after the client accepted. Owner takeover must silence the bot
    //      until "Reativar todas".
    if ((messaging.message as Record<string, unknown>)?.is_echo) {
      const echoText = (messaging.message as Record<string, unknown>)?.text as string;
      const echoSenderId = (messaging.sender as Record<string, unknown>)?.id as string;
      if (echoText && echoSenderId === FB_PAGE_ID) {
        const clientPsid = (messaging.recipient as Record<string, unknown>)?.id as string;
        if (clientPsid) {
          const { data: conv } = await supabaseAdmin
            .from("instagram_conversations")
            .select("id")
            .eq("igsid", `fb_${clientPsid}`)
            .maybeSingle();
          if (conv?.id) {
            // Bot-own echo? The bot saves every reply to history right after
            // sending, so an identical recent assistant message means this echo
            // is our own send — skip it. RACE GUARD: the echo can arrive BEFORE
            // the bot's history insert commits, so on a miss wait and re-check
            // before declaring this a human reply (wrongly pausing on the bot's
            // own echo would silence a live lead).
            // O conteúdo salvo pode carregar o sufixo interno "\n\n[SYSTEM: …]"
            // (FOLLOWUP_NUDGE do followup.ts, QUOTE_FOLLOWUP do /api/enviar) que
            // NUNCA vai no envio — sem removê-lo aqui, o eco do próprio nudge
            // não batia com a linha salva e era registrado como [Treino] com a
            // conversa pausada (mode=human): todo followup do Messenger matava o
            // lead em silêncio e envenenava as correções do dono (visto em 3
            // conversas na revisão de 2026-08-03).
            const norm = (s: string) => s.split(/\n\n?\[SYSTEM:/)[0].replace(/\s+/g, " ").trim().toLowerCase();
            const matchesRecentBot = async () => {
              const { data: recentBot } = await supabaseAdmin
                .from("instagram_messages")
                .select("content")
                .eq("conversation_id", conv.id)
                .eq("role", "assistant")
                .order("created_at", { ascending: false })
                .limit(5);
              return (recentBot ?? []).some((m) => norm(m.content) === norm(echoText));
            };
            let isOwnEcho = await matchesRecentBot();
            if (!isOwnEcho) {
              await new Promise((r) => setTimeout(r, 3000));
              isOwnEcho = await matchesRecentBot();
            }
            if (!isOwnEcho) {
              await supabaseAdmin.from("instagram_messages").insert({
                conversation_id: conv.id,
                role: "assistant",
                content: `[Treino] ${echoText}`,
              });
              await supabaseAdmin.from("instagram_conversations").update({ mode: "human" }).eq("id", conv.id);
              console.log(`[FB] owner manual reply captured — conversation ${conv.id} paused (mode=human)`);
            }
          }
        }
      }
      return;
    }

    const psid = (messaging.sender as Record<string, unknown>)?.id as string;
    if (!psid || psid === FB_PAGE_ID) return;

    const msg = messaging.message as Record<string, unknown>;
    const msgId = msg?.mid as string;
    if (!msgId) {
      // P2 (auditoria 28/07): clique em anúncio CTM dispara eventos SEM
      // message.mid — referral standalone (campo messaging_referrals) e
      // postback com referral embutido. Antes eram DESCARTADOS aqui, perdendo
      // o ad_id. Persistimos a atribuição na conversa (funil_ad_) e capturamos
      // o payload cru; a resposta ao cliente continua vindo do evento de
      // mensagem normal que chega em seguida.
      type RefFb = { ref?: string; source?: string; type?: string; ad_id?: string; ads_context_data?: { ad_title?: string; photo_url?: string; video_url?: string; post_id?: string } };
      const postbackFb = messaging.postback as { title?: string; payload?: string; referral?: RefFb } | undefined;
      const refSoloBruto = (messaging.referral as RefFb | undefined) ?? postbackFb?.referral;
      // clicked_at = timestamp do evento que trouxe o referral (proxy do clique).
      // O evento standalone messaging_referrals chega com timestamp em SEGUNDOS
      // (a mensagem chega em ms) — normalizar antes de converter.
      const tsSolo = (messaging.timestamp as number) || Date.now();
      const refSolo = refSoloBruto
        ? { ...refSoloBruto, clicked_at: new Date(tsSolo < 1e12 ? tsSolo * 1000 : tsSolo).toISOString() }
        : undefined;
      if (refSolo || postbackFb) {
        console.log("[FUNIL] referral cru (fb standalone):", JSON.stringify(refSolo ?? postbackFb).slice(0, 500));
        waitUntil(
          capturarRawFunil("fb", {
            origem: postbackFb ? "postback" : "referral_standalone",
            referral: refSolo ?? null,
            postback: postbackFb ? { title: postbackFb.title ?? null, payload: postbackFb.payload ?? null } : null,
          })
        );
        // AUDITORIA RASTREIO 04/08: referral só com ref/source também é
        // atribuição (o caminho de mensagem já persistia ad_ref/ad_source_type;
        // o standalone descartava). Paridade com o IG.
        if (refSolo?.ad_id || refSolo?.ads_context_data?.ad_title || refSolo?.ref || refSolo?.source) {
          const fbIgsidRef = `fb_${psid}`;
          let { data: convRef } = await supabaseAdmin
            .from("instagram_conversations")
            .select("id")
            .eq("igsid", fbIgsidRef)
            .maybeSingle();
          if (!convRef) {
            const { data: nova } = await supabaseAdmin
              .from("instagram_conversations")
              .insert({ igsid: fbIgsidRef, mode: "agent" })
              .select("id")
              .single();
            convRef = nova ?? null;
            if (!convRef) {
              // corrida com o evento de mensagem: recupera a linha existente
              const { data: existente } = await supabaseAdmin
                .from("instagram_conversations")
                .select("id")
                .eq("igsid", fbIgsidRef)
                .maybeSingle();
              convRef = existente ?? null;
            }
          }
          if (convRef?.id) await persistirAnuncioDaConversa(convRef.id, refSolo);
        }
      }
      return;
    }

    // Deduplicate
    const { data: already } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("instagram_msg_id", msgId)
      .maybeSingle();
    if (already) return;

    // Find or create conversation (igsid = "fb_{psid}")
    const fbIgsid = `fb_${psid}`;
    let { data: conv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("igsid", fbIgsid)
      .single();

    const wasNewConv = !conv;

    if (!conv) {
      const { data: newConv, error: convErr } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid: fbIgsid, mode: "agent" })
        .select()
        .single();
      if (convErr) {
        // Ad clicks fire two webhook events almost simultaneously (ad referral +
        // text). They race to create the conversation; the loser hits the unique
        // igsid constraint. Recover the row instead of dropping the message.
        const { data: existing } = await supabaseAdmin
          .from("instagram_conversations")
          .select("*")
          .eq("igsid", fbIgsid)
          .single();
        conv = existing ?? null;
      } else {
        conv = newConv;
      }
    }
    if (!conv) return;

    // Extract text and attachments
    const attachments = (msg?.attachments as Record<string, unknown>[]) ?? [];
    const imageAtt = attachments.find((a) => a.type === "image");

    // AUDITORIA RASTREIO 04/08: referral extraído ANTES dos returns de sticker/
    // emoji — um clique de anúncio cuja 1ª bolha é um sticker ou um emoji
    // sozinho morria nesses returns SEM persistir a atribuição (o funil só roda
    // depois do insert). O descarte da bolha continua igual.
    // referral pode vir nos 3 lugares: DENTRO da mensagem (message.referral),
    // no evento (messaging.referral) ou no postback (tratado no bloco sem mid).
    type RefFbMsg = { ref?: string; source?: string; type?: string; ad_id?: string; ads_context_data?: { ad_title?: string; photo_url?: string; video_url?: string; post_id?: string } };
    const refBruto =
      ((msg?.referral as RefFbMsg | undefined) ?? (messaging.referral as RefFbMsg | undefined)) ?? null;
    const tsMsg = (messaging.timestamp as number) || Date.now();
    const refComClique = refBruto
      ? { ...refBruto, clicked_at: new Date(tsMsg < 1e12 ? tsMsg * 1000 : tsMsg).toISOString() }
      : null;

    if ((imageAtt?.payload as Record<string, unknown>)?.sticker_id) {
      if (refComClique) waitUntil(persistirAnuncioDaConversa(conv.id, refComClique));
      return;
    }

    const audioAtt = attachments.find((a) => a.type === "audio");

    let rawText = (msg?.text as string) ?? "";

    if (rawText && !rawText.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F2FF}\u{1F900}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}]/gu, "").trim()) {
      if (refComClique) waitUntil(persistirAnuncioDaConversa(conv.id, refComClique));
      return;
    }

    const imageUrl = (imageAtt?.payload as Record<string, unknown>)?.url as string ?? null;
    const audioUrl = (audioAtt?.payload as Record<string, unknown>)?.url as string ?? null;

    // Ad reply context: client replied to one of our ads. Meta delivers reels as a
    // video/share attachment we don't recognize, often with no text — never drop it.
    const isAdReferral = !!messaging.referral;
    const hasAnyAttachment = attachments.length > 0;

    if (imageUrl && !rawText) rawText = "[floor plan or photo]";
    if (audioUrl && !rawText) rawText = "[voice message]";
    if (!rawText && (isAdReferral || hasAnyAttachment)) rawText = "[Client replied to our ad]";
    if (!rawText) return;

    // Pre-fetch image
    let preFetchedImageBase64: string | null = null;
    if (imageUrl) {
      preFetchedImageBase64 = await downloadFacebookAttachment(imageUrl).catch(() => null);
    }

    // Store message immediately
    const { data: insertedMsg, error: insertErr } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: conv.id,
        role: "user",
        content: rawText,
        instagram_msg_id: msgId,
      })
      .select("id, created_at")
      .single();

    if (insertErr && insertErr.code !== "23505") return;
    const thisMessageId = insertedMsg?.id ?? "";

    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conv.id);

    // ── FUNIL → Ozzi Plataforma (fire-and-forget, nunca bloqueia) ──
    // lead_criado (1ª mensagem, canal facebook, atribuição via referral CTM),
    // conversando (1ª resposta real) e retomou_conversa. Antes do gate
    // mode=human de propósito: a resposta do cliente conta para o funil mesmo
    // com o dono no controle. Só quando ESTA instância inseriu a mensagem.
    if (insertedMsg?.id) {
      // ── Atribuição de CRIATIVO ──
      // Fonte ÚNICA: o referral real da Meta (com ad_id/ads_context_data), que
      // chega nos 3 canais desde 28/07. Share NÃO atribui (post orgânico
      // compartilhado virava criativo falso). Referral cru vai pro log.
      if (messaging.referral) {
        console.log("[FUNIL] referral cru (fb):", JSON.stringify(messaging.referral).slice(0, 500));
      }
      // (refBruto/refComClique agora são extraídos ANTES dos returns de
      // sticker/emoji, no topo do handler — auditoria rastreio 04/08)
      const shareAtt = attachments.find((a) => a.type !== "image" && a.type !== "audio");
      // P0 (auditoria 28/07): captura crua persistente p/ provar o formato real
      if (refBruto || shareAtt) {
        waitUntil(
          capturarRawFunil("fb", {
            origem: "mensagem",
            referral: refBruto,
            anexos: attachments.map((a) => ({
              tipo: a.type,
              titulo: ((a.payload as Record<string, unknown> | undefined)?.title as string) ?? null,
              url: (((a.payload as Record<string, unknown> | undefined)?.url as string) ?? "").slice(0, 200),
            })),
          })
        );
      }
      // 29/07: o fallback de título de share FOI REMOVIDO da atribuição — o
      // referral real da Meta chega nos 3 canais (provado 14/14 em 29/07) e o
      // share de post ORGÂNICO virava criativo falso (casos "Amen🙏" e
      // "Have a blessed Wednesday"). Share segue capturado no raw p/ diagnóstico.
      const referralFunil = refComClique;
      waitUntil(
        funilOnInboundMessage(
          { id: conv.id, igsid: conv.igsid, name: conv.name, username: conv.username, created_at: conv.created_at },
          rawText,
          insertedMsg.created_at ?? new Date().toISOString(),
          referralFunil
        )
      );
      waitUntil(maybeRunFunilSilenceCheck()); // sweep parou_de_responder, no máx. a cada 6h
    }

    if (conv.mode === "human") {
      // Paused conversation black hole: ping the owner (throttled) if the
      // client keeps writing with nobody answering for over an hour.
      const pausedText = rawText;
      waitUntil(
        (async () => {
          const { data: lastBot } = await supabaseAdmin
            .from("instagram_messages")
            .select("created_at")
            .eq("conversation_id", conv.id)
            .eq("role", "assistant")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          await alertPausedBacklog({
            conversationId: conv.id,
            channel: "facebook",
            clientName: conv.name ?? conv.username ?? null,
            clientId: conv.igsid,
            lastHumanReplyAt: lastBot?.created_at ?? null,
            clientText: pausedText,
          });
        })().catch((e) => console.error("[FB] paused-backlog alert error:", e))
      );
      return;
    }

    // Debounce
    await new Promise((r) => setTimeout(r, RESPONSE_DELAY_MS));
    const { data: latestMsg } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conv.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .single();
    if (!latestMsg || latestMsg.id !== thisMessageId) return;

    // Re-fetch conversation BEFORE rate limit (catches booking_confirmed set by concurrent handler)
    const { data: freshConv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("id", conv.id)
      .single();
    if (freshConv) conv = freshConv;

    // ── Pause guard (post-debounce) ───────────────────────────────────────
    // Owner may have paused this conversation during the 10s debounce. freshConv
    // has the live mode — honor it before spending an AI call.
    if (conv.mode === "human") {
      console.log("[FB] Conversation paused during debounce — staying silent");
      return;
    }

    // Returning client who booked outside the bot (in person, manually): treat
    // as booked ONLY while a visit is actually upcoming. A client whose visit
    // is already behind us is a normal lead again — the old "never re-engage"
    // latch silenced quote requests and callbacks for WEEKS (2026-07-21 review).
    if (!wasNewConv && !(conv as Record<string, unknown>).booking_confirmed) {
      const served = await getClientBookingSnapshot(fbIgsid);
      if (served?.upcoming) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conv.id);
        (conv as Record<string, unknown>).booking_confirmed = true;
      }
    }

    // ── Stale booked flag: booking_confirmed only means "stay out of the way"
    //    while the visit is UPCOMING. Once the scheduler shows no future visit,
    //    reset the flag and let the client flow normally (with a PAST VISIT note
    //    so the model doesn't cold-pitch). Scheduler unreachable → keep legacy
    //    booked behavior (fail safe, never fail chatty). ──
    let isBooked = !!(conv as Record<string, unknown>).booking_confirmed;
    let bookedVisit: { date: string; time: string } | null = null;
    let pastVisitNote: string | null = null;
    if (isBooked) {
      const snap = await getClientBookingSnapshot(fbIgsid);
      if (snap && !snap.upcoming) {
        // GUARDA VISITA AFIRMADA (caso Msleo, 2026-08-05, IG): se a rajada
        // não-respondida AFIRMA uma visita já combinada (gate code, "we had a
        // confirmed appointment", aceite de horário sem oferta em aberto), o
        // acordo pode ter sido feito pelo dono FORA do bot e o scheduler estar
        // desatualizado — nunca re-engajar vendas nem afirmar disponibilidade:
        // ack neutro + dono. A flag NÃO é resetada.
        const { data: staleBurstMsgs } = await supabaseAdmin
          .from("instagram_messages")
          .select("role, content")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(10);
        const staleRows = (staleBurstMsgs ?? []).reverse();
        const staleBurst = unansweredUserBurst(staleRows) || rawText;
        const staleLastAsst = [...staleRows].reverse().find((m) => m.role === "assistant")?.content ?? null;
        if (assertsExistingAppointment(staleBurst, staleLastAsst)) {
          console.log("[FB] stale booked flag BUT client asserts an existing appointment — owner handoff, no re-engage");
          const handoff = appointmentMismatchHandoffMessage(detectLang(staleBurst));
          if (!(staleLastAsst && isConsecutiveDuplicate([{ role: "assistant", content: staleLastAsst }], handoff))) {
            const handoffSent = await sendFacebookMessage(psid, handoff);
            if (handoffSent.ok) {
              await supabaseAdmin.from("instagram_messages").insert({
                conversation_id: conv.id,
                role: "assistant",
                content: handoff,
              });
            }
          }
          try {
            const { data: recentMsgs } = await supabaseAdmin
              .from("instagram_messages")
              .select("role, content")
              .eq("conversation_id", conv.id)
              .order("created_at", { ascending: false })
              .limit(8);
            await notifyOwners({
              platform: "Messenger",
              clientName: (conv as Record<string, unknown>).username as string ?? null,
              clientId: psid,
              recentMessages: (recentMsgs ?? []).reverse(),
            });
          } catch (err) {
            console.error("[FB] appointment-mismatch notify error:", err);
          }
          return;
        }
        console.log("[FB] booked flag is stale (no upcoming visit) — re-engaging as a normal client");
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: false }).eq("id", conv.id);
        (conv as Record<string, unknown>).booking_confirmed = false;
        isBooked = false;
        pastVisitNote = pastVisitSystemNote(snap.lastPast);
      } else if (snap?.upcoming) {
        bookedVisit = snap.upcoming;
      }
    }

    // ── Reschedule intent: a booked client moving their visit is the one case we
    //    engage after a booking. Keep engaging while a reschedule is in progress
    //    (last assistant message offered slots), so the follow-up that just names
    //    the new day is still routed through the reschedule flow. ──
    let engageReschedule = isBooked && isRescheduleRequest(rawText);
    // Burst-aware: the 10s debounce means only the LAST bubble is judged, but
    // the reschedule intent may live in an earlier bubble of the same burst
    // (real IG silence 2026-07-20). Judge the whole un-answered burst.
    let gateBurst = "";
    if (isBooked && !engageReschedule) {
      const { data: burstMsgs } = await supabaseAdmin
        .from("instagram_messages")
        .select("role, content")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: false })
        .limit(10);
      gateBurst = unansweredUserBurst((burstMsgs ?? []).reverse());
      if (gateBurst && isRescheduleRequest(gateBurst)) engageReschedule = true;
    }
    if (isBooked && !engageReschedule && !isPureClosing(rawText)) {
      const { data: lastAsst } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastAsst?.content && containsSchedulingOffer(lastAsst.content)) engageReschedule = true;
    }

    // ── Booked client asking about their OWN visit ("Are you coming at 3?",
    //    "Which day, Tuesday?") → deterministic answer with the real booked
    //    date/time. No model call, so it can never invent a date; the owner is
    //    still notified. ──
    if (isBooked && !engageReschedule && bookedVisit && (isVisitDetailQuestion(rawText) || isVisitDetailQuestion(gateBurst))) {
      const details = visitDetailsMessage(detectLang(`${rawText} ${gateBurst}`), bookedVisit.date, bookedVisit.time);
      const { data: lastBotForDup } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!(lastBotForDup?.content && isConsecutiveDuplicate([{ role: "assistant", content: lastBotForDup.content }], details))) {
        const detailsSent = await sendFacebookMessage(psid, details);
        if (detailsSent.ok) {
          await supabaseAdmin.from("instagram_messages").insert({
            conversation_id: conv.id,
            role: "assistant",
            content: details,
          });
        }
      }
      try {
        const { data: recentMsgs } = await supabaseAdmin
          .from("instagram_messages")
          .select("role, content")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(8);
        await notifyOwners({
          platform: "Messenger",
          clientName: (conv as Record<string, unknown>).username as string ?? null,
          clientId: psid,
          recentMessages: (recentMsgs ?? []).reverse(),
        });
      } catch (err) {
        console.error("FB visit-details notify error:", err);
      }
      return;
    }

    // If already booked (and NOT rescheduling) → notify owner silently, no message
    if (isBooked && !engageReschedule) {
      try {
        const { data: recentMsgs } = await supabaseAdmin
          .from("instagram_messages")
          .select("role, content")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(8);
        await notifyOwners({
          platform: "Messenger",
          clientName: (conv as Record<string, unknown>).username as string ?? null,
          clientId: psid,
          recentMessages: (recentMsgs ?? []).reverse(),
        });
      } catch (err) {
        console.error("FB post-booking notify error:", err);
      }
      return;
    }

    // Rate limit: 5s window prevents genuine duplicates without blocking fast
    // client replies. EXCEPTION: a message carrying booking info (a street address
    // or a phone number) may be the one that COMPLETES the booking, so it must
    // never be silently dropped. A redundant "what's the address?" reply sent
    // moments earlier (when the slot and address arrive as two separate turns)
    // would otherwise rate-limit this turn and leave the visit unbooked.
    const carriesBookingInfo = containsBookingInfo(rawText);
    const { data: recentReply } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conv.id)
      .eq("role", "assistant")
      .gte("created_at", new Date(Date.now() - 5000).toISOString())
      .limit(1);
    if (recentReply && recentReply.length > 0 && !carriesBookingInfo) return;

    // Process media
    let enrichedText = rawText;
    let mediaProcessed = false;

    if (imageUrl && preFetchedImageBase64) {
      try {
        const analysis = await analyzeImageFromBase64(preFetchedImageBase64);
        if (analysis && !analysis.toLowerCase().includes("could not") && analysis.length > 20) {
          enrichedText = `[Floor plan analysis: ${analysis}]`;
          mediaProcessed = true;
        }
      } catch { /* ignore */ }
    }

    if (audioUrl) {
      try {
        const res = await fetch(audioUrl);
        if (res.ok) {
          const ct = res.headers.get("content-type") ?? "audio/mp4";
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 1000) {
            const transcript = await transcribeAudioFromBuffer(buf, ct);
            if (transcript && !transcript.includes("please type")) {
              enrichedText = transcript;
              mediaProcessed = true;
            }
          }
        }
      } catch { /* ignore */ }
    }

    // If the client typed real text (e.g. an ad reply with the pre-filled question),
    // always answer it even when an attached photo could not be analyzed.
    const clientHasText = !!(msg?.text as string)?.trim();
    const hasRealContent = clientHasText || mediaProcessed;

    if (!hasRealContent) {
      const fallback = imageUrl
        ? "Got your photo! If it is a floor plan, just type the total area in sqft or sqm and I will calculate right here. If it is a photo of your current floors, just describe what you need."
        : "Got your message! Could you type your question?";
      // Dedup: a client re-sending an unsupported attachment (e.g. two PDFs in a
      // row) used to get this identical canned line each time — a robotic repeat
      // (rule 29). Once is enough; stay silent on the repeat.
      const { data: lastBot } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1);
      if (lastBot?.[0] && isConsecutiveDuplicate([{ role: "assistant", content: lastBot[0].content }], fallback)) {
        console.log("[FB] no-content fallback identical to last reply — staying silent (no robotic repeat)");
        return;
      }
      const noContentSent = await sendFacebookMessage(psid, fallback);
      if (noContentSent.ok) {
        await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
      }
      return;
    }

    // Job seeker / service provider → do not respond at all (message still stored).
    if (isJobSeeker(enrichedText)) {
      console.log("[FB] Job seeker / service offer — staying silent");
      return;
    }

    // Update stored message with enriched content
    await supabaseAdmin.from("instagram_messages").update({ content: enrichedText }).eq("instagram_msg_id", msgId);

    // Fetch Facebook profile + capture the ad signals (ad_title / creative /
    // ad_id) just like Instagram does, so a later "what's included" turn still
    // knows which ad the lead came from (tile vs vinyl vs hardwood).
    try {
      const profile = await fetchFacebookProfile(psid);
      // MISSÃO REFERRAL 28/07: as colunas ad_id/ad_title/creative_url NÃO
      // EXISTEM em instagram_conversations — incluí-las fazia o update INTEIRO
      // falhar silencioso, perdendo o nome justamente dos leads de anúncio.
      // A atribuição persiste via funil_adx_/funil_ad_ (lib/funil).
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (profile.name || profile.profile_pic) {
        update.username = profile.name;
        update.profile_pic = profile.profile_pic;
      }
      await supabaseAdmin.from("instagram_conversations").update(update).eq("id", conv.id);
    } catch { /* ignore */ }

    // Load memories in parallel with timeout
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]).catch(() => null);

    const memoryStoreId: string | null = (conv as Record<string, unknown>).memory_store_id as string ?? null;
    let newMemoryStoreId = memoryStoreId;
    if (!newMemoryStoreId && process.env.ANTHROPIC_API_KEY) {
      try {
        newMemoryStoreId = await createClientMemoryStore(fbIgsid, conv.username);
        await supabaseAdmin.from("instagram_conversations").update({ memory_store_id: newMemoryStoreId }).eq("id", conv.id);
      } catch { /* ignore */ }
    }

    const [memoryContext, systemMemory] = await Promise.all([
      newMemoryStoreId ? withTimeout(readClientMemory(newMemoryStoreId), 3000) : Promise.resolve(null),
      process.env.ANTHROPIC_API_KEY
        ? withTimeout(getOrCreateSystemStore().then((id) => readSystemMemory(id)), 3000)
        : Promise.resolve(null),
    ]);

    // Load conversation history (created_at feeds the repeated-message
    // intercept so it can tell a double-tap from a genuine re-ask hours later)
    const { data: historyRaw } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: false })
      .limit(15);
    const history = (historyRaw ?? []).reverse();

    // The 15-message window can be ALL client bubbles when a conversation
    // accumulated many un-answered messages (the pre-fix booked-silence). Every
    // guard that anchors on "the last assistant message" (first-contact opener,
    // duplicate-send, closing-burst walk-back) then sees a fake first contact —
    // a real client asking about her quote got the canned opener this way
    // (Rosy, 2026-07-21). Keep at least the latest assistant reply in context.
    if (history.length > 0 && !history.some((m: { role: string }) => m.role === "assistant")) {
      const { data: lastAsstMsg } = await supabaseAdmin
        .from("instagram_messages")
        .select("role, content, created_at")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastAsstMsg) history.unshift(lastAsstMsg);
    }

    // DB flag only — history fallback removed: it kept firing after cancellations
    // because "Appointment confirmed" stays in history even after booking_confirmed=false.
    // When a booked client is rescheduling, treat as NOT confirmed this turn so the
    // bot engages (offers new slots) instead of staying silent.
    const isRescheduling = isBooked && engageReschedule;
    const isBookingConfirmed = isBooked && !isRescheduling;

    // Date context
    // Date context — always Eastern (server runs UTC; see scheduler helpers)
    const dateContext = getEasternDateContext();

    const lang = detectLang(history.map((m) => m.content).join(" "));

    type AiMsg = { role: "user" | "assistant"; content: string; at?: string };
    let messagesForAI: AiMsg[] = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content, at: m.created_at as string | undefined }));

    const lastIdx = messagesForAI.length - 1;
    if (lastIdx >= 0 && messagesForAI[lastIdx].role === "user") {
      // Only load availability when booking not yet confirmed
      const availability = isBookingConfirmed ? null : await getRealAvailabilityContext();
      const systemParts: string[] = availability ? [dateContext, availability] : [dateContext];
      const isOwnerHandled = !isBookingConfirmed && history.some((m: { role: string; content: string }) =>
        m.role === "assistant" && m.content?.startsWith("[Treino]") && !isStructuredCorrection(m.content)
      );
      if (isBookingConfirmed) {
        systemParts.push("[BOOKING ALREADY CONFIRMED: The appointment is set. Do NOT answer any question or continue the conversation. For ANY message the client sends — thank-you, question, or anything else — respond with EXACTLY ONE short sentence redirecting them to Ozzi, then add [NOTIFY_OWNER]. Example: 'I\\'ll connect you with Ozzi for anything else you need![NOTIFY_OWNER]' NEVER generate [BOOK:...]. NEVER say any slot is taken or unavailable. NEVER answer questions directly.]");
      }
      if (isOwnerHandled) {
        systemParts.push("[RETURNING CLIENT: This person already had work done or the owner personally handled them. Do not use the sales flow. Greet warmly and add [NOTIFY_OWNER].]");
      }
      if (pastVisitNote) {
        systemParts.push(pastVisitNote);
      }
      if (isRescheduling) {
        // CANCEL intent gets its own framing: routing "I need to cancel" into a
        // note that says the client "wants to MOVE the visit" made the model push
        // invented slots and never emit [CANCEL_BOOKING] (Priscilla, 2026-07-17).
        systemParts.push(isCancelRequest(rawText)
          ? "[RESCHEDULE MODE, CANCEL INTENT: This client has a confirmed visit and asked to CANCEL it. If they only want to cancel, acknowledge warmly in ONE sentence and end with [CANCEL_BOOKING]. You MAY lightly offer to pick another day instead, but NEVER push slots, NEVER state or assume a day or time they did not pick themselves, and NEVER claim any day works for them. Address them by name ONLY if certain it is the client's own name, otherwise use no name. If they clearly ask to move to a specific new day/time, treat it as a reschedule: offer slots from the schedule above and generate [BOOK:...] once they confirm.]"
          : "[RESCHEDULE MODE: This client already has a confirmed visit and wants to MOVE it to a different day or time. Acknowledge warmly, offer new open slots from the schedule above (or check the day they named), and the moment they confirm a new day and time, generate [BOOK:...] with the NEW date and time. Do NOT ask for the address or phone again, you already have them. Follow all date-integrity and availability rules.]");
      }
      // Detect the ad's flooring type so we answer with the RIGHT inclusions: a
      // TILE ad's promo is labor only (the client buys the tile), NOT the vinyl
      // "flooring + labor + quarter round" package. Detect from the ad signals
      // (ad_title / creative_url / ad_id — fresh or stored); if text is silent,
      // look at the ad creative image. Only when inconclusive do we ask the type
      // (the existing AD_REPLY_NOTE), so the working flows are never changed.
      if (!isBookingConfirmed) {
        const fbRef = messaging.referral as { ad_id?: string; ads_context_data?: { ad_title?: string; photo_url?: string } } | undefined;
        const convAny = conv as Record<string, unknown>;
        const adId = (fbRef?.ad_id ?? convAny.ad_id) as string | undefined;
        const adSignals = [
          fbRef?.ads_context_data?.ad_title, fbRef?.ad_id,
          convAny.ad_title as string | undefined,
          convAny.creative_url as string | undefined,
          convAny.ad_id as string | undefined,
        ];
        // Also true if ANY message in the thread carries the ad-reply / shared-reel
        // marker, so a reshared ad (no Meta referral, no stored ad columns) keeps
        // its ad note and the type-first guard on later turns.
        const isAdReply = isAdReferral || enrichedText.includes("[Client replied to our ad]") || adSignals.some(Boolean) ||
          messagesForAI.some((m) => m.role === "user" && /\[Client (?:replied to|shared a post\/reel from) our ad/i.test(m.content));
        let adType = detectAdFlooringType(...adSignals);
        // Still unknown? Actually SEE the ad: pull its creative (text + image)
        // from Meta by ad_id, then fall back to the creative thumbnail. Bounded to
        // the opening turn and persisted so the tile answer survives later turns.
        // Vision is conservative (only a clear 'tile' verdict is trusted); ad TEXT
        // is trusted for all three types.
        if (!adType && isAdReply && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          if (adId) {
            const ad = await withTimeout(fetchAdCreative(adId), 6000);
            if (ad?.text) resolved = detectAdFlooringType(ad.text);
            if (!resolved && ad?.imageUrl) {
              resolved = (await withTimeout(classifyAdCreativeType(ad.imageUrl), 6000)) === "tile" ? "tile" : null;
            }
          }
          if (!resolved) {
            const creative = fbRef?.ads_context_data?.photo_url ?? (convAny.creative_url as string | undefined);
            if (creative) resolved = (await withTimeout(classifyAdCreativeType(creative), 6000)) === "tile" ? "tile" : null;
          }
          if (resolved) {
            adType = resolved;
            // só em memória: a coluna ad_title não existe no banco (o update
            // antigo falhava silencioso — missão referral 28/07)
            Object.assign(convAny, { ad_title: `[${resolved}] ${(convAny.ad_title as string) ?? ""}`.trim() });
          }
        }
        if (adType) {
          systemParts.push(adFlooringTypeNote(adType));
        } else if (isAdReply) {
          // Ad lead, type still unknown → ask the type. The hardcoded "what's
          // included" intercept also reads this note and refuses to assume vinyl.
          systemParts.push(AD_REPLY_NOTE);
        }
      }
      if (!isBookingConfirmed) {
        const recentUserTexts = history
          .filter((m: { role: string; content: string }) => m.role === "user")
          .slice(-3)
          .map((m: { role: string; content: string }) => m.content);
        const detectedSqft = recentUserTexts.reduce<number | null>((found, t) => found ?? detectLargeLeadSqft(t), null);
        if (detectedSqft) {
          systemParts.push(`[LARGE LEAD ALERT: Client stated ${detectedSqft} sqft which is >= 500. This is a LARGE LEAD. You MUST propose the free in-person visit. Do NOT give any price or dollar amount by DM. Do NOT calculate "$X for this project". Respond with STEP 2B only.]`);
        }
      }
      const systemNote = `[SYSTEM: ${systemParts.join("\n\n")}]`;
      messagesForAI[lastIdx] = { ...messagesForAI[lastIdx], content: `${messagesForAI[lastIdx].content}\n\n${systemNote}` };
    }

    // ── Ad re-tap with zero client text → deterministic nudge, no model ──
    // The model answers a contentless re-tap with either the identical opener
    // (which the duplicate guard below silences) or [REACT_ONLY] — both dead
    // air for a lead who just came BACK to our ad. This case needs no model.
    const retapNudge = adRetapNudge(messagesForAI);
    if (retapNudge) {
      console.log("[FB] ad re-tap after opener — sending varied nudge instead of silence");
      const nudgeSent = await sendFacebookMessage(psid, retapNudge);
      if (nudgeSent.ok) {
        await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: retapNudge });
      }
      return;
    }

    const ownerCorrections = isBookingConfirmed ? null : await loadGlobalCorrections();
    let rawAiResponse: string;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const aiResult = await getAIResponse(
        messagesForAI,
        memoryContext,
        systemMemory,
        ownerCorrections,
        isBookingConfirmed
      );
      rawAiResponse = aiResult.text;
      inputTokens = aiResult.inputTokens;
      outputTokens = aiResult.outputTokens;
    } catch (aiErr) {
      // AI down (credits exhausted, rate limit, timeout, network). Never leave the
      // client in silence: send a graceful holding reply, hand to a human, notify owner.
      console.error("[FB] AI generation failed — handing off to owner:", aiErr);
      // Burst guard: don't stack the "team will reach out" handoff on top of a
      // good reply that a parallel handler just sent for a rapid message burst.
      const { data: justReplied } = await supabaseAdmin
        .from("instagram_messages")
        .select("id")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .gte("created_at", new Date(Date.now() - 30000).toISOString())
        .limit(1);
      if (justReplied && justReplied.length > 0) {
        console.log("[FB] AI failed but a reply was just sent — staying silent (no handoff)");
        return;
      }
      if (!isBookingConfirmed) {
        const fallback = aiOutageHandoffMessage(lang);
        // Outage dedup: during a sustained outage EVERY inbound hits this path —
        // one client once received this exact canned line 12 times in 90 minutes
        // (2026-07-06). If the last thing we sent is already this line, stay
        // silent; the client was told once and the owner was already notified.
        if (isConsecutiveDuplicate(messagesForAI, fallback)) {
          console.log("[FB] outage handoff already sent — staying silent (no repeat)");
          return;
        }
        try {
          const outageSent = await sendFacebookMessage(psid, fallback);
          if (outageSent.ok) {
            await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
          }
        } catch (sendErr) {
          console.error("[FB] Fallback send failed:", sendErr);
        }
        // Do NOT pause: an AI outage is transient. Leave the conversation in
        // "agent" mode so the next message retries once the API recovers.
        try {
          const { data: recentMsgs } = await supabaseAdmin
            .from("instagram_messages")
            .select("role, content")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: false })
            .limit(8);
          await notifyOwners({
            platform: "Facebook",
            clientName: (conv as Record<string, unknown>).username as string ?? null,
            clientId: psid,
            recentMessages: (recentMsgs ?? []).reverse(),
            alert: isLowCreditError(aiErr) ? CREDIT_ALERT : null,
          });
        } catch (notifyErr) {
          console.error("[FB] AI-outage notify failed:", notifyErr);
        }
      }
      return;
    }

    // Pure closing / thanks with no new question → stay silent instead of
    // sending another text (Messenger has no Page-side reaction API). Never
    // overrides the post-booking flow. Burst-aware: a trailing "thanks!" must NOT
    // silence the model's answer to an earlier, still-un-answered question that
    // the 10s debounce folded into this turn.
    if (!isBookingConfirmed && (/\[REACT_ONLY\]/i.test(rawAiResponse) || isPureClosingBurst(history))) {
      console.log("[FB] React-only (closing/thanks) — no text sent");
      return;
    }

    let safeResponse = (isBookingConfirmed
      ? rawAiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim()
      : rawAiResponse
    ).replace(/\[REACT_ONLY\]/gi, "").trim();

    // Universal safety net: never tell a client a slot "just got taken" / "pick
    // another time" in any state. Skip only when a [BOOK] tag is present.
    if (!/\[BOOK:/i.test(safeResponse)) {
      safeResponse = stripSlotConflictLanguage(safeResponse);
    }

    // Weekday↔date guard for the SENTENCE the client reads. reconcileBookingWeekday
    // only ever protected the [BOOK] payload, so "Thursday July 31" (a Friday) went
    // out to the client unchecked — they write the wrong date down (5-day review,
    // 2026-08-01). The weekday word wins; the day number is snapped to it.
    {
      const fixed = reconcileOfferedDates(safeResponse);
      if (fixed.corrections.length) {
        console.warn(`[FB] offered date corrected in outbound text: ${fixed.corrections.join("; ")}`);
        safeResponse = fixed.text;
      }
    }

    // ── Final pause guard (pre-send) ──────────────────────────────────────
    // Generating the reply takes 10-20s; the owner may have paused this
    // conversation or the whole Facebook channel meanwhile. Re-check live state
    // before any outbound action so a mid-flight pause is respected.
    {
      const [{ data: liveConv }, { data: livePlatform }] = await Promise.all([
        supabaseAdmin.from("instagram_conversations").select("mode").eq("id", conv.id).single(),
        supabaseAdmin.from("platform_settings").select("paused").eq("platform", "facebook").single(),
      ]);
      if (liveConv?.mode === "human") {
        console.log("[FB] Paused mid-flight — aborting before send");
        return;
      }
      if (livePlatform?.paused) {
        console.log("[FB] Facebook channel paused mid-flight — aborting before send");
        return;
      }
    }

    // ── Stale-context guard (pre-send) ────────────────────────────────────
    // Rapid-fire client bubbles (slot, then phone, then address separately) can
    // let an earlier bubble's 10s debounce elapse just before the next lands, so
    // this reply was built on STALE context (asks for info already sent, or never
    // books). If a newer user message arrived since we started, discard this stale
    // reply and let the newest message's handler answer with the COMPLETE context.
    {
      const { data: newestUser } = await supabaseAdmin
        .from("instagram_messages")
        .select("id")
        .eq("conversation_id", conv.id)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (newestUser && newestUser.id !== thisMessageId) {
        console.log("[FB] Newer client message arrived during generation — discarding stale reply");
        return;
      }
    }

    // ── Grace window before a redundant booking-info re-ask ───────────────
    // Clients routinely confirm the slot and then send the address (and phone)
    // as a SECOND message a few seconds later, just past the 10s debounce —
    // firing the re-ask the instant it lands looks like the bot ignored what was
    // just sent. Give that follow-up a short window: if a newer client message
    // arrives, discard this re-ask so the newest message's handler answers with
    // the COMPLETE context (slot + address + phone).
    if (!isBookingConfirmed && isAskingForBookingInfo(safeResponse)) {
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const { data: newer } = await supabaseAdmin
          .from("instagram_messages")
          .select("id")
          .eq("conversation_id", conv.id)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (newer && newer.id !== thisMessageId) {
          console.log("[FB] Booking-info follow-up arrived during grace window — discarding redundant re-ask");
          return;
        }
      }
    }

    const { response: afterBooking, booked } = await processBookingCommand(safeResponse, psid, conv.id, isBookingConfirmed, lang, isRescheduling, history);
    const afterCancel = await processCancelCommand(afterBooking, psid, conv.id);
    const afterNotify = await processNotifyOwner(afterCancel, conv.id, (conv as Record<string, unknown>).username as string ?? null, psid);
    const finalResponse = stripForbiddenTags(afterNotify);

    // Never send an empty message: a tag-only reply (bare [NOTIFY_OWNER], etc.)
    // strips to "" and the Graph API send silently fails, leaving the client with
    // no reply. The owner was already notified above if needed, so stay silent.
    if (!finalResponse.trim()) {
      console.warn("[FB] Empty response after tag stripping — staying silent (no empty send)");
      return;
    }

    void trackConversationMetrics(conv.id, "facebook", inputTokens, outputTokens, booked);

    // Rule 29 backstop: never send the exact same message twice in a row. A
    // re-tapped FAQ button used to get the identical reply again (robotic
    // loop). The client already has this answer directly above — stay silent.
    // Booking turns are exempt: a [BOOK:] confirmation must always go out.
    if (!booked && isConsecutiveDuplicate(messagesForAI, finalResponse)) {
      console.log("[FB] reply identical to previous bot message — staying silent (no robotic repeat)");
      return;
    }

    // A failed send aborts the turn BEFORE the reply is stored — recording an
    // undelivered reply hides the outage and suppresses the re-send (see the
    // 2026-07-22 IG token incident). Owner already alerted inside the send.
    const mainSent = await sendFacebookMessage(psid, finalResponse);
    if (!mainSent.ok) {
      // Outbox: store marked as undelivered — retryFailedSends re-sends it for
      // up to 48h (the 2026-07-22 14:38 UTC transient blip hit exactly here).
      console.error("[FB] final send FAILED — queued with SEND_FAILED for auto-retry");
      await supabaseAdmin.from("instagram_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: finalResponse + SEND_FAILED_DB_SUFFIX,
      });
      return;
    }
    await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: finalResponse });

    // Update memory in background
    if (newMemoryStoreId && process.env.ANTHROPIC_API_KEY) {
      const allMessages = [...messagesForAI, { role: "assistant" as const, content: finalResponse }];
      const memUpdate = extractMemoryUpdate(finalResponse, allMessages, {});
      if (memUpdate) {
        updateClientMemory(newMemoryStoreId, { ...memUpdate, client_name: conv.username || undefined })
          .catch((e) => console.error("FB memory update error:", e));
      }
    }
  } catch (err) {
    console.error("FB webhook error:", err);
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  console.log("[FB webhook] POST received | size:", rawBody.length, "| sig present:", !!sig);

  const sigOk = verifyMetaSignature(rawBody, sig);
  // CAIXA-PRETA (missão referral 28/07): grava o body BRUTO de TODO POST antes
  // de qualquer parsing/filtro/return — echo/delivery/assinatura inválida
  // inclusos. Retenção 7 dias. É a prova do que a Meta entrega (ou não).
  waitUntil(capturarWebhookRaw("fb", rawBody, { sigOk }));

  if (!sigOk) {
    console.warn("[FB webhook] Signature verification FAILED — returning 403");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const body = JSON.parse(rawBody);
  if (!body || body.object !== "page") {
    console.log("[FB webhook] Ignored — object:", body?.object);
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const messaging = (body.entry as Record<string, unknown>[])?.[0];
  const sender = ((messaging?.messaging as Record<string, unknown>[])?.[0]?.sender as Record<string, unknown>)?.id;
  console.log("[FB webhook] Processing message from:", sender);
  waitUntil(handleFbMessage(body));
  // Outbox: webhook traffic doubles as the heartbeat for re-sending replies
  // whose delivery failed (self-throttled to 1 sweep / 10 min).
  waitUntil(retryFailedSends());
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
