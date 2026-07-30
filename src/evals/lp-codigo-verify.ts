// ─── LP-CODIGO-VERIFY (30/07/2026) ──────────────────────────────────────────
// O botão de WhatsApp da landing page do Google (go.ozzifloors.com) abre a
// conversa com "...free flooring estimate [G-7K2M4P]". Esse código é a ÚNICA
// prova de que a pessoa veio do anúncio pago do Google quando ela escolhe
// falar por WhatsApp (a Z-API não traz gclid). Se ele não subir no
// lead_criado, o lead vira "whatsapp" sem atribuição nenhuma — foi o furo
// achado em 30/07 (1 clique real de 24/07 perdido).
// Run: npx tsx src/evals/lp-codigo-verify.ts
import { readFileSync } from "fs";
import { join } from "path";

let pass = 0;
let fail = 0;
const ck = (nome: string, ok: boolean, detalhe = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${nome}${ok || !detalhe ? "" : ` — ${detalhe}`}`);
  ok ? pass++ : fail++;
};

async function main() {
const { codigoLpDaMensagem } = await import("@/lib/funil");

console.log("\n[extração do código]");
ck(
  "mensagem real da LP",
  codigoLpDaMensagem("Hi! I'd like a free flooring estimate [G-YGYWYC]") === "G-YGYWYC"
);
ck("minúsculas viram maiúsculas", codigoLpDaMensagem("estimate [g-ab12cd]") === "G-AB12CD");
ck("com espaços dentro dos colchetes", codigoLpDaMensagem("estimate [ G-AB12CD ]") === "G-AB12CD");
ck("mensagem sem código", codigoLpDaMensagem("Hi, I need new floors") === undefined);
ck("texto vazio", codigoLpDaMensagem("") === undefined);
ck(
  "não confunde com outro colchete",
  codigoLpDaMensagem("[SYSTEM: QUOTE_FOLLOWUP {}] hello") === undefined
);
ck(
  "pega o código mesmo no meio da frase",
  codigoLpDaMensagem("hello [G-123ABC] please call me") === "G-123ABC"
);

console.log("\n[o código chega ao lead_criado]");
const funil = readFileSync(join(process.cwd(), "src/lib/funil.ts"), "utf-8");
ck(
  "lead_criado da 1ª mensagem manda lp_codigo",
  /lp_codigo:\s*codigoLpDaMensagem\(rawText\)/.test(funil),
  "payload do lead_criado sem lp_codigo"
);
ck(
  "código tardio re-envia lead_criado",
  /const codigoTardio = codigoLpDaMensagem\(rawText\)[\s\S]{0,320}enviarEventoFunil\("lead_criado",\s*\{\s*\.\.\.base,\s*lp_codigo: codigoTardio/.test(
    funil
  ),
  "sem o caminho do código que chega depois da 1ª mensagem"
);

console.log(`\n===== LP-CODIGO: ${pass} passed, ${fail} failed =====`);
if (fail > 0) process.exit(1);
}

main();
