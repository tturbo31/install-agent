// SÓ LEITURA (26/10/2026): reproduz o turno do Dragos (wa_17738995511) para ver quem comeu a oferta de horários.
import { antiPressureShouldFire, stripSchedulingPush, isLocationAnswer, isVisitProposalWithZipAsk, clientEngagedScheduling, adFlooringTypeNote, assessReasoningLeak } from "../src/lib/ai";
import { getRealAvailabilityContext, getEasternDateContext } from "../src/lib/scheduler";
import { offerLineDeviation } from "../src/lib/offer-line-guard";

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
const waNote = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "${phone}" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
const systemParts = [dateContext, availability, waNote, adFlooringTypeNote("vinyl")];
const messages = hist.map((m) => ({ ...m }));
messages[messages.length - 1] = { ...messages[messages.length - 1], content: `${messages[messages.length - 1].content}\n\n[SYSTEM: ${systemParts.join("\n\n")}]` };

const last = messages[messages.length - 1].content;
const lastA = hist[5].content;
console.log("isVisitProposalWithZipAsk(lastAssistant) =", isVisitProposalWithZipAsk(lastA));
console.log("isLocationAnswer(last) =", isLocationAnswer(last), "| words:", hist[6].content.split(/\s+/).length);
console.log("clientEngagedScheduling(last) =", clientEngagedScheduling(last));
console.log("antiPressureShouldFire =", antiPressureShouldFire(messages));

const drafts = [
  "33132 is covered, we're in that area all the time. Today is full, but I have tomorrow Tuesday at 4pm or Wednesday at 9am, which works better for you?",
  "33132 is covered, we're in that area all the time. I can come by tomorrow at 4pm or Wednesday at 9am, which works better?",
  "33132 is covered, we're in that area all the time. Let me offer you tomorrow at 4pm or Wednesday at 9am, which works?",
];
for (const d of drafts) {
  const leak = assessReasoningLeak(d, {});
  console.log("\nDRAFT:", d);
  console.log("  leak:", leak.mode, leak.signals.join("+"), "->", leak.text === d ? "(unchanged)" : JSON.stringify(leak.text));
  console.log("  offer-line:", offerLineDeviation(d, availability, hist)?.detail ?? "ok");
  console.log("  stripSchedulingPush ->", JSON.stringify(stripSchedulingPush(d)));
}

// Variantes de resposta de localização que a exceção deveria cobrir
for (const t of ["33132", "Miami 33132", "50 Biscayne blvd, Miami 33132", "50 Biscayne Blvd Miami FL 33132", "1234 NW 12th Ave Apt 5 Miami FL 33132", "it's in Coral Gables, 33134", "Is 33132 covered?"]) {
  console.log(`isLocationAnswer(${JSON.stringify(t)}) = ${isLocationAnswer(t)}`);
}
