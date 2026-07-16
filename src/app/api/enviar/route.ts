import { NextRequest, NextResponse } from "next/server";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { supabaseAdmin } from "@/lib/supabase";
import { isStrongAdminSecret } from "@/lib/admin-auth";
import {
  composeQuoteFollowup,
  sanitizeOutbound,
  FOLLOWUP_STAGES,
  MAX_MESSAGE_LENGTH,
  type FollowupLang,
  type FollowupStage,
  type ComposeResult,
} from "@/lib/quote-followup";

// ─── POST /api/enviar — outbound WhatsApp for the Ozzi Plataforma ────────────
// The platform decides WHO and WHEN; this route decides HOW it is worded and
// owns the actual Z-API send, so every message to a client keeps one voice and
// lands in the same conversation history the bot reads when the client replies.
//
//   Header: x-admin-secret: <ADMIN_SECRET>   (strong secret only — see admin-auth.ts)
//
//   {"tipo":"mensagem_direta","telefone":"5561...","mensagem":"..."}
//     → sends the text EXACTLY as supplied (this is the owner's morning report).
//
//   {"tipo":"followup","telefone":"...","idioma":"en"|"es","etapa":"D1|D3|D7|D14|D30",
//    "cliente":{"nome":"...","primeiro_nome":"..."},
//    "quote":{"valor":4500,"parcela_36x":125,"dias_desde_orcamento":3},
//    "sugestao_texto":"..."}
//     → WE write the message from that context, then send it and record it in the
//       client's conversation history.
//
//   Optional on both: "dry": true → build/compose only, send nothing (preview).
//
// Responses: 200 {"ok":true,...} on send; >=400 {"ok":false,"erro":"..."} otherwise.
export const maxDuration = 60;

const OK_TIPOS = ["mensagem_direta", "followup"] as const;
type Tipo = (typeof OK_TIPOS)[number];

function erro(status: number, msg: string) {
  return NextResponse.json({ ok: false, erro: msg }, { status });
}

// E.164 allows at most 15 digits; anything under 8 cannot be a real number.
// Z-API expects bare digits (country code included), which is also how the
// wa-webhook stores the chat id, so igsid stays "wa_<digits>" on both sides.
function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

// Best effort: put the message we just sent into the client's history so the
// brain has context when they reply. NEVER throws — a DB hiccup must not turn a
// delivered WhatsApp message into an error the platform will retry (which would
// double-send to a real client).
async function recordInHistory(phone: string, text: string): Promise<boolean> {
  try {
    const igsid = `wa_${phone}`;
    let { data: conv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id")
      .eq("igsid", igsid)
      .maybeSingle();

    if (!conv) {
      const { data: created, error: insErr } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid, mode: "agent" })
        .select("id")
        .single();
      if (insErr) {
        // Lost a race against the webhook creating the same conversation.
        const { data: existing } = await supabaseAdmin
          .from("instagram_conversations")
          .select("id")
          .eq("igsid", igsid)
          .maybeSingle();
        conv = existing ?? null;
      } else {
        conv = created;
      }
    }
    if (!conv) return false;

    const { error } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: text,
    });
    if (error) {
      console.error("[ENVIAR] history insert failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[ENVIAR] history record exception:", err);
    return false;
  }
}

