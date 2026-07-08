// Regression guard for the 2026-07-07 conversion review fixes. Pure-function
// tests only — deterministic, instant, zero API cost. Guards:
//  1. Large-lead price backstop: no $1,000+ total ships when the client
//     signaled 500+ sqft (the "price starts at $9,170" bug the contaminated
//     dreaming learning spread to every conversation).
//  2. Consecutive-duplicate guard: the same line never ships twice in a row
//     (the outage-handoff x12 loop and the FAQ-button identical re-answer).
//  3. Spanish opener: "Q piso es el de la promo?" gets the SPANISH opener.
//  4. Spanish job-seeker: installer credentials pitch gets silence, and real
//     customers do NOT trip the new patterns.
// Run: npx tsx src/evals/conversion-fixes-verify.ts
import {
  conversationHasLargeLead,
  stripLargeLeadPrices,
  isConsecutiveDuplicate,
  openerMessage,
  isJobSeeker,
  containsBookingInfo,
  clientEngagedScheduling,
  getAIResponse,
  type ChatMessage,
} from "@/lib/ai";
import { OPENER_ES, OPENER_EN } from "@/lib/system-prompt";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n── 1. Large-lead price backstop ──");
const largeConv: ChatMessage[] = [
  { role: "user", content: "I want vinyl for my whole house, about 2000 sqft" },
  { role: "assistant", content: "Which type are you interested in?" },
  { role: "user", content: "Vinyl please" },
];
check("2000 sqft conversation detected as large lead", conversationHasLargeLead(largeConv));
check(
  "300 sqft conversation NOT flagged as large",
  !conversationHasLargeLead([{ role: "user", content: "vinyl for 300 sqft please" }])
);
check(
  "Floor-plan LARGE PROJECT marker detected",
  conversationHasLargeLead([{ role: "user", content: "[Floor plan analysis: Total ~120m² (~1290sqft) LARGE PROJECT]" }])
);

const priced =
  "For 2,000 sqft, the price starts at $10,000 including the luxury vinyl flooring, materials, and installation. For a project that size I need to come measure in person to give you the best price. I have Sunday at 3pm or 5pm, what works better for you?";
const strippedReply = stripLargeLeadPrices(priced);
check("$10,000 total removed from the reply", !/\$\s?10,000/.test(strippedReply), strippedReply);
check("Visit pitch sentence survives the strip", /measure in person/i.test(strippedReply));
check("Slot offer survives the strip", /Sunday at 3pm/i.test(strippedReply));
check(
  "Reply that is ONLY a price gets the visit pivot",
  /free in-person visit/i.test(stripLargeLeadPrices("The total for your project is $9,170.")),
);
check(
  "Per-sqft rates are untouched (no big total present)",
  stripLargeLeadPrices("Tile is $4.50 per sqft for labor and removal is $1.50 per sqft.") ===
    "Tile is $4.50 per sqft for labor and removal is $1.50 per sqft.",
);
check(
  "Small-job totals under $1,000 are untouched",
  stripLargeLeadPrices("That comes out to about $950 total.") === "That comes out to about $950 total.",
);
check(
  "[BOOK:] tag sentence always survives",
  stripLargeLeadPrices('All set! [BOOK:{"date":"2026-07-09","time":"15:00"}] The total is $6,860.').includes("[BOOK:"),
);

console.log("\n── 2. Consecutive-duplicate send guard ──");
const OUTAGE = "Thanks for your message! Let me get our team to reach out, someone will get right back to you.";
const histAfterOutage: ChatMessage[] = [
  { role: "user", content: "No thanks" },
  { role: "assistant", content: OUTAGE },
  { role: "user", content: "NOOOOO" },
];
check("Outage handoff repeat suppressed", isConsecutiveDuplicate(histAfterOutage, OUTAGE));
check(
  "Whitespace/case variations still count as duplicates",
  isConsecutiveDuplicate(histAfterOutage, "  thanks for your message!  Let me get our team to reach out, someone will get right back to you. "),
);
check(
  "Different reply is NOT suppressed",
  !isConsecutiveDuplicate(histAfterOutage, "Our vinyl promo is $5 per sqft, want a free quote?"),
);
check("First-ever reply is never suppressed", !isConsecutiveDuplicate([{ role: "user", content: "hi" }], OUTAGE));
check(
  "Only the LAST assistant message counts (echo two turns back is fine)",
  !isConsecutiveDuplicate(
    [
      { role: "assistant", content: OUTAGE },
      { role: "user", content: "ok" },
      { role: "assistant", content: "Different reply here, moving on!" },
      { role: "user", content: "ok" },
    ],
    OUTAGE,
  ),
);
check("Tiny strings are exempt (length < 15)", !isConsecutiveDuplicate([{ role: "assistant", content: "All set!" }], "All set!"));

