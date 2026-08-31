/**
 * REVISÃO 4 DIAS 27–31/08/2026 (737 conversas, 3 canais) — guardas dos fixes.
 * 100% determinístico: sem modelo, sem banco.
 *
 *  1. stripReasoningLeak pega os monólogos que furaram em 29/08 (Keky WA, Natasha IG)
 *     e poupa frases de cliente ("today, Monday, I have 6pm open").
 *  2. Rejeição no 1º contato: "No Txs", "I dont need floor thanks", "scroll past your
 *     add", "services i don't want nor need", "Not now", "sin mi autoriso" → silêncio.
 *  3. 1ª mensagem que precisa de leitura: "Telefono", "Su telefono", e-mail, "talk with
 *     someone", "I've been a flooring installer" → modelo, nunca o opener enlatado.
 *  4. openerLang: "Información general y costos", "En saber precios" → espanhol.
 *  5. Reparo: "I will look into the foundation crack repair" NÃO é pedido de reparo.
 *  6. Botão de FAQ + texto digitado na mesma rajada → modelo (faqButtonPlusTypedText).
 *  7. composeAdFaqOpener sem "Great questions!"/"Buenas preguntas!".
 *  8. parseStreetAddress aceita palavras antes do número ("It's 13155 ixora ct.") e a
 *     correção de casa na mesma rua vira "moved" (alerta ao dono) — caso Aron Mannis.
 *  9. pickLang do followup reconhece espanhol do bot SEM ¿¡ (caso fb 4125ccfb).
 * 10. Fonte: branch already_booked dos 3 webhooks restata a visita REAL; prompt tem as
 *     regras DATA ON FILE e TIME OF DAY; followup tem a trava de idioma.
 * Run: npx tsx src/evals/review4d-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  stripReasoningLeak,
  isFirstContactRejection,
  mentionsRejection,
  firstMessageNeedsReading,
  openerLang,
  isRepairRequest,
  faqButtonPlusTypedText,
} from "../lib/ai";
import { composeAdFaqOpener } from "../lib/system-prompt";
import { parseStreetAddress, detectAddressCorrection, mayCarryAddressCorrection } from "../lib/scheduler";
import { pickLang } from "../lib/followup";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

console.log("\n━━ 1. vazamento de raciocínio (Keky WA 29/08, Natasha IG 29/08) ━━");
{
  const keky = "Which time works better, 11am or 2pm? Wait, I notice this is a vague reply and I already offered those two times before the system context loaded. Let me just ask for the booking info. Can I get your name and the property address?";
  const k = stripReasoningLeak(keky);
  ck("Keky: 'Wait, I notice…' removido", !/i notice/i.test(k), k);
  ck("Keky: 'system context' removido", !/system context/i.test(k), k);
  ck("Keky: 'Let me just ask' removido", !/let me just ask/i.test(k), k);
  ck("Keky: oferta 11am/2pm e pedido de dados sobrevivem", /11am or 2pm/.test(k) && /name/.test(k), k);

  const natasha = "They said next week, so the first available next-week day is Monday August 31. Today is Saturday August 29. I'll offer Monday August 31 first. Boca Raton is in our service area. Zip 33432 already given. I have Monday August 31 at 9am or 11am, which works better for you?";
  const n = stripReasoningLeak(natasha);
  ck("Natasha: 'They said next week' removido", !/they said/i.test(n), n);
  ck("Natasha: 'Today is Saturday' removido", !/today is saturday/i.test(n), n);
  ck("Natasha: 'I'll offer … first' removido", !/i'll offer/i.test(n), n);
  ck("Natasha: 'Zip 33432 already given' removido", !/already given/i.test(n), n);
  ck("Natasha: a oferta real (9am or 11am) sobrevive", /9am or 11am/.test(n), n);

  const ok1 = "Today, Monday, I have 6pm open, does that work for you?";
  ck("fala de cliente com 'today, Monday' intacta", stripReasoningLeak(ok1) === ok1, stripReasoningLeak(ok1));
  const ok2 = "Today is Monday and I still have 6pm open if you want it.";
  ck("'Today is Monday … have 6pm open' intacta (lookahead)", stripReasoningLeak(ok2) === ok2, stripReasoningLeak(ok2));
  const ok3 = "I have Tuesday at 3pm or 4pm, which works better for you?";
  ck("oferta normal intacta", stripReasoningLeak(ok3) === ok3, stripReasoningLeak(ok3));
}

console.log("\n━━ 2. rejeição no 1º contato → silêncio ━━");
{
  const rej = [
    "No Txs",
    "I dont need floor thanks",
    "I don't need flooring",
    "No. Was trying to scroll past your add",
    "services i don't want nor need",
    "Not now 😁",
    "No thank you.. not at this time",
    "Que es esto sin mi autoriso no me gusta esto por favor",
  ];
  for (const r of rej) ck(`rejeição: "${r}"`, isFirstContactRejection(r) && mentionsRejection(r));
  const keep = [
    "Not now, but how much is vinyl?",
    "I don't need flooring yet but what's the price per sqft?",
    "No thanks, I need hardwood",
    "I need new floors for 1200 sqft",
    "Nope, hopefully in the future",
  ];
  for (const k of keep) ck(`NÃO silencia: "${k}"`, !isFirstContactRejection(k));
}

console.log("\n━━ 3. 1ª mensagem que precisa de leitura (modelo, não opener) ━━");
{
  const read = [
    "Telefono",
    "Su telefono",
    "Nesecito su teléfono",
    "Send me info to artxsosa@gmail.com",
    "like to talk with someone on monday",
    "No I've been a flooring installer for 50 years",
  ];
  for (const r of read) ck(`precisa de leitura: "${r}"`, firstMessageNeedsReading(r));
  for (const k of ["Hi", "Tile", "What is the installation process?", "How much for vinyl"]) ck(`opener normal: "${k}"`, !firstMessageNeedsReading(k));
}

console.log("\n━━ 4. openerLang espanhol sem pergunta ━━");
{
  ck("'Información general y costos' → es", openerLang("Información general y costos") === "es");
  ck("'En saber precios' → es", openerLang("En saber precios") === "es");
  ck("'Nesecito su teléfono' → es", openerLang("Nesecito su teléfono") === "es");
  ck("'How much for vinyl' → en", openerLang("How much for vinyl") === "en");
  ck("'Hi there' → en", openerLang("Hi there") === "en");
}

console.log("\n━━ 5. reparo levado para outro contratante ≠ pedido de reparo ━━");
{
  const b36 = "Thank you for the quick response. I'm looking for complete baseboard replacement, no quarter round. I will look into the foundation crack repair.";
  ck("b36c7058: NÃO é reparo", !isRepairRequest(b36));
  ck("'Voy a ver lo de la reparación con otro' NÃO é reparo", !isRepairRequest("Voy a ver lo de la reparación con otro contratista, quiero piso nuevo en la sala"));
  ck("Priti: 'replace the damaged tiles' continua reparo", isRepairRequest("These tiles are damaged so we would like to replace them would you be able to give me a quote please"));
  ck("'Can you repair a few cracked tiles?' continua reparo", isRepairRequest("Can you repair a few cracked tiles?"));
  ck("'I need a repair on my floor' continua reparo", isRepairRequest("I need a repair on my floor"));
}

console.log("\n━━ 6. botão de FAQ + texto digitado na mesma rajada ━━");
{
  ck("processo + 'When can I get an estimate?' → modelo", faqButtonPlusTypedText("What is the installation process?\nWhen can I get an estimate?"));
  ck("desconto + 'Hola buenos días puedes dar más detalles' → modelo", faqButtonPlusTypedText("Do you offer any discounts for larger spaces?\nHola buenos días puedes dar más detalles"));
  ck("inclusões + 'Is this micro cement' → modelo", faqButtonPlusTypedText("[Client replied to our ad]\nWhat type of materials are included?\nIs this micro cement"));
  ck("desconto + 'Su telefono' → modelo", faqButtonPlusTypedText("Su telefono\n[Client replied to our ad]\nDo you offer any discounts for larger spaces?"));
  ck("2 botões puros → enlatado (false)", !faqButtonPlusTypedText("What is the installation process?\nWhat type of materials are included?"));
  ck("1 botão puro → enlatado (false)", !faqButtonPlusTypedText("What is the installation process?"));
  ck("botão + 'Hi' (saudação) → enlatado (false)", !faqButtonPlusTypedText("[Client replied to our ad]\nWhat is the installation process?\nHi"));
  ck("sem botão nenhum → false (fluxo normal decide)", !faqButtonPlusTypedText("Hello, how much per sqft?"));
}

console.log("\n━━ 7. composeAdFaqOpener sem abertura-carimbo ━━");
{
  const en = composeAdFaqOpener(["process", "inclusions"], "en") ?? "";
  const es = composeAdFaqOpener(["process", "discount"], "es") ?? "";
  ck("EN não abre com 'Great questions'", !!en && !/^great questions?/i.test(en), en);
  ck("ES não abre com 'Buenas preguntas'", !!es && !/^buenas preguntas?/i.test(es), es);
  ck("EN começa com maiúscula e termina pedindo o tipo", /^[A-Z]/.test(en) && /tile, vinyl, or hardwood\?$/.test(en), en);
  ck("ES sem ¿¡", !/[¿¡]/.test(es), es);
}

console.log("\n━━ 8. correção de endereço com palavras antes do número (Aron Mannis) ━━");
{
  const burst = "Typo\nIt's 13155 ixora ct.";
  const p = parseStreetAddress("It's 13155 ixora ct.");
  ck("parseStreetAddress pula 'It's'", !!p && p.house === "13155" && p.street === "ixora" && !!p.suffix, JSON.stringify(p));
  ck("mayCarryAddressCorrection aceita a rajada", mayCarryAddressCorrection(burst));
  const corr = detectAddressCorrection(burst, "13255 Ixora Ct, North Miami FL 33181");
  ck("casa diferente na mesma rua → 'moved' (alerta ao dono), com o número novo", !!corr && corr.kind === "moved" && /13155/.test(corr.address), JSON.stringify(corr));
  ck("mesmo endereço repetido → null", detectAddressCorrection("It's 13255 Ixora Ct", "13255 Ixora Ct, North Miami FL 33181") === null);
  const kristina = detectAddressCorrection("300 s Australian Av 916", "300 S Australian Ave, 1506, West Palm Beach FL 33401");
  ck("Kristina: troca de unidade continua 'unit' 916", !!kristina && kristina.kind === "unit" && kristina.unit === "916", JSON.stringify(kristina));
  ck("texto sem endereço → null", parseStreetAddress("Thanks, see you then") === null && parseStreetAddress("Apt 916") === null);
}

console.log("\n━━ 9. pickLang do followup sem depender de ¿¡ ━━");
{
  const botEs = "Parece que estás por tomar posesión de una propiedad, qué tipo de piso te interesa, tile, vinyl, o hardwood?";
  ck("fb 4125ccfb: cliente sem sinal + bot em ES (sem ¿) → es", pickLang(["amén", "tomobposecion"], botEs) === "es");
  const botEs2 = "Nosotros instalamos la nueva losa directamente sobre la existente, siempre y cuando la superficie esté en buenas condiciones, y eso lo confirmamos durante la visita gratuita. Estás pensando en hacer un área en específico o toda la casa?";
  ck("cliente 'Tile'/'33175' + bot em ES → es", pickLang(["Tile", "33175"], botEs2) === "es");
  ck("conversa em inglês → en", pickLang(["Hi", "Vinyl"], "Our vinyl promo is $5 per square foot and that already includes the flooring, the installation labor, and the quarter round. What's the zip code of the property?") === "en");
  ck("conversa em PT → pt", pickLang(["Bom dia, quero orçamento"], "Claro! Qual o tipo de piso?") === "pt");
}

console.log("\n━━ 10. fonte: webhooks, prompt e followup ━━");
{
  for (const f of ["src/app/api/wa-webhook/route.ts", "src/app/api/fb-webhook/route.ts", "src/app/api/webhook/route.ts"]) {
    const s = src(f);
    ck(`${f}: already_booked restata a visita REAL (getUpcomingBookingRecord + visitDetailsMessage)`, /already_booked[\s\S]{0,1200}getUpcomingBookingRecord[\s\S]{0,300}visitDetailsMessage/.test(s));
  }
  const ai = src("src/lib/ai.ts");
  ck("prompt: DATA ON FILE RULE nas FINAL REMINDERS", /DATA ON FILE RULE/.test(ai));
  ck("prompt: TIME OF DAY RULE nas FINAL REMINDERS", /TIME OF DAY RULE/.test(ai));
  const fu = src("src/lib/followup.ts");
  ck("followup: trava de idioma (nudge em PT para conversa ES/EN cai no template)", /PT_SIGNALS\.test\(text\)/.test(fu) && /followupTemplate\(decision\.lang\)/.test(fu));
}

console.log(`\n${pass} ✅  ${fail} ❌`);
if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
