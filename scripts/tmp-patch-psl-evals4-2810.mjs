// PATCH (28/10/2026): book-promise-mismatch e booked-time fixavam needTimeChoiceMessage(...) sem o filtro de Port St. Lucie.
import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  { file: "src/evals/book-promise-mismatch-verify.ts",
    find: String.raw`needTimeChoiceMessage\(lang,\s*pm\.promisedDate\s*\?\?\s*bookingData\.date(?:,\s*bookingData\.address)?\)/.test(src), rel);`,
    replace: String.raw`needTimeChoiceMessage\(lang,\s*pm\.promisedDate\s*\?\?\s*bookingData\.date(?:,\s*bookingData\.address)?(?:,\s*\{ portStLucie: pslHours \})?\)/.test(src), rel);` },
  { file: "src/evals/booked-time-verify.ts",
    find: String.raw`needTimeChoiceMessage\(lang,\s*bookingData\.date(?:,\s*bookingData\.address)?\)/.test(src), rel);`,
    replace: String.raw`needTimeChoiceMessage\(lang,\s*bookingData\.date(?:,\s*bookingData\.address)?(?:,\s*\{ portStLucie: pslHours \})?\)/.test(src), rel);` },
]);