console.log("\n── 3. Spanish opener detection ──");
check("'Q piso es el de la promo ?' → Spanish opener", openerMessage("Q piso es el de la promo ?") === OPENER_ES);
check("'Cuánto cuesta?' → Spanish opener", openerMessage("Cuánto cuesta la instalación?") === OPENER_ES);
check("'necesito cotización para mi casa' → Spanish opener", openerMessage("necesito cotización para mi casa") === OPENER_ES);
check("English inquiry still gets English opener", openerMessage("How much does it cost?") === OPENER_EN);
check("'I need new floors' still English", openerMessage("I need new floors for my home") === OPENER_EN);

console.log("\n── 4. Spanish job-seeker detection ──");
check(
  "'Tengo experiencia en instalación de cerámica y tengo herramientas' → job seeker",
  isJobSeeker("Tengo experiencia en instalación de cerámica y tengo herramientas"),
);
check("'busco trabajo' → job seeker", isJobSeeker("Hola, busco trabajo de instalador"));
check(
  "Customer asking for installation is NOT a job seeker",
  !isJobSeeker("Necesito instalación de pisos en mi casa, cuánto cuesta?"),
);
check(
  "Customer with tools question is NOT a job seeker",
  !isJobSeeker("Do I need to buy the materials or do you bring everything?"),
);

console.log("\n── 6. Availability constraints count as scheduling engagement ──");
// "I cant during the week, i work" got its weekend-slot reply STRIPPED to a
// dead-end "No problem." by the anti-pressure guard (2026-07-08 review) —
// these phrases must all register as the client engaging scheduling.
check("'I cant during the week, i work' engages scheduling", clientEngagedScheduling("I cant during the week, i work"));
check("'only on weekends' engages scheduling", clientEngagedScheduling("only on weekends please"));
check("'I work all day' engages scheduling", clientEngagedScheduling("I work all day"));
check("'my day off is friday' engages scheduling", clientEngagedScheduling("my day off is friday"));
check("'solo fines de semana' engages scheduling", clientEngagedScheduling("solo fines de semana"));
check("'no puedo entre semana' engages scheduling", clientEngagedScheduling("no puedo entre semana"));
check(
  "Plain info question does NOT engage scheduling",
  !clientEngagedScheduling("What is the wear layer thickness?"),
);

console.log("\n── 7. Spanish contractor/installer pitches stay silent ──");
check(
  "'necesito trabajar yo sé entalar pisos y tengo una compañía de remodelación' → job seeker",
  isJobSeeker("Buenos días necesito trabajar yo sé entalar pisos y tengo una compañía de remodelación 3057470061 este es mi número"),
);
check("'yo sé instalar pisos' → job seeker", isJobSeeker("yo sé instalar pisos de todo tipo"));
check(
  "Customer asking US to install is NOT a job seeker",
  !isJobSeeker("Do you install vinyl floors in Miami? I need my house done"),
);

async function repeatInterceptChecks() {
  console.log("\n── 5. Repeated-message intercept (no paid call, no identical re-answer) ──");
  // The early return fires BEFORE the API call, so this test costs zero tokens.
  const repeated = await getAIResponse(
    [
      { role: "user", content: "What is the installation process?" },
      { role: "assistant", content: "We move all the furniture, install the floors, add the quarter round, clean everything up, all within 2 to 3 days." },
      { role: "user", content: "What is the installation process?" },
    ],
    null,
    null,
    null,
    false
  );
  check("Identical re-sent question → [REACT_ONLY], zero tokens", repeated.text === "[REACT_ONLY]" && repeated.inputTokens === 0);
  check(
    "Re-sent ADDRESS is exempt from the intercept (booking payload)",
    containsBookingInfo("11725 sw 17 ct Miramar fl 33025"),
  );
}

repeatInterceptChecks().then(() => {
  console.log(`\n=========== CONVERSION-FIXES-VERIFY: ${passed} passed, ${failed} failed ===========`);
  process.exit(failed > 0 ? 1 : 0);
});
