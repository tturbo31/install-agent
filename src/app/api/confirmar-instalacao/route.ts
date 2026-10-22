import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { sendWhatsAppMessage, notifyOwners } from "@/lib/whatsapp";
import { stripInvertedPunctuation } from "@/lib/outbound-text";
import { supabaseAdmin } from "@/lib/supabase";
import {
  sanitizeInstallDate,
  stripInstallTime,
  formatInstallDateTime,
  installTimeAlert,
  INSTALL_ARRIVAL_WINDOW,
  INSTALL_FALLBACK_CONTACT,
  INSTALL_DEDUP_HOURS,
  isDuplicateInstallNotice,
  checkInstallDateIsTomorrow,
  installBlockedAlert,
  installUnverifiedAlert,
} from "@/lib/instalacao";
import { registrarChamadaInstalacao } from "@/lib/instalacao-log";
import { verificarObraNaPlataforma } from "@/lib/instalacao-verificar";

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
//   SEM VENDEDOR (regra do dono 22/10/2026): nome_vendedor/telefone_vendedor
//   ausentes → o contato na mensagem é o Ozzi, (561) 674-8334. O integrador
//   deve chamar mesmo sem vendedor, nunca inventar um.
//   Opcional: "dry": true → monta a mensagem e devolve sem enviar (preview).
//   Opcional: "data_instalacao_iso": "2026-08-26T14:00:00-04:00" (ISO 8601 COM
//     fuso). Quando presente e válido, NÓS formatamos a data em horário da
//     Flórida ("Wednesday, August 26 at 10am") e o texto de data_instalacao é
//     ignorado — caminho recomendado desde 25/08/2026.
//
//   GUARDA DE HORÁRIO (25/08/2026, caso Sarah McKnight): o texto chegou como
//   "Wednesday, August 26 at 5am" para uma instalação às 10am. Horário fora de
//   7h–19h é REMOVIDO da mensagem (vai só a data), a resposta traz
//   "horario_suspeito" e o dono recebe um alerta para confirmar a hora.
//
//   SEM HORÁRIO DO JOB (regra do dono 27/08/2026): o aviso de véspera dizia
//   "confirmed for Wednesday, August 26 at 10am" — o horário do job NÃO deve
//   aparecer. A mensagem agora diz que a instalação COMEÇA AMANHÃ e que a
//   equipe chega entre 10am e 11am com os materiais. Qualquer horário no texto
//   (livre ou ISO) é removido; a guarda de 7h–19h continua só para ALERTAR o
//   dono quando o job no app está com hora absurda (5am).
//
//   TRAVA DE DUPLICIDADE (21/10/2026): o mesmo telefone já avisado há menos de
//   INSTALL_DEDUP_HOURS (20h) NÃO recebe um segundo "starts tomorrow" — a
//   resposta é 200 {"ok":true,"enviado":false,"duplicado":true} para o
//   integrador não marcar erro nem re-tentar. Fail-open: se a consulta ao
//   histórico falhar, o aviso sai (um aviso a mais é melhor que nenhum).
//
//   REGISTRO DE TODA CHAMADA (21/10/2026): 401, 400, duplicada, ok, falha do
//   Z-API e dry viram uma linha legível no banco (instalacao-log.ts) — a prova
//   do que o Lovable mandou sobrevive aos ~45 min dos logs da Vercel.
//   Leitura: scripts/check-avisos-instalacao.mjs.
//
//   SÓ QUEM TEM OBRA AMANHÃ (22/10/2026, caso Dayana): o app chamou com
//   "Friday, October 23" para uma cliente SEM obra marcada ("You have the wrong
//   number"). Duas travas, ANTES de qualquer envio:
//     1. a data recebida tem que ser AMANHÃ na Flórida (checkInstallDateIsTomorrow);
//     2. a plataforma confirma que o cliente não tem obra já concluída sem
//        contrato novo depois (GET /api/instalacao/verificar da plataforma).
//   Bloqueio → 409 {"ok":false,"bloqueado":true,"motivo":...} (o app marca
//   revisão manual) + alerta ao dono. Plataforma fora do ar → 503 e NADA sai
//   (falha fechada: aqui um aviso errado é o dano grave) + alerta ao dono.
//   `dry` passa pelas mesmas travas e devolve bloqueado/motivo sem bloquear.
//
// Responses: 200 {"ok":true,...} | 400 campos inválidos | 401 token errado |
//            409 bloqueado | 502 Z-API | 503 verificação na plataforma indisponível.
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
  // Sem horário do job: "starts tomorrow" + data + janela de chegada da equipe.
  partes.push(
    `Just a quick reminder — your flooring installation starts tomorrow, ${dataInstalacao}. ` +
      `Our installation team will arrive ${INSTALL_ARRIVAL_WINDOW} with the materials.`
  );

  // Quem executa o serviço é a EQUIPE DE INSTALADORES; o vendedor que fez o
  // orçamento é só o CONTATO para dúvidas (regra do dono 2026-08-14). A versão
  // antiga dizia "<vendedor> will be taking care of your installation", o que
  // fazia o cliente entender que o representante de vendas faria a instalação.
  // (A equipe já foi nomeada como executora na frase de cima.)
  // Sem vendedor completo (nome E telefone) o contato é o Ozzi — regra do dono
  // 22/10/2026 (Jeff Jacobs, job sem vendedor): o aviso nunca sai sem contato.
  if (nomeVendedor && telefoneVendedor) {
    partes.push(`If you have any questions, you can reach out directly to ${nomeVendedor}, the sales rep who put together your estimate, at ${telefoneVendedor}.`);
  } else {
    partes.push(`If you have any questions, you can reach out directly to ${INSTALL_FALLBACK_CONTACT.nome} at ${INSTALL_FALLBACK_CONTACT.telefone}.`);
  }

  partes.push(`See you soon! 🏠`);
  return partes.join("\n\n");
}

