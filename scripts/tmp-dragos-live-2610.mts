// SÓ LEITURA + chamadas ao modelo (26/10/2026): re-executa o cérebro no histórico do Dragos (wa_17738995511),
// com as MESMAS notas do webhook, para ver o rascunho real e qual guard corta a oferta. Não envia nada.
import { getAIResponse, adFlooringTypeNote } from "../src/lib/ai";
import { getRealAvailabilityContext, getEasternDateContext } from "../src/lib/scheduler";
import { getOrCreateSystemStore, readSystemMemory } from "../src/lib/dreaming";
import { loadGlobalCorrections } from "../src/lib/corrections";

const N = Number(process.env.N ?? 2);
const phone = "17738995511";
const hist = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?" },
  { role: "user", content: "Luxury vinyl" },
  { role: "assistant", content: "Our vinyl promo is $5 per sqft and that already includes the flooring, installation, and quarter round. I offer a free quote, is it just one area or the whole house?" },
  { role: "user", content: "Whole apartment" },
  { role: "assistant", content: "For a whole apartment I need to measure in person to give you the best price, it's free and I bring the samples. What's the zip code of the property?" },
  { role: "user", content: "50 Biscayne blvd, Miami 33132" },
] as Array<{ role: "user" | "assistant"; content: string }>;
const dateContext = getEasternDateContext();
const availability = await getRealAvailabilityContext({ history: hist });
console.log(availability.split("\n").slice(0, 4).join("\n"));
const waNote = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "${phone}" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
const systemParts = [dateContext, availability, waNote, adFlooringTypeNote("vinyl")];
const messages = hist.map((m) => ({ ...m }));
messages[messages.length - 1] = { ...messages[messages.length - 1], content: `${messages[messages.length - 1].content}\n\n[SYSTEM: ${systemParts.join("\n\n")}]` };
const systemMemory = await getOrCreateSystemStore().then((id) => readSystemMemory(id)).catch(() => null);
const corrections = await loadGlobalCorrections().catch(() => null);
for (let i = 0; i < N; i++) {
  const r = await getAIResponse(messages, null, systemMemory, corrections, false);
  console.log(`\n=== SAMPLE ${i + 1} ===\n${r.text}`);
}
