// PATCH (28/10/2026): lang-pt-canned fixava a chamada de slotConflictRecoveryMessage sem o filtro de Port St. Lucie.
import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  { file: "src/evals/lang-pt-canned-verify.ts",
    find: String.raw`/slotConflictRecoveryMessage\(lang, bookingData\.date, history, bookingData\.time(?:, bookingData\.address)?\)/.test(src)`,
    replace: String.raw`/slotConflictRecoveryMessage\(lang, bookingData\.date, history, bookingData\.time(?:, bookingData\.address)?(?:, \{ portStLucie: pslHours \})?\)/.test(src)` },
]);