// Já mandamos o aviso de véspera para este telefone nas últimas 20h? Devolve
// quando foi, ou null. NUNCA lança: falha de leitura = "não sei" = deixa enviar.
async function findDuplicateNotice(phone: string, now: Date): Promise<string | null> {
  try {
    const { data: conv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id")
      .eq("igsid", `wa_${phone}`)
      .maybeSingle();
    if (!conv) return null;
    const since = new Date(now.getTime() - INSTALL_DEDUP_HOURS * 3600_000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conv.id)
      .eq("role", "assistant")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) {
      console.error("[INSTALACAO] consulta de duplicidade falhou:", error.message);
      return null;
    }
    const rows = (data ?? []) as Array<{ role: string; content: string; created_at: string | null }>;
    if (!isDuplicateInstallNotice(rows, now)) return null;
    // A mais recente que é aviso (isDuplicateInstallNotice já garantiu que existe).
    for (let i = rows.length - 1; i >= 0; i--) {
      if (/installation (?:is confirmed for|starts tomorrow)/i.test(rows[i].content ?? "")) return rows[i].created_at;
    }
    return null;
  } catch (err) {
    console.error("[INSTALACAO] consulta de duplicidade exception:", err);
    return null;
  }
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

    // Gravar EXATAMENTE o que foi enviado (sendWhatsAppMessage limpa ¿¡).
    const { error } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: stripInvertedPunctuation(text),
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

function erro(status: number, msg: string, extras?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, erro: msg, ...(extras ?? {}) }, { status });
}

