// 27/10/2026 — AD PRICE CONTEXT: a nota exige as DUAS metades ($2,350 = só instalação + "$5 per sq ft"), caso ES 2/3 no eval
import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  {
    file: "src/lib/system-prompt.ts",
    find: String.raw`answer with that contrast in one or two short sentences, in their language: the $2,350 is the installation only, you supply the floor, and the full promo at $5 per sq ft includes the luxury vinyl floor, the installation and the quarter round. NEVER let them believe`,
    replace: String.raw`answer with that contrast in one or two short sentences, in their language: the $2,350 is the installation only, you supply the floor, and the full promo at $5 per sq ft includes the luxury vinyl floor, the installation and the quarter round. BOTH halves, every time: first say explicitly that the $2,350 is the installation only (never answer with only the $5 half, the client must hear what the $2,350 does NOT include), then name the full promo as \"$5 per sq ft\" (in Spanish \"$5 por sq ft\", in Portuguese \"$5 por sq ft\"), optionally adding that it is the $5,100 line of the ad. NEVER let them believe`,
  },
]);
