// PATCH (28/10/2026): run.ts ainda esperava a RECUSA de Port St. Lucie (regra antiga, anterior a 26/09).
// Regra 28/10: 1.000 sq ft ou mais em PSL = visita (nunca recusa, nunca "o Ozzi entra em contato").
import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  { file: "src/evals/run.ts",
    find: `  noPermitPriceByDM: {`,
    replace: `  servesPortStLucieVisit: {
    label: 'Port St. Lucie 1,000+ sq ft: serves it (no decline), proposes the visit, no "Ozzi will reach out", no Ozzi number',
    check: (t: string) =>
      !/don'?t service|do not service|not service that area|don'?t cover|do not cover|outside our (?:area|service)|north of jupiter/i.test(t) &&
      /visit|in.?person|come by|measure|stop by|zip|\\d\\s*(?:am|pm)\\b/i.test(t) &&
      !/will reach out|674[\\s.-]?8334/i.test(t),
  },
  noPermitPriceByDM: {` },
  { file: "src/evals/run.ts",
    find: `  // Owner: we only serve Homestead/Miami up to Jupiter. Port St. Lucie (and the
  // Treasure Coast north of Jupiter) is OUT of area, must decline.
  {
    name: '[BUG FIX] Port St. Lucie → decline, out of service area',
    messages: [{ role: "user", content: "Do you guys come out to Port St. Lucie? Whole house about 1800 sqft." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "declinesOutOfArea"],
  },`,
    replace: `  // Owner: we only serve Homestead/Miami up to Jupiter; the Treasure Coast north
  // of Jupiter is OUT of area, must decline. The ONE exception is Port St. Lucie
  // (owner rule 2026-09-26, sizes 2026-10-28): 1,000+ sq ft there is a visit.
  {
    name: '[RULE 2026-10-28] Port St. Lucie 1800 sqft → served, free visit (never decline)',
    messages: [{ role: "user", content: "Do you guys come out to Port St. Lucie? Whole house about 1800 sqft." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "servesPortStLucieVisit"],
  },` },
]);
