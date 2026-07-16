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
import { buildFollowupContext, sanitizeOutbound, FOLLOWUP_STAGES } from "../lib/quote-followup";
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

  // ── 6. Fiação da rota ──────────────────────────────────────────────────────
  console.log("\n[6] Fiação de /api/enviar");
  const route = readFileSync(join(process.cwd(), "src/app/api/enviar/route.ts"), "utf-8");
  ck("usa o portão FORTE (nunca o do painel)", /isStrongAdminSecret\(req\.headers\.get\("x-admin-secret"\)\)/.test(route) && !/isDashboardAuthorized/.test(route));
  ck("responde 401 sem segredo válido", /erro\(401, "Unauthorized"\)/.test(route));
  ck("mensagem_direta é enviada EXATAMENTE como veio (sem sanitizar)", /tipo === "mensagem_direta" \? texto : sanitizeOutbound\(texto\)/.test(route));
  ck("followup é escrito pelo agente", /composeQuoteFollowup/.test(route));
  ck("falha do WhatsApp devolve status >= 400 com {ok:false,erro}", /ok: false, erro: `falha ao enviar pelo WhatsApp/.test(route));
  ck("sucesso devolve {ok:true}", /ok: true, enviado: true/.test(route));
  ck("registra o followup no histórico", /if \(tipo === "followup"\) registrado = await recordInHistory/.test(route));
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
  // O gerador roda 1 chamada por follow-up; um loop aqui viraria custo silencioso.
  ck("quote-followup faz no máximo 1 chamada ao modelo por follow-up", (qf.match(/messages\.create\(/g) ?? []).length === 1);

  console.log(`\n============== ENVIAR-VERIFY: ${pass} passed, ${fail} failed ==============`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
