// PATCH (28/10/2026): far-date-booking fixava getRealAvailabilityContext({ history }) sem o filtro de Port St. Lucie.
import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  { file: "src/evals/far-date-booking-verify.ts",
    find: String.raw`/getRealAvailabilityContext\(\{ history \}\)/.test(src)`,
    replace: String.raw`/getRealAvailabilityContext\(\{ history(?:, portStLucie: portStLucieStanding\(history\))? \}\)/.test(src)` },
]);
