// PATCH (28/10/2026): o LARGE LEAD ALERT dos webhooks (>= 500 sqft → "You MUST propose the free in-person
// visit") contradiz o fluxo de Port St. Lucie abaixo de 1.000 sq ft (número do Ozzi) e o de metragem
// desconhecida. Enquanto PSL for "referral" (ask_size / call_ozzi), o alerta não entra.
import { applyPatches } from "./tmp-patch-lib.mjs";
const P = [];
for (const file of ["src/app/api/fb-webhook/route.ts", "src/app/api/wa-webhook/route.ts", "src/app/api/webhook/route.ts"]) {
  P.push({ file, find: "portStLucieStanding, portStLucieLeak, portStLucieMode, portStLucieReply, PORT_ST_LUCIE_ALERT,", replace: "portStLucieStanding, portStLucieLeak, portStLucieMode, portStLucieReply, portStLucieReferral, PORT_ST_LUCIE_ALERT," });
  P.push({ file,
    find: "        if (detectedSqft) {\n",
    replace: "        // Port St. Lucie under 1,000 sq ft / size unknown (owner rule 2026-10-28):\n        // no \"propose the visit\" alert, the PSL note owns that reply.\n        if (detectedSqft && !portStLucieReferral(history)) {\n" });
}
applyPatches(P);
