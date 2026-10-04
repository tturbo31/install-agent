// "What floor is that?" (owner rule 2026-10-03): never guess a floor we cannot
// see. The answer is the website (that floor is there with all the details of
// the job), the samples at the free visit, and the zip code to move toward the
// visit: "Check out our floors at https://ozzifloors.company, I bring samples to
// the free visit too. What's the zip code there?" (Sasha, IG 03/10, booked).
// History: Yamit (IG 02/10) asked "What floor is that?" about a post (the
// herringbone luxury vinyl Tuscany Oak, our best seller) and got "That's our
// luxury vinyl with a stone finish", copied from the "cement ad" rule.
// [1] static. [2] deterministic. [3] live (getAIResponse).
// Run: npx tsx src/evals/which-floor-verify.ts   (LIVE=0 skips [3])
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isWhichFloorQuestion, isPureWhichFloorBurst, fixWhichFloorReply, type ChatMessage } from "../lib/ai";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split(/\r?\n/)) {
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
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (content: string): ChatMessage => ({ role: "user", content });
const A = (content: string): ChatMessage => ({ role: "assistant", content });
const SITE = /https:\/\/ozzifloors\.company/;
const GUESS = /stone finish|marble finish|stone look|marble look|that'?s our (?:luxury )?vinyl|wood finish/i;
const ZIP_ASK = /zip code|c[oó]digo postal/i;

// Yamit, IG, verbatim (owner [Treino] lines left out).
// Real timestamps (the webhooks pass created_at as `at`): without them the
// model cannot know the 09/09 visit already happened.
const D = (iso: string) => new Date(iso + ":00-04:00").toISOString();
const Ud = (content: string, at: string): ChatMessage => ({ role: "user", content, at: D(at) });
const Ad = (content: string, at: string): ChatMessage => ({ role: "assistant", content, at: D(at) });
const YAMIT: ChatMessage[] = [
  Ud("And for tile floor?", "2026-06-26T07:22"),
  Ad("Tile installation is $4.50 per sqft for the labor, and you supply the tile material. What size are you working with?", "2026-06-26T07:22"),
  Ud("Was tinking of 48 by 48 or 24. How long it takes to onstall for 1600sqft house?", "2026-06-26T07:28"),
  Ud("Becuse i am living on it and need to know", "2026-06-26T07:28"),
  Ad("For a 1,600 sqft house with large format tile, the installation typically takes about 5 to 7 days, and I completely understand the concern since you're living there. The best thing is a free in-person visit where I can see the layout, plan the work in sections so you always have part of the house usable, and give you the exact price. I have today at 3pm or 5pm, or Sunday works great too. What day is better for you?", "2026-06-26T07:28"),
  Ud("Do you offer any discounts for larger spaces?", "2026-09-06T11:02"),
  Ad("Yes, we do offer discounts for larger projects. I can come measure the space, bring the tile samples, and lock in your best price right there on the spot, all free.", "2026-09-06T11:02"),
  Ud("Hey", "2026-09-08T13:19"),
  Ad("Still thinking about that tile project for your 1,600 sqft home?", "2026-09-08T13:20"),
  Ud("Yes. How about coming in tomorrow to see the work and give me estimate?", "2026-09-08T13:20"),
  Ad("Tomorrow works great! I have Wednesday at 9am or 3pm, which one is better for you?", "2026-09-08T13:21"),
  Ud("9:10am will be good", "2026-09-08T13:22"),
  Ad("We only have 9am on the schedule, so 9:10 isn't a listed slot, but 9am works perfectly for Wednesday. Can I get your name, the full property address with the zip code, and the best phone number for the visit?", "2026-09-08T13:23"),
  Ud("655 ne 178th st , 33162 , miami florida", "2026-09-08T13:24"), Ud("Yamit", "2026-09-08T13:24"), Ud("9044530934", "2026-09-08T13:24"), Ud("[Client replied to our ad]", "2026-09-08T13:24"), Ud("With who am i speaking?", "2026-09-08T13:24"),
  Ad("You're talking with the OzziFloors team, Yamit. Appointment confirmed for Wednesday, September 9 at 9am. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.", "2026-09-08T13:25"),
  Ud("Thanks , see you tomorrow", "2026-09-08T13:54"),
  Ud("You install here the tile under kitcehn cabinets or not?", "2026-09-16T12:07"),
  Ad("Thank you! To double check your visit details, please reach Ozzi directly at (561) 674-8334 and he'll confirm everything with you.", "2026-09-16T12:08"),
  Ud("What floor is that?", "2026-10-02T19:48"),
];
const YAMIT_BAD = "That's our luxury vinyl with a stone finish, it goes right over your existing tile with no demo needed. Want to set up your free visit so you can see the samples in person?";

async function main() {
  console.log("\n[1] Prompt");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("AD FLOOR QUESTIONS rewritten (website + samples + zip)", /AD FLOOR QUESTIONS, "WHAT FLOOR IS THAT\?"/.test(sp) && /that floor is there so you can see all the details of the job/.test(sp));
  ck("the 'stone finish' answer is fenced to cement talk", /ONLY for a client who calls the floor cement/.test(sp));

  console.log("\n[2] Detection");
  const yes = ["What floor is that?", "what is this floor?", "What's that floor called?", "Is that vinyl?", "Is the one I sent from your page vinyl?", "what's the floor in the video?", "which one is that?", "What flooring did you use there?", "qué piso es ese?", "Cómo se llama ese piso?", "que piso é esse?", "como chama esse piso?", "What kind of floor is that?"];
  for (const t of yes) ck(`which-floor: "${t}"`, isWhichFloorQuestion(t));
  const no = ["what flooring do you offer?", "what material do you use?", "what kind of floor is it?", "is that floor epoxy?", "Is that the cement one?", "Is it waterproof?", "What floor is the apartment on?", "How much for 1200 sqft?"];
  for (const t of no) ck(`NOT which-floor: "${t}"`, !isWhichFloorQuestion(t));
  ck("pure: 'What floor is that?'", isPureWhichFloorBurst("What floor is that?"));
  ck("pure: 'Hi\\nWow what floor is that?' ", isPureWhichFloorBurst("Hi\nWow\nWhat floor is that?"));
  ck("pure with ad bracket: '[Client replied to our ad]\\nWhat floor is that?'", isPureWhichFloorBurst("[Client replied to our ad]\nWhat floor is that?"));
  ck("NOT pure: + price question", !isPureWhichFloorBurst("What floor is that? how much per sqft?"));

  console.log("\n[2b] Fix");
  const full = fixWhichFloorReply(YAMIT_BAD, "en", true);
  ck("full: exact owner shape (site + samples + zip), no guess", full === "Check out our floors at https://ozzifloors.company, that floor is there so you can see all the details of the job, and I bring samples to the free visit too. What's the zip code there?", full);
  const ins = fixWhichFloorReply(YAMIT_BAD, "en", false);
  ck("zip known: guess dropped, site in, visit question kept", SITE.test(ins) && !GUESS.test(ins) && /free visit so you can see the samples in person\?$/.test(ins), ins);
  console.log("     → " + ins);
  const dodge = fixWhichFloorReply("I can't see which ad you came from on my side, but the floors we sell are luxury vinyl. Which one are you interested in?", "en", true);
  ck("dodge reply → full shape", SITE.test(dodge) && ZIP_ASK.test(dodge) && !/can'?t see/i.test(dodge), dodge);
  const es = fixWhichFloorReply("Ese es nuestro vinyl de lujo con acabado de piedra. Quieres agendar la visita?", "es", true);
  ck("ES full", /Mira nuestros pisos en https:\/\/ozzifloors\.company/.test(es) && /código postal/.test(es) && !/piedra/.test(es), es);
  const good = "Check out our floors at https://ozzifloors.company, I bring samples to the free visit too. What's the zip code there?";
  ck("already right → untouched", fixWhichFloorReply(good, "en", true) === good);
  const tag = fixWhichFloorReply("That's our luxury vinyl with a stone finish. [NOTIFY_OWNER]", "en", true);
  ck("tag survives at the end", /zip code there\? \[NOTIFY_OWNER\]$/.test(tag), tag);
  const stray = fixWhichFloorReply("Check out our floors at https://ozzifloors.company, that floor is there so you can see all the details, and I bring the physical samples to the visit too. See you tomorrow at 9am!", "en", false);
  ck("stray \"See you tomorrow at 9am!\" dropped (past visit)", SITE.test(stray) && !/see you/i.test(stray), stray);
  const booked = fixWhichFloorReply("Check out our floors at https://ozzifloors.company. See you tomorrow at 9am! [BOOK:{\"date\":\"2026-10-04\"}]", "en", false);
  ck("with a [BOOK] the confirmation stays", /See you tomorrow/.test(booked), booked);
  ck("[REACT_ONLY] untouched", fixWhichFloorReply("[REACT_ONLY]", "en", true) === "[REACT_ONLY]");

  if (process.env.LIVE === "0") return;

  console.log("\n[3] Live");
  const runs = Number(process.env.RUNS || 3);
  const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
  const live = async (name: string, msgs: ChatMessage[], ok: (r: string) => boolean) => {
    for (let i = 0; i < runs; i++) {
      const r = await ai(msgs);
      ck(`${name} #${i + 1}`, ok(r), r);
      console.log("     → " + r.replace(/\s+/g, " "));
    }
  };
  await live("Yamit replay → website, no guess, never \"see you tomorrow\" for the past visit", YAMIT, (r) => SITE.test(r) && !GUESS.test(r) && !/see you (?:tomorrow|wednesday|then)/i.test(r));
  await live("fresh ad lead 'What floor is that?' → website + samples + zip", [U("[Client replied to our ad]"), U("What floor is that?")], (r) => SITE.test(r) && ZIP_ASK.test(r) && /sample/i.test(r) && !GUESS.test(r));
  await live("fresh 'Love it! What's that floor called?'", [U("Love it!"), U("What's that floor called?")], (r) => SITE.test(r) && ZIP_ASK.test(r) && !GUESS.test(r));
  await live("ES 'qué piso es ese?'", [U("[Client replied to our ad]"), U("Hola, qué piso es ese?")], (r) => SITE.test(r) && /código postal/i.test(r) && !/piedra|m[aá]rmol/i.test(r) && !/[¿¡]/.test(r));
  await live("REGRESSION cement talk → still the vinyl correction", [U("[Client replied to our ad]"), U("Is that floor epoxy? the cement you pour over the tile?")], (r) => /vinyl/i.test(r) && !/we don'?t (?:do|install)|isn'?t something we/i.test(r));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
