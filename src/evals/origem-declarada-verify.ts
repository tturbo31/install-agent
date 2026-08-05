// ORIGEM DECLARADA (05/08/2026) — verificação de regressão.
// A Meta não entrega o referral em ~40% das conversas de IG; quando a visita é
// marcada sem contrato de anúncio, o agente pergunta 1x "como nos encontrou?"
// e a resposta segue à plataforma como origem_declarada (pista, nunca
// atribuição). Este eval trava: (1) o classificador puro; (2) a pergunta
// anexada à confirmação nos 3 webhooks; (3) a captura da resposta rodando em
// TODA mensagem recebida, antes do early-return de conversa pré-funil.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classificarOrigemDeclarada } from "@/lib/funil";

let passed = 0;
let failed = 0;
function ck(nome: string, ok: boolean, motivo?: string) {
  if (ok) { passed++; console.log(`  ✅ ${nome}`); }
  else { failed++; console.log(`  ❌ ${nome}${motivo ? ` — ${motivo}` : ""}`); }
}

console.log("\n[1] CLASSIFICADOR (puro, sem palpite)");
ck("instagram", classificarOrigemDeclarada("I found you on Instagram!") === "Instagram");
ck("insta abreviado", classificarOrigemDeclarada("insta") === "Instagram");
ck("facebook", classificarOrigemDeclarada("It was a Facebook ad") === "Facebook");
ck("fb", classificarOrigemDeclarada("fb") === "Facebook");
ck("google", classificarOrigemDeclarada("I googled flooring near me") === "Google");
ck("amigo (es)", classificarOrigemDeclarada("una amiga me recomendó") === "Indicação");
ck("friend", classificarOrigemDeclarada("A friend told me about you") === "Indicação");
ck("tiktok", classificarOrigemDeclarada("tik tok") === "TikTok");
ck("anúncio genérico", classificarOrigemDeclarada("saw an ad") === "Anúncio");
ck("agradecimento NÃO vira origem", classificarOrigemDeclarada("Thank you, see you Monday!") === null);
ck("resposta longa NÃO vira origem", classificarOrigemDeclarada("x".repeat(301)) === null);
ck("endereço com 'search' não engana… (google só com palavra explícita)", classificarOrigemDeclarada("3269 Dunning Dr") === null);

console.log("\n[2] PERGUNTA ANEXADA À CONFIRMAÇÃO (3 webhooks)");
const raiz = join(__dirname, "..");
const ig = readFileSync(join(raiz, "app/api/webhook/route.ts"), "utf8");
const fb = readFileSync(join(raiz, "app/api/fb-webhook/route.ts"), "utf8");
const wa = readFileSync(join(raiz, "app/api/wa-webhook/route.ts"), "utf8");
for (const [nome, src] of [["IG", ig], ["FB", fb], ["WA", wa]] as const) {
  ck(`${nome}: chama perguntaOrigemPosAgendamento no sucesso do booking`, /perguntaOrigemPosAgendamento\(conversationId, lang\)/.test(src));
  ck(`${nome}: a frase canônica da confirmação continua na frente`, /bookingSuccessMessage\(lang\)}\\n\\n\$\{perguntaOrigem/.test(src));
  ck(`${nome}: falha da pergunta nunca derruba a confirmação (.catch)`, /perguntaOrigemPosAgendamento\(conversationId, lang\)\.catch\(\(\) => ""\)/.test(src));
}

console.log("\n[3] FUNIL (pergunta 1x, captura antes do early-return)");
const funil = readFileSync(join(raiz, "lib/funil.ts"), "utf8");
ck("pergunta só sem contrato (contratoTemDados → \"\")", /if \(contratoTemDados\(ad\.contrato\)\) return ""/.test(funil));
ck("nunca pergunta a quem veio da LP do Google", /codigoLpDaMensagem\(primeira\.content\)/.test(funil));
ck("flag existente = nunca re-pergunta", /like\("platform", `\$\{origemQPrefix\(convId\)\}%`\)/.test(funil));
ck("captura roda ANTES do early-return pré-funil", funil.indexOf("capturarRespostaOrigem(conv, rawText)") < funil.indexOf("if (!convNoFunil(conv)) {"));
ck("resposta clara → lead_criado com origem_declarada", /origem_declarada: origem,/.test(funil));
ck("resposta já usada nunca reprocessa (::ok)", /usoStr === "ok"/.test(funil));
ck("desistência silenciosa com teto de mensagens", /ORIGEM_Q_MAX_MSGS/.test(funil));

console.log(`\n===== ORIGEM-DECLARADA: ${passed} passed, ${failed} failed =====`);
process.exit(failed > 0 ? 1 : 0);