export async function POST(req: NextRequest) {
  const agora = new Date();

  // ── Auth ───────────────────────────────────────────────────────────────────
  if (!isAuthorized(req.headers.get("authorization"))) {
    console.error("[INSTALACAO] 401: token ausente ou incorreto");
    // 1 linha por hora: qualquer um consegue provocar 401, o registro não pode virar inundação.
    await registrarChamadaInstalacao(
      { st: "401", tel: null, nome: null, data: null, rec: null, vend: null, tv: null, hs: null, iso: false, err: "token ausente ou incorreto" },
      { bucketMs: 3600_000 }
    );
    return erro(401, "Unauthorized");
  }

  // ── Body ───────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    console.error("[INSTALACAO] corpo inválido: não é JSON");
    await registrarChamadaInstalacao({ st: "400", tel: null, nome: null, data: null, rec: null, vend: null, tv: null, hs: null, iso: false, err: "corpo invalido: nao e JSON" });
    return erro(400, "corpo invalido: envie JSON");
  }
  if (!body || typeof body !== "object") {
    console.error("[INSTALACAO] corpo inválido: não é objeto");
    await registrarChamadaInstalacao({ st: "400", tel: null, nome: null, data: null, rec: null, vend: null, tv: null, hs: null, iso: false, err: "corpo invalido: nao e objeto" });
    return erro(400, "corpo invalido: envie um objeto JSON");
  }

  // ── Validação: sem telefone_cliente ou data_instalacao NADA é enviado ──────
  const telefoneCliente = normalizePhone(body.telefone_cliente);
  const dataInstalacao = asText(body.data_instalacao);
  const nomeCliente = asText(body.nome_cliente);
  const nomeVendedor = asText(body.nome_vendedor);
  const telefoneVendedor = asText(body.telefone_vendedor);
  const faltando: string[] = [];
  if (!telefoneCliente) faltando.push("telefone_cliente");
  if (!dataInstalacao) faltando.push("data_instalacao");
  if (faltando.length) {
    const motivo = `campos obrigatorios ausentes ou invalidos: ${faltando.join(", ")}`;
    console.error(
      `[INSTALACAO] envio ABORTADO, ${motivo} ` +
        `(recebido telefone_cliente=${JSON.stringify(body.telefone_cliente ?? null)} data_instalacao=${JSON.stringify(body.data_instalacao ?? null)})`
    );
    await registrarChamadaInstalacao({
      st: "400",
      tel: telefoneCliente,
      nome: nomeCliente,
      data: null,
      rec: dataInstalacao ?? asText(String(body.data_instalacao ?? "")),
      vend: nomeVendedor,
      tv: telefoneVendedor,
      hs: null,
      iso: false,
      err: `${motivo} (telefone_cliente=${JSON.stringify(body.telefone_cliente ?? null)})`,
    });
    return erro(400, motivo);
  }

  // Data final: ISO com fuso (formatada por nós) ganha do texto livre. A guarda
  // de horário implausível vale para OS DOIS caminhos: o Lovable grava job
  // "all_day" com o placeholder 09:00Z (= 5am na Flórida) — se um dia esse
  // placeholder vier como ISO, ele NÃO pode virar "at 5am" só por ser ISO.
  const viaIso = typeof body.data_instalacao_iso === "string" ? formatInstallDateTime(body.data_instalacao_iso) : null;
  const guarda = sanitizeInstallDate(viaIso ?? dataInstalacao!);
  // Regra 27/08/2026: o horário do job NUNCA vai ao cliente, plausível ou não.
  const dataFinal = stripInstallTime(guarda.text);
  if (guarda.horarioSuspeito) {
    console.warn(
      `[INSTALACAO] horario IMPLAUSIVEL "${guarda.horarioSuspeito}" em data_instalacao=${JSON.stringify(dataInstalacao)} ` +
        `phone=${telefoneCliente} — enviando so a data (${JSON.stringify(dataFinal)})`
    );
  }

  const mensagem = composeConfirmation({
    nomeCliente,
    dataInstalacao: dataFinal,
    nomeVendedor,
    telefoneVendedor,
  });

  const base = {
    tel: telefoneCliente,
    nome: nomeCliente,
    data: dataFinal,
    rec: dataInstalacao,
    vend: nomeVendedor,
    tv: telefoneVendedor,
    hs: guarda.horarioSuspeito,
    iso: !!viaIso,
  };

  // ── Trava 1 (22/10/2026): "starts tomorrow" só com data de AMANHÃ ──────────
  const dataCheck = checkInstallDateIsTomorrow(dataInstalacao!, agora);
  // ── Trava 2 (22/10/2026): a plataforma confirma que não é obra já concluída ─
  // (não gasta a chamada quando a data já reprovou)
  const verif = dataCheck.status === "nao_e_amanha" ? null : await verificarObraNaPlataforma(telefoneCliente!);
  let bloqueio: { st: "bloqueado" | "verif"; http: number; motivo: string } | null = null;
  if (dataCheck.status === "nao_e_amanha") {
    bloqueio = {
      st: "bloqueado",
      http: 409,
      motivo: `a data recebida (${JSON.stringify(dataInstalacao)} = ${dataCheck.data}) nao e amanha na Florida (${dataCheck.amanha}) — "starts tomorrow" nao pode sair`,
    };
  } else if (verif && !verif.ok) {
    bloqueio = { st: "verif", http: 503, motivo: `a plataforma nao respondeu a verificacao de obra (${verif.erro})` };
  } else if (verif && verif.ok && verif.bloquear) {
    bloqueio = { st: "bloqueado", http: 409, motivo: verif.motivo ?? "a plataforma mandou bloquear" };
  }
  const verificacao = verif
    ? verif.ok
      ? { ok: true, bloquear: verif.bloquear, motivo: verif.motivo, obra_concluida: verif.obra_concluida, contrato_depois: verif.contrato_depois, quotes: verif.quotes, jobs: verif.jobs }
      : { ok: false, erro: verif.erro }
    : null;
  const notaData = dataCheck.status === "nao_interpretada" ? `data nao interpretada (${JSON.stringify(dataInstalacao)}); valeu so a plataforma` : null;

  // ── Duplicidade: mesmo telefone avisado há <20h → não reenvia ──────────────
  const avisoAnteriorEm = await findDuplicateNotice(telefoneCliente!, agora);

  if (body.dry === true) {
    const nota = bloqueio ? `${bloqueio.st}: ${bloqueio.motivo}` : avisoAnteriorEm ? `duplicado de ${avisoAnteriorEm}` : notaData;
    await registrarChamadaInstalacao({ ...base, st: "dry", err: nota });
    return NextResponse.json({
      ok: true,
      dry: true,
      enviado: false,
      mensagem,
      data_usada: dataFinal,
      horario_suspeito: guarda.horarioSuspeito,
      via_iso: !!viaIso,
      duplicado: !!avisoAnteriorEm,
      aviso_anterior_em: avisoAnteriorEm,
      bloqueado: !!bloqueio,
      motivo: bloqueio?.motivo ?? null,
      data_check: dataCheck,
      verificacao,
    });
  }

  if (bloqueio) {
    console.warn(`[INSTALACAO] ${bloqueio.st.toUpperCase()} phone=${telefoneCliente} data=${JSON.stringify(dataInstalacao)} — nada enviado: ${bloqueio.motivo}`);
    await registrarChamadaInstalacao({ ...base, st: bloqueio.st, err: bloqueio.motivo });
    // O dono decide: se a instalação for real, manda na mão. Best effort.
    try {
      await notifyOwners({
        platform: "WhatsApp",
        clientName: nomeCliente,
        clientId: telefoneCliente!,
        recentMessages: [{ role: "assistant", content: `(NAO ENVIADO) ${mensagem}` }],
        alert:
          bloqueio.st === "verif"
            ? installUnverifiedAlert({ nome: nomeCliente, telefone: telefoneCliente!, dataRecebida: dataInstalacao!, erro: verif && !verif.ok ? verif.erro : "sem resposta" })
            : installBlockedAlert({ nome: nomeCliente, telefone: telefoneCliente!, dataRecebida: dataInstalacao!, motivo: bloqueio.motivo }),
      });
    } catch (err) {
      console.error("[INSTALACAO] alerta de bloqueio falhou:", err);
    }
    return erro(bloqueio.http, `aviso NAO enviado: ${bloqueio.motivo}`, {
      bloqueado: true,
      enviado: false,
      motivo: bloqueio.motivo,
      data_check: dataCheck,
      verificacao,
    });
  }

  if (avisoAnteriorEm) {
    console.warn(`[INSTALACAO] DUPLICADO phone=${telefoneCliente} aviso anterior em ${avisoAnteriorEm} — nada enviado`);
    await registrarChamadaInstalacao({ ...base, st: "duplicado", err: `aviso anterior em ${avisoAnteriorEm}` });
    return NextResponse.json({
      ok: true,
      enviado: false,
      duplicado: true,
      aviso_anterior_em: avisoAnteriorEm,
      mensagem,
      data_usada: dataFinal,
      horario_suspeito: guarda.horarioSuspeito,
      via_iso: !!viaIso,
      data_check: dataCheck,
      verificacao,
    });
  }

  // ── Envio ──────────────────────────────────────────────────────────────────
  const result = await sendWhatsAppMessage(telefoneCliente!, mensagem);
  if (!result.ok) {
    console.error(`[INSTALACAO] Z-API send failed phone=${telefoneCliente} status=${result.status} erro=${result.error}`);
    await registrarChamadaInstalacao({ ...base, st: "zapi", err: `Z-API ${result.status}: ${result.error ?? "erro desconhecido"}` });
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
  await registrarChamadaInstalacao({ ...base, st: "ok", err: [notaData, registrado ? null : "historico nao gravado"].filter(Boolean).join("; ") || null });

  // Horário removido → o dono precisa confirmar a hora com o cliente. Best
  // effort: o WhatsApp do cliente já saiu, um alerta que falha não vira erro.
  if (guarda.horarioSuspeito) {
    try {
      await notifyOwners({
        platform: "WhatsApp",
        clientName: nomeCliente,
        clientId: telefoneCliente!,
        recentMessages: [{ role: "assistant", content: mensagem }],
        alert: installTimeAlert({ nome: nomeCliente, horarioSuspeito: guarda.horarioSuspeito, dataEnviada: dataFinal }),
      });
    } catch (err) {
      console.error("[INSTALACAO] alerta de horario suspeito falhou:", err);
    }
  }

  console.log(
    `[INSTALACAO] ok phone=${telefoneCliente} data=${JSON.stringify(dataFinal)} recebido=${JSON.stringify(dataInstalacao)} ` +
      `via_iso=${!!viaIso} horario_suspeito=${guarda.horarioSuspeito ?? "-"} vendedor=${nomeVendedor ?? "-"} registrado=${registrado}`
  );
  return NextResponse.json({
    ok: true,
    enviado: true,
    mensagem,
    registrado,
    data_usada: dataFinal,
    horario_suspeito: guarda.horarioSuspeito,
    via_iso: !!viaIso,
    data_check: dataCheck,
    verificacao,
  });
}

