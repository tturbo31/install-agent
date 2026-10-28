// PATCH (28/10/2026): evals que fixavam o código antigo de Port St. Lucie / da agenda.
import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  { file: "src/evals/fill-the-day-verify.ts",
    find: String.raw`/const slots = openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff, notBefore\);/.test(sc)`,
    replace: String.raw`/const slots = pslOnly\(openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff, notBefore\)\);/.test(sc)` },
  { file: "src/evals/fill-the-day-verify.ts",
    find: String.raw`/const times = openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff, notBefore\);\s*if \(times\.length > 0\) out\.push/.test(sc)`,
    replace: String.raw`/const all = openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff, notBefore\);\s*const times = opts\?\.portStLucie \? all\.filter\(portStLucieHourAllowed\) : all;\s*if \(times\.length > 0\) out\.push/.test(sc)` },
  { file: "src/evals/lang-pt-canned-verify.ts",
    find: `sched.indexOf("Same-day alternatives first") < sched.indexOf("getNextOpenSlots(21)")`,
    replace: `sched.indexOf("Same-day alternatives first") < sched.indexOf("getNextOpenSlots(21, opts)")` },
  { file: "src/evals/out-of-area-zip-verify.ts",
    find: String.raw`(ai.match(/!portStLucieStanding\(messages\) && outOfAreaZipStanding\(messages\) === null/g) ?? []).length === 5`,
    replace: String.raw`(ai.match(/!portStLucieReferral\(messages\) && outOfAreaZipStanding\(messages\) === null/g) ?? []).length === 5` },
  { file: "src/evals/out-of-area-zip-verify.ts",
    find: String.raw`    // Controle: PSL continua no fluxo do dono
    const c2 = await get([...fran.slice(0, -1), U("34953")]);
    console.log("   C2:", clean(c2).replace(/\s+/g, " ").slice(0, 200));
    ck("controle 34953 (PSL): handoff do dono, não a recusa", isPortStLucieHandoff(c2) && !declines(c2), c2);`,
    replace: String.raw`    // Controle: PSL tem fluxo próprio (regra 28/10: "3 bedroom" sem metragem → pergunta a metragem)
    const c2 = await get([...fran.slice(0, -1), U("34953")]);
    console.log("   C2:", clean(c2).replace(/\s+/g, " ").slice(0, 200));
    ck("controle 34953 (PSL sem metragem): pergunta a metragem, não a recusa", isSizeAsk(c2) && /Port St\. Lucie/.test(c2) && !declines(c2) && !isPortStLucieHandoff(c2), c2);` },
  { file: "src/evals/out-of-area-zip-verify.ts",
    find: "portStLucieStanding, isPortStLucieHandoff, clientAlreadyGaveZip,",
    replace: "portStLucieStanding, isPortStLucieHandoff, isSizeAsk, clientAlreadyGaveZip," },
  { file: "src/evals/ig-no-links-verify.ts",
    find: String.raw`neutralizeLinks\(stripForbiddenTags\(portStLucieStanding\(history\) \? afterNotify : redirectOwnerPromiseToPhone\(afterNotify, lang\)\), lang\)`,
    replace: String.raw`neutralizeLinks\(stripForbiddenTags\(redirectOwnerPromiseToPhone\(afterNotify, lang\)\), lang\)` },
]);
