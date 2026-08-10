import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { supabaseAdmin } from "@/lib/supabase";

// ─── POST /api/confirmar-instalacao — confirmação de instalação via WhatsApp ─
// Chamado por sistemas externos (ex.: Ozzi Plataforma) quando uma instalação é
// marcada. Envia ao cliente a mensagem de confirmação com data e contato do
// vendedor, pela mesma instância Z-API do bot, e registra no histórico da
// conversa para o cérebro ter contexto quando o cliente responder.
//
//   Header: Authorization: Bearer <INSTALACAO_TOKEN>
//
//   {"nome_cliente":"John","telefone_cliente":"15615551234",
//    "data_instalacao":"Monday, Aug 17","nome_vendedor":"Ozzi",
//    "telefone_vendedor":"15616748334"}
//
//   Obrigatórios: telefone_cliente e data_instalacao — sem eles NADA é enviado
//   e o erro fica no log. Os demais campos só enriquecem a mensagem.
//   Opcional: "dry": true → monta a mensagem e devolve sem enviar (preview).
//
// Responses: 200 {"ok":true,...} | 400 campos inválidos | 401 token errado | 502 Z-API.
export const maxDuration = 60;

// Mesma disciplina do /api/enviar (admin-auth.ts): este endpoint dispara
// WhatsApp para números arbitrários, então ele FALHA FECHADO — se o
// INSTALACAO_TOKEN não estiver configurado (ou for curto demais para ser um
// segredo de verdade), nenhum token abre a porta. Hash dos dois lados antes de
// comparar: tempo constante e nunca lança por diferença de tamanho.
const MIN_TOKEN_LENGTH = 32;

function isAuthorized(authHeader: string | null): boolean {
  const expected = process.env.INSTALACAO_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  const given = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!given) return false;
  const ha = createHash("sha256").update(given, "utf8").digest();
  const hb = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// Z-API espera só dígitos com código do país — igual ao /api/enviar, e igual a
// como o wa-webhook guarda o chat (igsid "wa_<digitos>").
function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function asText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t.slice(0, 200) : null;
}

// A clientela fala inglês/espanhol; todo texto do bot ao cliente é em inglês,
// então o template segue o mesmo idioma. Campos opcionais ausentes degradam a
// mensagem em vez de derrubar o envio.
function composeConfirmation(params: {
  nomeCliente: string | null;
  dataInstalacao: string;
  nomeVendedor: string | null;
  telefoneVendedor: string | null;
}): string {
  const { nomeCliente, dataInstalacao, nomeVendedor, telefoneVendedor } = params;
  const partes: string[] = [];

  partes.push(nomeCliente ? `Hi ${nomeCliente}! This is Ozzi Floors 😊` : `Hi! This is Ozzi Floors 😊`);
  partes.push(`Great news — your flooring installation is confirmed for ${dataInstalacao}.`);

  if (nomeVendedor && telefoneVendedor) {
    partes.push(`${nomeVendedor} will be taking care of your installation. If you need anything, you can reach them directly at ${telefoneVendedor}.`);
  } else if (nomeVendedor) {
    partes.push(`${nomeVendedor} will be taking care of your installation.`);
  } else if (telefoneVendedor) {
    partes.push(`If you need anything before then, you can reach our team at ${telefoneVendedor}.`);
  }

  partes.push(`See you soon! 🏠`);
  return partes.join("\n\n");
}

// Best effort: grava a mensagem no histórico da conversa do cliente (mesmo
// padrão do /api/enviar). NUNCA lança — uma falha de DB não pode transformar um
// WhatsApp já entregue em erro que o chamador vai re-tentar (dobraria o envio).
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
        // Perdeu a corrida contra o webhook criando a mesma conversa.
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
      console.error("[INSTALACAO] history insert failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[INSTALACAO] history record exception:", err);
    return false;
  }
}

function erro(status: number, msg: string) {
  return NextResponse.json({ ok: false, erro: msg }, { status });
}

export async function POST(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  if (!isAuthorized(req.headers.get("authorization"))) {
    console.error("[INSTALACAO] 401: token ausente ou incorreto");
    return erro(401, "Unauthorized");
  }

  // ── Body ───────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    console.error("[INSTALACAO] corpo inválido: não é JSON");
    return erro(400, "corpo invalido: envie JSON");
  }
  if (!body || typeof body !== "object") {
    console.error("[INSTALACAO] corpo inválido: não é objeto");
    return erro(400, "corpo invalido: envie um objeto JSON");
  }

  // ── Validação: sem telefone_cliente ou data_instalacao NADA é enviado ──────
  const telefoneCliente = normalizePhone(body.telefone_cliente);
  const dataInstalacao = asText(body.data_instalacao);
  const faltando: string[] = [];
  if (!telefoneCliente) faltando.push("telefone_cliente");
  if (!dataInstalacao) faltando.push("data_instalacao");
  if (faltando.length) {
    console.error(
      `[INSTALACAO] envio ABORTADO, campos obrigatorios ausentes/invalidos: ${faltando.join(", ")} ` +
        `(recebido telefone_cliente=${JSON.stringify(body.telefone_cliente ?? null)} data_instalacao=${JSON.stringify(body.data_instalacao ?? null)})`
    );
    return erro(400, `campos obrigatorios ausentes ou invalidos: ${faltando.join(", ")}`);
  }

  const nomeCliente = asText(body.nome_cliente);
  const nomeVendedor = asText(body.nome_vendedor);
  const telefoneVendedor = asText(body.telefone_vendedor);

  const mensagem = composeConfirmation({
    nomeCliente,
    dataInstalacao: dataInstalacao!,
    nomeVendedor,
    telefoneVendedor,
  });

  if (body.dry === true) {
    return NextResponse.json({ ok: true, dry: true, enviado: false, mensagem });
  }

  // ── Envio ──────────────────────────────────────────────────────────────────
  const result = await sendWhatsAppMessage(telefoneCliente!, mensagem);
  if (!result.ok) {
    console.error(`[INSTALACAO] Z-API send failed phone=${telefoneCliente} status=${result.status} erro=${result.error}`);
    // 401/403 do Z-API não podem vazar como status NOSSO — aqui eles significam
    // "seu Bearer está errado", o que mandaria o integrador caçar o token à toa.
    const raw = result.status;
    const status = raw >= 400 && raw <= 599 && raw !== 401 && raw !== 403 ? raw : 502;
    return NextResponse.json(
      { ok: false, erro: `falha ao enviar pelo WhatsApp: ${result.error ?? "erro desconhecido"}`, zapiStatus: result.status },
      { status }
    );
  }

  const registrado = await recordInHistory(telefoneCliente!, mensagem);

  console.log(`[INSTALACAO] ok phone=${telefoneCliente} data=${dataInstalacao} vendedor=${nomeVendedor ?? "-"} registrado=${registrado}`);
  return NextResponse.json({ ok: true, enviado: true, mensagem, registrado });
}

// Um GET é quase sempre um humano cutucando a URL no navegador. Responde com o
// uso em vez do 405 padrão, sem revelar nada secreto.
export async function GET() {
  return NextResponse.json({
    ok: true,
    rota: "POST /api/confirmar-instalacao",
    auth: "header Authorization: Bearer <token>",
    obrigatorios: ["telefone_cliente", "data_instalacao"],
    opcionais: ["nome_cliente", "nome_vendedor", "telefone_vendedor", "dry"],
  });
}