// Um GET é quase sempre um humano cutucando a URL no navegador. Responde com o
// uso em vez do 405 padrão, sem revelar nada secreto.
export async function GET() {
  return NextResponse.json({
    ok: true,
    rota: "POST /api/confirmar-instalacao",
    auth: "header Authorization: Bearer <token>",
    obrigatorios: ["telefone_cliente", "data_instalacao"],
    opcionais: ["data_instalacao_iso", "nome_cliente", "nome_vendedor", "telefone_vendedor", "dry"],
    nota: "sem nome_vendedor/telefone_vendedor o contato na mensagem e o Ozzi (561) 674-8334 (chame mesmo sem vendedor; nunca invente um); data_instalacao_iso (ISO 8601 com fuso) e formatada por nos em horario da Florida e tem prioridade; o HORARIO do job nunca vai ao cliente (a mensagem diz que a instalacao comeca amanha e a equipe chega entre 10am e 11am); horario fora de 7h-19h ainda gera alerta ao dono; mesmo telefone avisado ha menos de 20h responde 200 com enviado:false e duplicado:true (nada e reenviado); desde 22/10/2026 a data recebida tem que ser AMANHA na Florida e a plataforma tem que confirmar que o cliente nao tem obra ja concluida sem contrato novo — senao 409 {bloqueado:true, motivo} (ou 503 se a plataforma nao responder): nada e enviado e o dono e avisado",
  });
}
