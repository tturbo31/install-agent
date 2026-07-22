// Verifica a correção do vazamento de 2026-07-22: o resgate de respostas
// fantasmas (/api/ig-diag?rescue=) reenviou conteúdo cru do banco e um cliente
// recebeu "[SYSTEM: FOLLOWUP_NUDGE]" na DM do Instagram. Duas camadas:
//   1. stripInternalMarkers remove os marcadores internos de QUALQUER texto que
//      sai por IG/FB/WA (sem truncar — alertas ao dono citam transcrições)
//   2. o resgate limpa o conteúdo ANTES de enviar (e no preview do dry-run)
// Run: npx tsx src/evals/marker-leak-verify.ts
import { readFileSync } from "fs";
import { join } from "path";
import { stripInternalMarkers } from "../lib/outbound-text";
import { FOLLOWUP_DB_SUFFIX } from "../lib/followup";
import { buildQuoteCtxMarker } from "../lib/quote-reply";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 160)}»`); }
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

function main() {
  console.log("\n===================== MARKER LEAK VERIFICATION (no API) =====================");

  console.log("\n[1] stripInternalMarkers");
  const nudge = "Still thinking about the flooring for those 750 sqft? Whenever you are ready, we can set up the free visit.";
  ck("nudge do banco sai limpa (caso real do vazamento)",
    stripInternalMarkers(nudge + FOLLOWUP_DB_SUFFIX) === nudge,
    stripInternalMarkers(nudge + FOLLOWUP_DB_SUFFIX));

  const quoteMarker = buildQuoteCtxMarker({ valor: 8618, parcela: 240, idioma: "en", url: "https://app.gethearth.com/partners/ozzifloors" });
  const followupTxt = "Hi Maria, just following up on your $8,618 quote.";
  ck("marcador QUOTE_FOLLOWUP (com JSON) também é removido",
    stripInternalMarkers(followupTxt + quoteMarker) === followupTxt,
    stripInternalMarkers(followupTxt + quoteMarker));

  const alerta = `OzziFloors - Atencao!\n\nConversa recente:\nAgente: oi${FOLLOWUP_DB_SUFFIX}\nCliente: quero sim\n\nEntre em contato!`;
  const alertaLimpo = stripInternalMarkers(alerta);
  ck("marcador no MEIO de um alerta ao dono não trunca o resto",
    alertaLimpo.includes("Cliente: quero sim") && alertaLimpo.includes("Entre em contato!") && !alertaLimpo.includes("[SYSTEM:"),
    alertaLimpo);

  ck("texto limpo passa intacto", stripInternalMarkers(nudge) === nudge);
  ck("texto só-marcador vira vazio", stripInternalMarkers(FOLLOWUP_DB_SUFFIX) === "");
  ck("nunca sobra [SYSTEM: FOLLOWUP_NUDGE] em nenhuma combinação",
    !stripInternalMarkers(`a${FOLLOWUP_DB_SUFFIX}b${FOLLOWUP_DB_SUFFIX}`).includes("[SYSTEM:"));

  console.log("\n[2] os 3 canais de envio passam pela barreira");
  for (const [label, rel, fn] of [
    ["Instagram", "src/lib/instagram.ts", "sendInstagramMessage"],
    ["Facebook", "src/lib/facebook.ts", "sendFacebookMessage"],
    ["WhatsApp", "src/lib/whatsapp.ts", "sendWhatsAppMessage"],
  ] as const) {
    const src = read(rel);
    ck(`${label}: importa stripInternalMarkers`, /from "@\/lib\/outbound-text"/.test(src), rel);
    ck(`${label}: ${fn} limpa o texto antes de enviar`,
      new RegExp(`${fn}[\\s\\S]{0,200}?text = stripInternalMarkers\\(text\\)`).test(src), rel);
  }

  console.log("\n[3] o resgate limpa o conteúdo do banco na origem");
  const diag = read("src/app/api/ig-diag/route.ts");
  ck("rescue separa clientText do conteúdo cru", /clientText = String\(last\.content\)\.split\(\/\\n\\n\?\\\[SYSTEM:\/\)\[0\]/.test(diag));
  ck("rescue envia clientText, nunca last.content", /sendInstagramMessage\(c\.igsid, clientText\)/.test(diag) && !/sendInstagramMessage\(c\.igsid, String\(last\.content\)\)/.test(diag));
  ck("dry-run mostra o texto já limpo", /wouldResend: clientText\.slice/.test(diag));

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  if (fail) { console.log("FAILS:", fails.join(" | ")); process.exit(1); }
}

main();
