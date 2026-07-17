/**
 * GUARDA do endpoint POST /api/enviar (integração Ozzi Plataforma → agente) e da
 * introdução do ADMIN_SECRET forte.
 *
 * O PERIGO desta mudança: ADMIN_SECRET nunca existiu. Toda rota admin lia
 * `process.env.ADMIN_SECRET ?? "Pepeka"`, então passar a DEFINIR ADMIN_SECRET
 * troca o segredo de 7 rotas de uma vez e poderia trancar o dono fora do painel
 * (Reativar todas, treino, correções, upload de fotos) e derrubar as URLs dos
 * crons em vercel.json (?secret=Pepeka). Estes testes provam que não trancou.
 *
 * ZERO chamadas de API e ZERO envios: só helpers puros + inspeção de fonte.
 * Rodar: npx tsx src/evals/enviar-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isDashboardAuthorized, isStrongAdminSecret, LEGACY_ADMIN_SECRET, MIN_STRONG_SECRET_LENGTH } from "../lib/admin-auth";
import { buildFollowupContext, sanitizeOutbound, FOLLOWUP_STAGES, safeFollowupTemplate, tripsSchedulingDetector, promisesDiscount, followupPolicyViolation, financiamentoDe, financingApprovalNote, safeFinancingTemplate, HEARTH_URL_PADRAO } from "../lib/quote-followup";
import { buildQuoteCtxMarker, parseQuoteCtxMarker, QUOTE_CTX_PREFIX } from "../lib/quote-reply";
import { containsSchedulingOffer } from "../lib/ai";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 160)}»`); }
}

const STRONG = "a".repeat(64); // stand-in for a real 32-byte hex secret

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { ADMIN_SECRET: process.env.ADMIN_SECRET, INSTAGRAM_VERIFY_TOKEN: process.env.INSTAGRAM_VERIFY_TOKEN };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function main() {
  console.log("\n============== ENVIAR-VERIFY (integração plataforma → agente) ==============");

  // ── 1. NÃO-REGRESSÃO: o painel e os crons continuam abrindo com "Pepeka" ────
  console.log("\n[1] Definir um ADMIN_SECRET forte NÃO tranca o que já funcionava");
  withEnv({ ADMIN_SECRET: STRONG, INSTAGRAM_VERIFY_TOKEN: "Pepeka" }, () => {
    ck("painel/cron: 'Pepeka' continua autorizado (era o segredo de facto)", isDashboardAuthorized("Pepeka"));
    ck("painel: o novo ADMIN_SECRET forte também autoriza", isDashboardAuthorized(STRONG));
    ck("painel: INSTAGRAM_VERIFY_TOKEN continua autorizando", isDashboardAuthorized("Pepeka"));
    ck("painel: segredo errado segue barrado", !isDashboardAuthorized("errado"));
    ck("painel: vazio/null segue barrado", !isDashboardAuthorized("") && !isDashboardAuthorized(null) && !isDashboardAuthorized(undefined));
  });
  // O caso mais perigoso: verify token de produção NÃO ser "Pepeka". As rotas
  // dependiam do fallback `?? "Pepeka"`, que some quando ADMIN_SECRET é definido.
  withEnv({ ADMIN_SECRET: STRONG, INSTAGRAM_VERIFY_TOKEN: "algum-outro-valor" }, () => {
    ck("painel: 'Pepeka' AINDA autoriza mesmo se o verify token for outro (o fallback sumiu)", isDashboardAuthorized("Pepeka"));
  });
  // Estado de hoje (antes de cadastrar o segredo) tem de seguir idêntico.
  withEnv({ ADMIN_SECRET: undefined, INSTAGRAM_VERIFY_TOKEN: "Pepeka" }, () => {
    ck("sem ADMIN_SECRET (estado de hoje): 'Pepeka' autoriza igual a antes", isDashboardAuthorized("Pepeka"));
    ck("sem ADMIN_SECRET: segredo errado barrado", !isDashboardAuthorized("errado"));
  });

  // ── 2. O portão FORTE do /api/enviar ───────────────────────────────────────
  console.log("\n[2] /api/enviar exige segredo forte e falha fechado");
  withEnv({ ADMIN_SECRET: STRONG, INSTAGRAM_VERIFY_TOKEN: "Pepeka" }, () => {
    ck("envio: aceita o ADMIN_SECRET forte", isStrongAdminSecret(STRONG));
    ck("envio: RECUSA 'Pepeka' (é público no bundle do painel)", !isStrongAdminSecret(LEGACY_ADMIN_SECRET));
    ck("envio: RECUSA o verify token", !isStrongAdminSecret("Pepeka"));
    ck("envio: RECUSA vazio/null/undefined", !isStrongAdminSecret("") && !isStrongAdminSecret(null) && !isStrongAdminSecret(undefined));
    ck("envio: RECUSA segredo errado do mesmo tamanho", !isStrongAdminSecret("b".repeat(64)));
  });
  withEnv({ ADMIN_SECRET: undefined }, () => {
    ck("envio: SEM ADMIN_SECRET → falha fechado para qualquer entrada", !isStrongAdminSecret(STRONG) && !isStrongAdminSecret("Pepeka") && !isStrongAdminSecret(""));
  });
  withEnv({ ADMIN_SECRET: LEGACY_ADMIN_SECRET }, () => {
    ck("envio: ADMIN_SECRET='Pepeka' → falha fechado (nunca abre com o valor público)", !isStrongAdminSecret("Pepeka"));
  });
  withEnv({ ADMIN_SECRET: "curto123" }, () => {
    ck(`envio: ADMIN_SECRET curto (<${MIN_STRONG_SECRET_LENGTH}) → falha fechado`, !isStrongAdminSecret("curto123"));
  });

  // ── 3. Contexto do follow-up: nunca inventa o que a plataforma não mandou ───
  console.log("\n[3] Contexto do follow-up só cita o que a plataforma enviou");
  const cheio = buildFollowupContext({
    idioma: "en", etapa: "D7",
    cliente: { primeiro_nome: "Maria", nome: "Maria Silva" },
    quote: { valor: 4500, parcela_36x: 125, dias_desde_orcamento: 7 },
    sugestao_texto: "Hi Maria, following up on your quote!",
  });
  ck("contexto: usa o primeiro nome", /Maria/.test(cheio));
  ck("contexto: formata o valor como $4,500", /\$4,500/.test(cheio));
  ck("contexto: formata a parcela como $125", /\$125/.test(cheio));
  ck("contexto: inclui a etapa D7", /Touch: D7/.test(cheio));
  ck("contexto: passa a sugestão como ponto de partida", /STARTING POINT/.test(cheio) && /following up on your quote/.test(cheio));

  const vazio = buildFollowupContext({ idioma: "es", etapa: "D30", cliente: null, quote: null, sugestao_texto: null });
  ck("contexto SEM valor: proíbe citar preço", /NEVER mention any price/.test(vazio));
  ck("contexto SEM parcela: proíbe citar financiamento", /NEVER mention financing/.test(vazio));
  ck("contexto SEM nome: proíbe inventar nome", /do NOT invent one/.test(vazio));
  ck("contexto: idioma espanhol declarado", /Language to write in: Spanish/.test(vazio));

  // valor=0 / lixo não podem virar "$0" numa mensagem para cliente real
  const zero = buildFollowupContext({ idioma: "en", etapa: "D1", quote: { valor: 0, parcela_36x: "abc" } });
  ck("contexto: valor 0 é tratado como ausente (nunca '$0')", /NEVER mention any price/.test(zero) && !/\$0\b/.test(zero));
  ck("contexto: parcela não numérica é tratada como ausente", /NEVER mention financing/.test(zero));
  // string com máscara ("$4.500,00" / "4500") ainda tem de virar número
  const str = buildFollowupContext({ idioma: "en", etapa: "D3", quote: { valor: "4500" } });
  ck("contexto: valor em string vira $4,500", /\$4,500/.test(str));

  ck("etapas expostas exatamente como o contrato pede", FOLLOWUP_STAGES.join(",") === "D1,D3,D7,D14,D30");

  // ── 4. Sanitização da saída ────────────────────────────────────────────────
  console.log("\n[4] sanitizeOutbound aplica as regras do dono");
  ck("tira travessão", !/[—–]/.test(sanitizeOutbound("Hi Maria — just checking on the quote.")));
  ck("tira emoji", !/😀|👍/.test(sanitizeOutbound("Hi Maria 👍 the quote is ready 😀")));
  ck("tira aspas que embrulham a mensagem", sanitizeOutbound('"Hi Maria, the quote is ready."') === "Hi Maria, the quote is ready.");
  ck("tira tag interna [NOTIFY_OWNER]", sanitizeOutbound("Hi Maria, all good.[NOTIFY_OWNER]") === "Hi Maria, all good.");
  ck("tira tag [BOOK:{...}] com payload", sanitizeOutbound('All set![BOOK:{"name":"x","time":"13:00"}]') === "All set!");
  ck("tira [REACT_ONLY] e [SEND_IMAGES]", sanitizeOutbound("Hi Maria, here you go.[REACT_ONLY][SEND_IMAGES: a.jpg]") === "Hi Maria, here you go.");
  // stripForbiddenTags do ai.ts ANEXA "browse at ozzifloors.com" ao remover
  // [SEND_IMAGES] — um plug do site colado num follow-up de orçamento. Provar que
  // sanitizeOutbound NÃO tem esse efeito colateral.
  ck("não anexa link do site ao limpar [SEND_IMAGES]", !/ozzifloors\.com/i.test(sanitizeOutbound("Hi Maria, all good.[SEND_IMAGES: a.jpg]")));
  ck("tira monólogo interno vazado", !/let me redo/i.test(sanitizeOutbound("Hi Maria, your quote is $4,500. Let me redo this: it is $4,500.")));
  ck("preserva uma mensagem legítima", sanitizeOutbound("Hi Maria, just making sure the quote reached you, any questions?") === "Hi Maria, just making sure the quote reached you, any questions?");

  // ── 5. As regras de geração fecham os buracos conhecidos ───────────────────
  console.log("\n[5] Regras de geração (fonte) fecham desconto / slot / invenção");
  const lib = readFileSync(join(process.cwd(), "src/lib/quote-followup.ts"), "utf-8");
  ck("regra: proíbe desconto/negociação (regra 31 do dono)", /NEVER negotiate, offer, hint at, or promise a discount/.test(lib));
  ck("regra: proíbe oferecer horário/slot (senão o webhook lê a resposta como remarcação)", /NEVER offer, propose, or ask about appointment times/.test(lib));
  ck("regra: proíbe inventar fatos", /NEVER invent facts/.test(lib));
  ck("regra: só cita preço se a plataforma mandou", /Only mention the price if a quote total is supplied/.test(lib));
  ck("regra: sem travessão e sem emoji", /Zero dashes/.test(lib) && /Zero emojis/.test(lib));
  ck("regra: no máximo 2 frases", /One or two sentences/.test(lib));
  // A frase da nudge interna é marcador de dedup do followup.ts — nunca repetir.
  ck("regra: não repete a abertura da nudge interna (marcador de dedup)", /just checking in, want me to get your free estimate/.test(lib));
  ck("gerador tem fallback para a sugestão da plataforma", /source: "sugestao"/.test(lib));

  // Uma mensagem de follow-up correta NÃO pode parecer oferta de horário, senão o
  // wa-webhook trata a resposta do cliente como pedido de remarcação.
  for (const exemplo of [
    "Hi Maria, just making sure the quote for $4,500 reached you, any questions?",
    "Hola Maria, solo quería confirmar que recibiste tu presupuesto, cualquier duda me avisas.",
    "Hi Maria, your quote still stands and financing can bring it to about $125 a month, want to move forward?",
  ]) ck(`exemplo válido não parece oferta de horário: "${exemplo.slice(0, 42)}…"`, !containsSchedulingOffer(exemplo), exemplo);

  // ── 5b. A ARMADILHA "works for you" (achada na revisão adversarial) ────────
  // Para um cliente JÁ AGENDADO, os 3 webhooks fazem:
  //   if (containsSchedulingOffer(ultimaMensagemNossa)) engageReschedule = true
  // Então um follow-up terminando em "let me know if that works for you" joga a
  // resposta do cliente no RESCHEDULE MODE e o bot tenta MOVER uma visita que já
  // aconteceu. A frase é naturalíssima num follow-up: o prompt sozinho não basta.
  console.log("\n[5b] Armadilha da frase de agendamento (bug real pego na revisão)");
  const armadilhas = [
    "Hi Maria, your quote for $4,500 still stands, just let me know if that works for you.",
    "Hi Maria, we can get started right away once you give the word.",
    "Hi Maria, what day would be best to go over the quote?",
    "Hola Maria, tu cotización sigue en pie, avísame a las 3pm.",
  ];
  for (const t of armadilhas) {
    ck(`detector PEGA a armadilha: "${t.slice(0, 46)}…"`, tripsSchedulingDetector(t), t);
  }
  ck("tripsSchedulingDetector é exatamente o detector do webhook", tripsSchedulingDetector("does that work for you?") === containsSchedulingOffer("does that work for you?"));

  // Todo template de segurança TEM de passar — é o último recurso do gerador.
  const langs = ["en", "es"] as const;
  for (const l of langs) {
    for (const e of FOLLOWUP_STAGES) {
      const t = safeFollowupTemplate(l, e);
      ck(`template seguro ${l}/${e} não dispara o detector`, !tripsSchedulingDetector(t), t);
      ck(`template seguro ${l}/${e} sobrevive à sanitização intacto`, sanitizeOutbound(t) === t, t);
      ck(`template seguro ${l}/${e} não cita preço nem horário`, !/\$\s?\d/.test(t) && !/\b\d{1,2}\s*(am|pm)\b/i.test(t), t);
    }
  }

  // ── 5c. RASCUNHO DA PLATAFORMA é copy NÃO CONFIÁVEL (achado 3/3 do painel) ─
  // Se a Anthropic cair (créditos zerados / 529 — falha recorrente documentada),
  // TODO follow-up da janela vira o rascunho cru da plataforma. Ele nunca passou
  // pelas nossas regras, então tem de passar pelo MESMO portão do texto da IA.
  console.log("\n[5c] Rascunho da plataforma passa pelo mesmo portão (fallback de outage)");
  const rascunhosProibidos: Array<[string, string]> = [
    ["Hi Maria, I can do Tuesday at 10am, and I could take a bit off the price", "horario+desconto"],
    ["Hi Maria, just following up on your quote, let me know if that works for you.", "horario"],
    ["Hi Maria, we can offer you a discount if you decide this week.", "desconto"],
    ["Hi Maria, we could give you a better price if you move forward now.", "desconto"],
    ["Hola Maria, podemos bajar el precio si decides esta semana.", "desconto ES"],
    ["Hola Maria, te hacemos un descuento especial.", "desconto ES"],
  ];
  for (const [t, tipo] of rascunhosProibidos) {
    ck(`portão REJEITA rascunho (${tipo}): "${t.slice(0, 40)}…"`, followupPolicyViolation(t) !== null, `violacao=${followupPolicyViolation(t)}`);
  }
  ck("detector de desconto pega 'take a bit off the price'", promisesDiscount("I could take a bit off the price"));
  ck("detector de desconto pega 'better price'", promisesDiscount("we could give you a better price"));
  // FALSOS POSITIVOS: financiamento é PERMITIDO quando a plataforma manda a parcela.
  const permitidos = [
    "Hi Maria, your quote for $4,500 still stands, financing can bring it to about $125 a month, want to move forward?",
    "Hola Carlos, tu cotización de $8,200 sigue en pie y el financiamiento puede dividirlo en pagos de $228 al mes.",
    "Hi Maria, just making sure the quote reached you, any questions at all?",
  ];
  for (const t of permitidos) {
    ck(`portão ACEITA mensagem legítima: "${t.slice(0, 40)}…"`, followupPolicyViolation(t) === null, `violacao=${followupPolicyViolation(t)}`);
  }
  ck("financiamento NÃO é confundido com desconto", !promisesDiscount("financing can bring it to about $125 a month"));
  for (const l of ["en", "es"] as const)
    for (const e of FOLLOWUP_STAGES)
      ck(`template seguro ${l}/${e} passa no portão completo`, followupPolicyViolation(safeFollowupTemplate(l, e)) === null);

  const gen = readFileSync(join(process.cwd(), "src/lib/quote-followup.ts"), "utf-8");
  ck("gerador REJEITA texto do modelo que viola o portão", /const violation = followupPolicyViolation\(r\.text\)/.test(gen));
  ck("gerador REJEITA rascunho da plataforma que viola o portão", /const draftViolation = followupPolicyViolation\(draft\)/.test(gen));
  ck("gerador tenta 1 retry corretivo antes de desistir", /CORRECTIVE/.test(gen) && /for \(const attempt of \[1, 2\]/.test(gen));
  ck("gerador cai em template seguro como último recurso", /safeFollowupTemplate\(input\.idioma, input\.etapa\)/.test(gen));
  ck("prompt proíbe explicitamente as frases-armadilha", /works for you/.test(gen) && /get started right away/.test(gen));
  // Custo: no PIOR caso são 2 chamadas (~1000 tokens de input), nunca um loop.
  ck("no máximo 2 chamadas ao modelo, nunca loop infinito", /\[1, 2\] as const/.test(gen));

  // ── 5d. FINANCIAMENTO (Hearth) — oferta com link + 2ª mensagem fixa ────────
  console.log("\n[5d] Financiamento: link intacto, 2ª mensagem segura, marcador de contexto");
  const URL_FIN = "https://app.gethearth.com/partners/ozzifloors";
  // normalização do payload da plataforma
  ck("financiamentoDe: null sem payload", financiamentoDe({ idioma: "en", etapa: "D1" }) === null);
  ck("financiamentoDe: usa a URL da plataforma", financiamentoDe({ idioma: "en", etapa: "D1", financiamento: { url: URL_FIN, oferecer: true } })?.url === URL_FIN);
  ck("financiamentoDe: URL inválida cai no padrão Hearth", financiamentoDe({ idioma: "en", etapa: "D1", financiamento: { url: "javascript:alert(1)", oferecer: true } })?.url === HEARTH_URL_PADRAO);
  ck("financiamentoDe: oferecer só quando explicitamente true", financiamentoDe({ idioma: "en", etapa: "D1", financiamento: { url: URL_FIN } })?.oferecer === false);
  // contexto da oferta
  const ctxFin = buildFollowupContext({ idioma: "en", etapa: "D1", quote: { valor: 4500, parcela_36x: 125 }, financiamento: { url: URL_FIN, oferecer: true } });
  ck("contexto da oferta inclui o link exato", ctxFin.includes(URL_FIN));
  ck("contexto da oferta manda liderar com o financiamento", /FINANCING OFFER/.test(ctxFin));
  const ctxJaOferecido = buildFollowupContext({ idioma: "en", etapa: "D7", financiamento: { url: URL_FIN, oferecer: false } });
  ck("já ofereceu: proíbe repetir o link", /do NOT paste any link again/.test(ctxJaOferecido) && !ctxJaOferecido.includes(URL_FIN));
  // templates e nota de aprovação passam em TODOS os portões
  for (const l of ["en", "es"] as const) {
    const t = safeFinancingTemplate(l, URL_FIN);
    ck(`template de financiamento ${l} contém o link`, t.includes(URL_FIN), t);
    ck(`template de financiamento ${l} sobrevive à sanitização com o link intacto`, sanitizeOutbound(t).includes(URL_FIN), sanitizeOutbound(t));
    ck(`template de financiamento ${l} passa no portão`, followupPolicyViolation(t) === null, `violacao=${followupPolicyViolation(t)}`);
    const nota = financingApprovalNote(l);
    ck(`nota de aprovação ${l} não dispara o detector de agendamento`, !tripsSchedulingDetector(nota), nota);
    ck(`nota de aprovação ${l} sobrevive à sanitização intacta`, sanitizeOutbound(nota) === nota, nota);
    ck(`nota de aprovação ${l} passa no portão`, followupPolicyViolation(nota) === null);
  }
  // marcador de contexto no histórico (liga o modo quote-reply do wa-webhook)
  const marcador = buildQuoteCtxMarker({ valor: 4500, parcela: 125, idioma: "es", url: URL_FIN });
  ck("marcador usa o prefixo estável", marcador.includes(QUOTE_CTX_PREFIX));
  const parsed = parseQuoteCtxMarker(`Hola, tu cotización...${marcador}`, "2026-07-17T12:00:00Z");
  ck("marcador faz round-trip (valor/parcela/idioma/url)", parsed?.valor === 4500 && parsed?.parcela === 125 && parsed?.idioma === "es" && parsed?.url === URL_FIN);
  ck("marcador ilegível vira null (nunca quebra o webhook)", parseQuoteCtxMarker(`${QUOTE_CTX_PREFIX}{lixo]`, "2026-07-17T12:00:00Z") === null);
  // fiação: gerador exige o link intacto na oferta; rota manda a 2ª mensagem
  const qfSrc = readFileSync(join(process.cwd(), "src/lib/quote-followup.ts"), "utf-8");
  ck("gerador REJEITA oferta sem o link intacto", /!r\.text\.includes\(fin\.url\)/.test(qfSrc));
  ck("fallback da oferta é o template de financiamento (não o rascunho sem link)", /safeFinancingTemplate\(input\.idioma, fin\.url\)/.test(qfSrc));
  const routeFin = readFileSync(join(process.cwd(), "src/app/api/enviar/route.ts"), "utf-8");
  ck("rota envia a 2ª mensagem (nota de aprovação) após a oferta", /financingApprovalNote\(/.test(routeFin) && /notaAprovacao/.test(routeFin));
  ck("2ª mensagem é best-effort (falha não vira erro p/ plataforma reenviar)", /nota de aprovação exception/.test(routeFin));
  ck("rota grava o marcador de contexto no histórico", /buildQuoteCtxMarker/.test(routeFin));
  // wa-webhook: cliente de follow-up não fica mais no silêncio
  const waSrc = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8");
  ck("wa-webhook roteia resposta de cliente de orçamento pro quote-reply", /findQuoteFollowupContext/.test(waSrc) && /composeQuoteReply/.test(waSrc));
  ck("wa-webhook mantém o aviso ao dono como fallback", /WA post-booking notify error/.test(waSrc));

  // ── 6. Fiação da rota ──────────────────────────────────────────────────────
  console.log("\n[6] Fiação de /api/enviar");
  const route = readFileSync(join(process.cwd(), "src/app/api/enviar/route.ts"), "utf-8");
  ck("usa o portão FORTE (nunca o do painel)", /isStrongAdminSecret\(req\.headers\.get\("x-admin-secret"\)\)/.test(route) && !/isDashboardAuthorized/.test(route));
  ck("responde 401 sem segredo válido", /erro\(401, "Unauthorized"\)/.test(route));
  ck("mensagem_direta é enviada EXATAMENTE como veio (sem sanitizar)", /tipo === "mensagem_direta" \? texto : sanitizeOutbound\(texto\)/.test(route));
  ck("followup é escrito pelo agente", /composeQuoteFollowup/.test(route));
  ck("falha do WhatsApp devolve status >= 400 com {ok:false,erro}", /ok: false, erro: `falha ao enviar pelo WhatsApp/.test(route));
  ck("sucesso devolve {ok:true}", /ok: true,\s*enviado: true/.test(route));
  // Um 401/403 do Z-API nao pode se disfarcar do NOSSO 401 (segredo errado).
  ck("falha de auth do Z-API não vira 401/403 nosso (vira 502)", /raw !== 401 && raw !== 403 \? raw : 502/.test(route));
  ck("registra o followup no histórico", /if \(tipo === "followup" && followupInput\)/.test(route) && /recordInHistory\(telefone, textoFinal \+ marcador\)/.test(route));
  ck("NÃO registra mensagem_direta (relatório do dono não vira thread de cliente)", /Record ONLY the AI-written follow-ups/.test(route));
  ck("valida telefone (só dígitos, 8 a 15)", /digits\.length < 8 \|\| digits\.length > 15/.test(route));
  ck("valida etapa contra a lista", /FOLLOWUP_STAGES\.includes\(etapa\)/.test(route));
  ck("valida idioma en/es", /idioma !== "en" && idioma !== "es"/.test(route));
  ck("histórico é best-effort (nunca derruba um envio já entregue)", /NEVER throws/.test(route));

  // ── 7. Nenhuma rota ficou com o fallback antigo ────────────────────────────
  console.log("\n[7] Nenhuma rota lê mais `ADMIN_SECRET ?? \"Pepeka\"` por conta própria");
  const rotas = [
    "src/app/api/dream/route.ts",
    "src/app/api/resume/route.ts",
    "src/app/api/train/route.ts",
    "src/app/api/wa-diag/route.ts",
    "src/app/api/training/chat/route.ts",
    "src/app/api/conversations/[id]/correct/route.ts",
    "src/app/api/admin/upload-product-image/route.ts",
  ];
  for (const rel of rotas) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    const nome = rel.replace("src/app/api/", "").replace("/route.ts", "");
    ck(`${nome}: sem fallback literal solto`, !/ADMIN_SECRET\s*\?\?\s*"Pepeka"/.test(src), rel);
    ck(`${nome}: usa o helper central`, /isDashboardAuthorized/.test(src), rel);
  }
  // funil-check e followup nunca tiveram fallback: definir ADMIN_SECRET só ADICIONA
  // um valor aceito neles, então continuam intocados de propósito.
  for (const rel of ["src/app/api/funil-check/route.ts", "src/app/api/followup/route.ts"]) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${rel.replace("src/app/api/", "").replace("/route.ts", "")}: segue aceitando o verify token (mudança só aditiva)`, /INSTAGRAM_VERIFY_TOKEN/.test(src), rel);
  }

  // ── 8. ECONOMIA DE TOKENS: a integração não pode tocar o cache do cérebro ──
  console.log("\n[8] Economia de tokens (prompt caching) intacta");
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  const breakpoints = (aiSrc.match(/cache_control: \{ type: "ephemeral" as const, ttl: "1h" as const \}/g) ?? []).length;
  ck("ai.ts mantém os 3 breakpoints de cache com TTL 1h", breakpoints === 3, `encontrados: ${breakpoints}`);
  ck("ai.ts ainda separa stableSystem (bloco compartilhado por todas as conversas)", /let stableSystem = SYSTEM_PROMPT;/.test(aiSrc));
  ck("stableSystem NÃO recebe timestamp/data (mataria o cache compartilhado)", !/stableSystem\s*\+=[^;]*(?:new Date|Date\.now|toISOString|getEasternDateContext)/.test(aiSrc));
  const qf = readFileSync(join(process.cwd(), "src/lib/quote-followup.ts"), "utf-8");
  ck("quote-followup usa system prefix próprio (não contamina o cache do cérebro)", /system: SYSTEM,/.test(qf));
  ck("quote-followup NÃO injeta timestamp no prompt", !/new Date\(\)|Date\.now\(\)|toISOString/.test(qf));
  ck("quote-followup é barato: max_tokens <= 300", /max_tokens: 300/.test(qf));
  // Um unico ponto de chamada ao modelo (o retry reusa askModel), limitado a 2
  // tentativas: um loop aqui viraria custo silencioso.
  ck("quote-followup: 1 único ponto de chamada ao modelo", (qf.match(/messages\.create\(/g) ?? []).length === 1);
  ck("quote-followup: no pior caso 2 chamadas (~1k tokens), nunca loop", /\[1, 2\] as const/.test(qf));

  console.log(`\n============== ENVIAR-VERIFY: ${pass} passed, ${fail} failed ==============`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