export async function POST(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  if (!isStrongAdminSecret(req.headers.get("x-admin-secret"))) {
    return erro(401, "Unauthorized");
  }

  // ── Body ───────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return erro(400, "corpo invalido: envie JSON");
  }
  if (!body || typeof body !== "object") return erro(400, "corpo invalido: envie um objeto JSON");

  const tipo = body.tipo as Tipo;
  if (!OK_TIPOS.includes(tipo)) {
    return erro(400, `tipo invalido, use um de: ${OK_TIPOS.join(", ")}`);
  }

  const telefone = normalizePhone(body.telefone);
  if (!telefone) return erro(400, "telefone invalido: envie apenas digitos, com codigo do pais (8 a 15 digitos)");

  const dry = body.dry === true;

  // ── Build the text ─────────────────────────────────────────────────────────
  // "exato" = mensagem_direta literal; os demais vêm do compositor e dizem à
  // plataforma se o texto saiu do modelo, do retry, do rascunho dela, ou do
  // template de segurança — útil para ela monitorar a qualidade dos envios.
  let texto: string;
  let origem: "exato" | ComposeResult["source"] = "exato";

  if (tipo === "mensagem_direta") {
    // Sent EXACTLY as supplied — this carries the owner's morning report, so we
    // must not rewrite, sanitize, or "improve" a single character of it.
    const mensagem = body.mensagem;
    if (typeof mensagem !== "string" || !mensagem.trim()) {
      return erro(400, "mensagem obrigatoria para tipo=mensagem_direta");
    }
    if (mensagem.length > MAX_MESSAGE_LENGTH) {
      return erro(400, `mensagem muito longa (${mensagem.length}), o limite do WhatsApp e ${MAX_MESSAGE_LENGTH} caracteres`);
    }
    texto = mensagem;
  } else {
    const idioma = body.idioma as FollowupLang;
    if (idioma !== "en" && idioma !== "es") return erro(400, "idioma invalido, use 'en' ou 'es'");

    const etapa = body.etapa as FollowupStage;
    if (!FOLLOWUP_STAGES.includes(etapa)) {
      return erro(400, `etapa invalida, use uma de: ${FOLLOWUP_STAGES.join(", ")}`);
    }

    const cliente = (body.cliente ?? null) as { nome?: string; primeiro_nome?: string } | null;
    const quote = (body.quote ?? null) as { valor?: number; parcela_36x?: number; dias_desde_orcamento?: number } | null;
    const sugestao = typeof body.sugestao_texto === "string" ? body.sugestao_texto : null;

    try {
      const composed = await composeQuoteFollowup({ idioma, etapa, cliente, quote, sugestao_texto: sugestao });
      texto = composed.text;
      origem = composed.source;
    } catch (err) {
      console.error("[ENVIAR] compose failed:", err);
      return erro(502, `nao foi possivel escrever a mensagem: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
    }
  }

  const textoFinal = tipo === "mensagem_direta" ? texto : sanitizeOutbound(texto);
  if (!textoFinal.trim()) return erro(400, "mensagem vazia apos o processamento");

  if (dry) {
    return NextResponse.json({ ok: true, dry: true, enviado: false, mensagem: textoFinal, origem });
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const result = await sendWhatsAppMessage(telefone, textoFinal);
  if (!result.ok) {
    console.error(`[ENVIAR] Z-API send failed phone=${telefone} status=${result.status} erro=${result.error}`);
    // Surface Z-API's own status when it is a real HTTP error, so the platform
    // can tell "rejected" from "unreachable" — EXCEPT 401/403. On this endpoint
    // those two mean exactly one thing to the caller ("your x-admin-secret is
    // wrong"), so letting Z-API's own auth failure wear them would send the
    // integrator hunting a secret that is perfectly fine. Our auth already
    // returned above; anything here is upstream, hence 502.
    const raw = result.status;
    const status = raw >= 400 && raw <= 599 && raw !== 401 && raw !== 403 ? raw : 502;
    return NextResponse.json(
      { ok: false, erro: `falha ao enviar pelo WhatsApp: ${result.error ?? "erro desconhecido"}`, zapiStatus: result.status },
      { status }
    );
  }

  // Record ONLY the AI-written follow-ups: those go to real clients and the brain
  // needs the context when they reply. A mensagem_direta is the owner's own
  // report, so writing it into a conversation would fabricate a client thread.
  let registrado = false;
  if (tipo === "followup") registrado = await recordInHistory(telefone, textoFinal);

  console.log(`[ENVIAR] ok tipo=${tipo} phone=${telefone} origem=${origem} registrado=${registrado}`);
  return NextResponse.json({ ok: true, enviado: true, mensagem: textoFinal, origem, registrado });
}

// A GET is almost always a human poking the URL in a browser. Answer with the
// usage instead of Next's default 405 HTML, but never reveal anything secret.
export async function GET() {
  return NextResponse.json({
    ok: true,
    rota: "POST /api/enviar",
    auth: "header x-admin-secret",
    tipos: OK_TIPOS,
  });
}
