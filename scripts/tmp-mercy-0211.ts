// SÓ LEITURA/diagnóstico: o que o pipeline produz para a última bolha da Mercy (FB, "33143")
// e para o lead "Do you offer any discounts for larger spaces?" (FB, 1º contato).
import { readFileSync } from "fs";
for (const l of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
import { getAIResponse, isPureClosingBurst, isAckClosingBurst, isJobSeeker, isFirstContactRejection, isLocationAnswer, isBarePreBookingText, outOfAreaZipStanding, unansweredUserBurst, type ChatMessage } from "../src/lib/ai";
import { getRealAvailabilityContext, getEasternDateContext } from "../src/lib/scheduler";
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const mercy: ChatMessage[] = [
  A("Hi, we move the furniture, install the floor and leave everything clean, usually in 2 to 3 days. Are you thinking tile, vinyl, or hardwood?"),
  A("Hi, want me to check a time this week for your free estimate visit? I bring all the samples and you get the exact price on the spot."),
  U("What is the installation process?"),
  A("We move the furniture, install the floor and deliver everything clean, usually done in 2 to 3 days. Are you thinking tile, vinyl, or hardwood?"),
  U("800 pies cuadrados? How much wood?"),
  U("We have tile in a condo."),
  A("For 800 sqft I need to measure in person to give you the right number, the visit is free and I bring the samples. What's the zip code of the condo?"),
  U("33143"),
];
async function main() {
const burst = unansweredUserBurst(mercy);
console.log("burst:", JSON.stringify(burst));
console.log("gates:", JSON.stringify({ pureClosingBurst: isPureClosingBurst(mercy), ackClosingBurst: isAckClosingBurst(mercy), jobSeeker: isJobSeeker("33143"), firstContactRejection: isFirstContactRejection("33143"), locationAnswer: isLocationAnswer("33143"), barePreBooking: isBarePreBookingText("33143"), outOfArea: outOfAreaZipStanding(mercy) }));
const avail = await getRealAvailabilityContext({ history: mercy });
const withSys = mercy.slice(); withSys[withSys.length - 1] = U(`33143\n\n[SYSTEM: ${getEasternDateContext()}\n\n${avail}]`);
for (let i = 1; i <= 2; i++) { const r = await getAIResponse(withSys, null, null, null, false); console.log(`Mercy #${i}:`, JSON.stringify(r.text)); }
const disc: ChatMessage[] = [U("Do you offer any discounts for larger spaces?")];
for (let i = 1; i <= 2; i++) { const r = await getAIResponse(disc, null, null, null, false); console.log(`discounts #${i}:`, JSON.stringify(r.text), "tokens", r.inputTokens); }

}
main().catch((e)=>{console.error(e);process.exit(1);});
