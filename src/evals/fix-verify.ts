import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getAIResponse, isPureClosing, type ChatMessage } from "../lib/ai";
import {
  detectLang,
  bookingSuccessMessage,
  bookingFailureHandoffMessage,
  getRealAvailabilityContext,
} from "../lib/scheduler";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  ${detail}`); }
}

// Helper: append a [SYSTEM:...] note to the last user message like the webhook does
function withSystem(msgs: ChatMessage[], note: string): ChatMessage[] {
  const copy = msgs.map((m) => ({ ...m }));
  copy[copy.length - 1].content += `\n\n[SYSTEM: ${note}]`;
  return copy;
}

const FRI_AVAIL = [
  "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
  "• Thursday, June 4, 2026 [2026-06-04]: 5pm",
  "• Friday, June 5, 2026 [2026-06-05]: 9am, 11am, 1pm, 3pm, 5pm, 7pm",
  "• Saturday, June 6, 2026 [2026-06-06]: 9am",
  "",
  "IMPORTANT: When you name a weekday, use the exact [YYYY-MM-DD] on that same line and only times listed there. If 'Friday' is [2026-06-05], book 2026-06-05, never 2026-06-06.",
].join("\n");
const DATECTX = "TODAY: Thursday, June 4, 2026. TOMORROW: Friday 2026-06-05. Current time: 22:14 Eastern.";
const WA_NOTE = `[WHATSAPP CHANNEL: You already have the client's phone number (13053359498). Ask ONLY for the property address. NEVER ask for the phone number. Once you have a confirmed day/time and the address, generate [BOOK:...] using "13053359498" as the phone.]`;

async function main() {
  // ════ ISSUE 1: false "slot taken" — wrong date (Ignacio, WhatsApp, Spanish) ════
  console.log("\n[ISSUE 1] Date integrity — book correct Friday 2026-06-05 @ 13:00");
  const ignacio: ChatMessage[] = [
    { role: "user", content: "Hola buenas noche, me gustaría que me hicieras un estimado" },
    { role: "assistant", content: "El paquete promocional incluye el piso, la mano de obra y el quarter round, y el estimado es gratis. Va a hacer solo un área o toda la casa?" },
    { role: "user", content: "Cocina, comedor, sala y un pasillo, tengo 3 cuartos" },
    { role: "assistant", content: "Eso suena completo, para el mejor precio necesito medir en persona. Te queda bien este viernes o el sábado?" },
    { role: "user", content: "Si, dígame cuándo puede venir" },
    { role: "assistant", content: "Perfecto, tengo este viernes a las 9am o a la 1pm, cuál prefieres?" },
    { role: "user", content: "Viernes a la 1:00 pm" },
    { role: "assistant", content: "Perfecto, me das tu dirección para confirmarte la cita?" },
    { role: "user", content: "Ignacio, 355 East 20 St Hialeah FL 33010" },
  ];
  const r1 = await getAIResponse(withSystem(ignacio, `${DATECTX}\n\n${FRI_AVAIL}\n\n${WA_NOTE}`), null, null, undefined, false);
  console.log("    AI:", r1.text.replace(/\s+/g, " ").slice(0, 180));
  const book1 = r1.text.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  check("generates [BOOK]", !!book1, r1.text.slice(0, 120));
  if (book1) {
    check("date = 2026-06-05 (Friday), NOT 06-06", /2026-06-05/.test(book1[1]) && !/2026-06-06/.test(book1[1]), book1[1]);
    check("time = 13:00", /"time"\s*:\s*"13:00"/.test(book1[1]), book1[1]);
  }

  // ════ ISSUE 2: language — Spanish convo must reply in Spanish, no English leak ════
  console.log("\n[ISSUE 2] Language consistency (Spanish in, Spanish out)");
  check("detectLang(Ignacio convo) = es", detectLang(ignacio.map((m) => m.content).join(" ")) === "es");
  check("ES success message in Spanish", bookingSuccessMessage("es").includes("Cita confirmada"));
  check("EN success message in English", bookingSuccessMessage("en").includes("Appointment confirmed"));

  // ════ ISSUE 3: honest failure — never say "slot taken", hand off to Ozzi ════
  console.log("\n[ISSUE 3] Booking failure message is honest + localized");
  check("ES failure mentions Ozzi, no 'taken'/'ocupado'", /Ozzi/.test(bookingFailureHandoffMessage("es")) && !/taken|ocupad/i.test(bookingFailureHandoffMessage("es")));
  check("EN failure mentions Ozzi, no 'taken'", /Ozzi/.test(bookingFailureHandoffMessage("en")) && !/taken/i.test(bookingFailureHandoffMessage("en")));

  // ════ ISSUE 4: WhatsApp asks ONLY for address, never the phone ════
  console.log("\n[ISSUE 4] WhatsApp — ask only for address, not phone");
  const waSlot: ChatMessage[] = [
    { role: "user", content: "Toda la casa, son como 1200 sqft" },
    { role: "assistant", content: "Para ese tamaño hago una visita gratis para medir y traer las muestras. Tengo este viernes a las 9am o a la 1pm, cuál prefieres?" },
    { role: "user", content: "Viernes a la 1pm está bien" },
  ];
  const r4 = await getAIResponse(withSystem(waSlot, `${DATECTX}\n\n${FRI_AVAIL}\n\n${WA_NOTE}`), null, null, undefined, false);
  console.log("    AI:", r4.text.replace(/\s+/g, " ").slice(0, 180));
  const asksAddress = /direcci[oó]n|address/i.test(r4.text);
  const asksPhone = /tel[eé]fono|n[uú]mero de tel|phone number|tu n[uú]mero/i.test(r4.text);
  check("asks for the address", asksAddress, r4.text.slice(0, 120));
  check("does NOT ask for the phone number", !asksPhone, r4.text.slice(0, 120));

  // ════ ISSUE 5: post-booking → total silence ════
  console.log("\n[ISSUE 5] Post-booking silence (bookingConfirmed=true → empty)");
  const postBook: ChatMessage[] = [
    { role: "assistant", content: "Cita confirmada. Te aviso 40 minutos antes de llegar." },
    { role: "user", content: "Muchas gracias, nos vemos" },
  ];
  const r5 = await getAIResponse(postBook, null, null, undefined, true);
  check("returns empty (nothing sent to client)", r5.text.trim() === "", JSON.stringify(r5.text));

  // ════ ISSUE 6: react-only on pure closings (Erika) ════
  console.log("\n[ISSUE 6] React-only on closings, answer real questions");
  check("isPureClosing('I will definitely call u tomorrow')", isPureClosing("I will definitely call u tomorrow"));
  check("isPureClosing('Thank you so much!')", isPureClosing("Thank you so much!"));
  check("NOT closing: '...appreciate it do u do screens'", !isPureClosing("Definitely ty so much I really appreciate it do u do screens"));
  check("NOT closing: 'yes friday at 1pm works'", !isPureClosing("yes friday at 1pm works"));
  const erika: ChatMessage[] = [
    { role: "assistant", content: "Of course, you can reach Ozzi directly at (561) 674-8334, or we can schedule right here. I have Friday at 9am or 11am open!" },
    { role: "user", content: "I will definitely call u tomorrow" },
  ];
  const r6 = await getAIResponse(erika, null, null, undefined, false);
  console.log("    AI(closing):", JSON.stringify(r6.text.slice(0, 120)));
  check("pure closing → [REACT_ONLY]", /\[REACT_ONLY\]/i.test(r6.text), r6.text.slice(0, 120));
  const erika2: ChatMessage[] = [
    { role: "assistant", content: "For the whole house I bring samples and measure free, would Friday work?" },
    { role: "user", content: "Definitely ty so much I really appreciate it do u do screens" },
  ];
  const r6b = await getAIResponse(erika2, null, null, undefined, false);
  console.log("    AI(question):", r6b.text.replace(/\s+/g, " ").slice(0, 150));
  check("thanks + question → answers (no [REACT_ONLY])", !/\[REACT_ONLY\]/i.test(r6b.text), r6b.text.slice(0, 120));

  // ════ ISSUE 7: live availability function + date-integrity warning ════
  console.log("\n[ISSUE 7] Live scheduler availability");
  const avail = await getRealAvailabilityContext();
  check("returns schedule block", /AVAILABILITY/.test(avail));
  check("each day pairs weekday + [YYYY-MM-DD]", /\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,.*\[\d{4}-\d{2}-\d{2}\]/.test(avail));
  check("has date-integrity warning", /same line|copy the date|exact \[YYYY-MM-DD\]/i.test(avail));

  // ════ ISSUE 8: auto-learning store is fresh and readable ════
  console.log("\n[ISSUE 8] Auto-learning (system store fresh + readable)");
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const storeId = process.env.ANTHROPIC_SYSTEM_STORE_ID!;
    const page = await anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
    const file = page.data.find((m) => (m as { type: string }).type === "memory" && (m as { path?: string }).path === "/learnings.md");
    check("learnings.md exists", !!file);
    if (file) {
      const mem = await anthropic.beta.memoryStores.memories.retrieve((file as { id: string }).id, { memory_store_id: storeId });
      const content = (mem as { content?: string }).content ?? "";
      check("learnings updated June 2026 (not stale May)", /June.*2026|2026-06|Updated:.*2026/.test(content), content.split("\n")[1] ?? "");
      check("learnings reference conversions/corrections", /converted|conversion|booking|CONVERTED|owner correction/i.test(content));
    }
  } catch (e) {
    check("auto-learning store reachable", false, String(e));
  }

  console.log(`\n════════════ RESULT: ${pass} passed, ${fail} failed ════════════`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
