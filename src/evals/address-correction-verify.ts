// Verifica o CASO KRISTINA MITTENDORFF (2026-08-13, IG):
//
//  07/08 22:04 a cliente digitou "300 s Australian Av, 1506, 33401" e o bot
//  gravou exatamente isso (a IA NÃO inventou o 1506). Em 11/08 14:14 ela mandou
//  "300 s Australian Av 916" — a MESMA rua, outro apartamento. Não existia
//  NENHUM caminho no código que atualizasse o endereço de uma visita já
//  confirmada: a correção morreu no fluxo silencioso de booked, a agenda ficou
//  com o 1506 e o vendedor foi para o apartamento errado na visita de 13/08.
//
//  FIX 1: detectAddressCorrection + applyPostBookingAddressCorrection —
//         determinístico, o modelo não opina. Troca de UNIDADE na mesma rua é
//         gravada sozinha; rua diferente só notifica o dono.
//  FIX 2: os 3 webhooks chamam o intercept ANTES do fluxo silencioso de booked,
//         respondem ao cliente e mandam o alerta com antes/depois pro dono.
//  FIX 3: rescheduleClientBooking aceita clientBurst — o endereço antigo SEMPRE
//         vencia (old.address ?? fallback), então uma correção mandada no mesmo
//         turno da remarcação era descartada em silêncio.
//
// 100% determinístico: nenhuma chamada de API, nenhum banco.
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseStreetAddress,
  detectAddressCorrection,
  mayCarryAddressCorrection,
  addressCorrectedMessage,
  addressChangeHandoffMessage,
  postBookingAddressAlert,
  recentClientText,
} from "../lib/scheduler";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 200)}»`); }
}

const BOOKED = "300 S Australian Ave, 1506, West Palm Beach FL 33401";

async function main() {
  console.log("\n============= ADDRESS-CORRECTION VERIFICATION (caso Kristina) =============");

  // ── 1. O parser ───────────────────────────────────────────────────────────
  console.log("\n[1] parseStreetAddress");
  const p = parseStreetAddress(BOOKED);
  ck("endereço gravado: casa 300", p?.house === "300", JSON.stringify(p));
  ck("endereço gravado: rua australian", p?.street === "australian", JSON.stringify(p));
  ck("endereço gravado: sufixo ave", p?.suffix === "ave", JSON.stringify(p));
  ck("endereço gravado: unidade 1506", p?.unit === "1506", JSON.stringify(p));
  ck("endereço gravado: cidade/estado/zip preservados no tail", (p?.tail ?? "").includes("33401"), JSON.stringify(p));

  const c = parseStreetAddress("300 s Australian Av 916");
  ck('"Av" abreviado normaliza para "ave"', c?.suffix === "ave", JSON.stringify(c));
  ck("unidade solta depois do sufixo = 916", c?.unit === "916", JSON.stringify(c));

  // O ZIP nunca pode ser lido como unidade.
  ck("ZIP não vira unidade", parseStreetAddress("300 S Australian Ave 33401")?.unit === null,
    JSON.stringify(parseStreetAddress("300 S Australian Ave 33401")));
  // Sem sufixo de rua reconhecido não há palpite.
  ck("sem sufixo de rua → null", parseStreetAddress("300 Australian 916") === null);
  ck("texto solto → null", parseStreetAddress("I will not be in the apartment today") === null);

  // ── 2. A correção real ────────────────────────────────────────────────────
  console.log("\n[2] detectAddressCorrection — CASO REAL");
  const real = detectAddressCorrection("300 s Australian Av 916", BOOKED);
  ck("11/08 detecta troca de unidade", real?.kind === "unit", JSON.stringify(real));
  ck("nova unidade = 916", real?.kind === "unit" && real.unit === "916", JSON.stringify(real));
  ck("unidade anterior = 1506", real?.kind === "unit" && real.previousUnit === "1506", JSON.stringify(real));
  ck(
    "endereço remontado mantém cidade/estado/ZIP que a cliente não repetiu",
    real?.address === "300 S Australian Ave, 916, West Palm Beach FL 33401",
    real?.address ?? "null"
  );
  // A rajada real chega com várias bolhas juntas.
  const burstReal = "I spoke yesterday with our property manager\n300 s Australian Av 916\n9144093787";
  ck("rajada multi-bolha acha o endereço", detectAddressCorrection(burstReal, BOOKED)?.kind === "unit");

  // ── 3. Outras formas de corrigir a unidade ────────────────────────────────
  console.log("\n[3] detectAddressCorrection — outras formas de correção");
  for (const t of ["Apt 916", "apt. 916", "#916", "unit 916 please", "Suite 916", "apartamento 916", "unidad 916"]) {
    const r = detectAddressCorrection(t, BOOKED);
    ck(`unidade solta: "${t}"`, r?.kind === "unit" && r.unit === "916", JSON.stringify(r));
  }
  const full = detectAddressCorrection("300 s australian avenue apt 916, west palm beach fl 33401", BOOKED);
  ck("endereço completo com apt", full?.kind === "unit" && full.unit === "916", JSON.stringify(full));

  // ── 4. NEGATIVOS: o que NÃO pode virar correção ───────────────────────────
  //     Um falso positivo aqui reescreve o endereço de uma visita confirmada.
  console.log("\n[4] detectAddressCorrection — NEGATIVOS (nunca reescrever à toa)");
  const negatives: Array<[string, string]> = [
    [BOOKED, "o MESMO endereço gravado"],
    ["300 s Australian Av, 1506, 33401", "o mesmo, no formato que a cliente digitou"],
    ["300 S Australian Ave, 1506", "o mesmo sem o ZIP"],
    ["300 S Australian Ave West Palm Beach FL 33401", "o mesmo sem unidade nenhuma"],
    ["Hello, what happened? You never came.??", "cobrança"],
    ["The apartment is 750 including the bathroom", "metragem"],
    ["Apartment 750 sqft", "metragem colada em 'apartment'"],
    ["I will not be in the apartment but you can send a quote", "menção a apartamento sem número"],
    ["ok the price seems reasonable, around $4,000", "preço"],
    ["9144093787", "telefone"],
    ["My gate code is 4455", "gate code"],
    ["yes 3pm works", "confirmação de horário"],
    ["Thanks!", "fechamento"],
    ["", "vazio"],
  ];
  for (const [t, label] of negatives) {
    ck(`negativo (${label})`, detectAddressCorrection(t, BOOKED) === null, JSON.stringify(detectAddressCorrection(t, BOOKED)));
  }

  // ── 5. Rua diferente = decisão do dono, nunca sobrescrita automática ──────
  console.log("\n[5] rua diferente → moved (dono decide)");
  const moved = detectAddressCorrection("1234 NW 7th St, Miami FL 33125", BOOKED);
  ck("outra rua detectada como moved", moved?.kind === "moved", JSON.stringify(moved));
  ck("moved NÃO traz endereço remontado para gravar", moved?.kind === "moved" && !("unit" in moved));

  // ── 6. Pré-filtro barato (evita login+select no banco a cada mensagem) ────
  console.log("\n[6] mayCarryAddressCorrection — pré-filtro");
  ck("passa: endereço com rua", mayCarryAddressCorrection("300 s Australian Av 916"));
  ck("passa: unidade solta", mayCarryAddressCorrection("Apt 916"));
  ck("barra: cobrança", !mayCarryAddressCorrection("Hello, what happened? You never came.??"));
  ck("barra: metragem", !mayCarryAddressCorrection("Apartment 750 sqft"));
  ck("barra: telefone", !mayCarryAddressCorrection("9144093787"));
  ck("barra: vazio", !mayCarryAddressCorrection(""));
  // O pré-filtro NUNCA pode barrar algo que a detecção acharia.
  for (const [t] of [["300 s Australian Av 916"], ["Apt 916"], ["#916"], ["unit 916 please"], ["Suite 916"], ["1234 NW 7th St, Miami FL 33125"]] as Array<[string]>) {
    if (detectAddressCorrection(t, BOOKED)) {
      ck(`pré-filtro não engole detecção: "${t}"`, mayCarryAddressCorrection(t));
    }
  }

  // ── 7. Mensagens ao cliente e alerta ao dono ─────────────────────────────
  console.log("\n[7] mensagens");
  const okMsg = addressCorrectedMessage("en", "916");
  ck("confirmação cita a unidade nova", okMsg.includes("916"), okMsg);
  ck("confirmação sem travessão (regra do dono)", !/—|--/.test(okMsg), okMsg);
  ck("confirmação sem emoji", !/[\u{1F300}-\u{1FAFF}]/u.test(okMsg), okMsg);
  ck("versão ES existe e difere", addressCorrectedMessage("es", "916") !== okMsg);
  ck("handoff de mudança não promete nada", /Ozzi/.test(addressChangeHandoffMessage("en")), addressChangeHandoffMessage("en"));

  const alertUnit = postBookingAddressAlert({ kind: "unit", unit: "916", address: "300 S Australian Ave, 916, West Palm Beach FL 33401", previousAddress: BOOKED, bookingId: "x" });
  ck("alerta do dono mostra antes E depois", alertUnit.includes("1506") && alertUnit.includes("916"), alertUnit);
  const alertFail = postBookingAddressAlert({ kind: "failed", address: "a", previousAddress: "b", bookingId: "x", error: "rls" });
  ck("alerta de FALHA manda corrigir na plataforma", /FALHA/i.test(alertFail) && /plataforma/i.test(alertFail), alertFail);
  const alertMoved = postBookingAddressAlert({ kind: "moved", address: "a", previousAddress: "b", bookingId: "x" });
  ck("alerta de rua nova diz que NÃO alterou", /NAO foi alterado/i.test(alertMoved), alertMoved);

  // ── 8. recentClientText: o sufixo [SYSTEM:] já quebrou regex antes ───────
  console.log("\n[8] recentClientText");
  const hist = [
    { role: "user", content: "300 s Australian Av 916\n\n[SYSTEM: client replied to ad X]" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "9144093787" },
  ];
  const rct = recentClientText(hist);
  ck("junta só as falas do cliente", !rct.includes("ok"), rct);
  ck("remove o sufixo [SYSTEM:]", !rct.includes("[SYSTEM:"), rct);
  ck("o endereço sobrevive à limpeza", detectAddressCorrection(rct, BOOKED)?.kind === "unit", rct);

  // ── 9. Estático: os 3 webhooks têm o intercept e passam o burst ──────────
  console.log("\n[9] estático — os 3 canais");
  const files: Array<[string, string]> = [
    ["IG", "src/app/api/webhook/route.ts"],
    ["Messenger", "src/app/api/fb-webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
  ];
  for (const [canal, rel] of files) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${canal}: chama applyPostBookingAddressCorrection`, src.includes("applyPostBookingAddressCorrection("), rel);
    ck(`${canal}: responde ao cliente (não fica mudo)`, src.includes("addressCorrectedMessage(") && src.includes("addressChangeHandoffMessage("), rel);
    ck(`${canal}: alerta o dono com antes/depois`, src.includes("postBookingAddressAlert(corr)"), rel);
    ck(`${canal}: remarcação leva o burst do cliente`, src.includes("clientBurst: recentClientText(history)"), rel);
    // O intercept tem que rodar ANTES do fluxo silencioso de booked, senão a
    // correção continua morrendo exatamente como no caso Kristina.
    const iAddr = src.indexOf("applyPostBookingAddressCorrection(");
    const iSilent = src.indexOf("if (isBooked && !engageReschedule) {\r\n      try {");
    ck(`${canal}: intercept vem ANTES do notify silencioso`, iAddr > 0 && iSilent > 0 && iAddr < iSilent, `addr=${iAddr} silent=${iSilent}`);
  }

  // ── 10. Estático: rescheduleClientBooking não descarta mais a correção ───
  console.log("\n[10] estático — remarcação");
  const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  ck("reschedule aceita clientBurst", /clientBurst\?: string/.test(sched));
  ck("reschedule aplica a correção de unidade", /corr\?\.kind === "unit"[\s\S]{0,120}addressToUse = corr\.address/.test(sched));
  ck(
    "o endereço antigo não vence mais cegamente",
    !/address: \(old\.address \?\? fallback\?\.address \?\? ""\)/.test(sched)
  );
  ck("update checa error E linhas afetadas", /!data \|\| data\.length === 0[\s\S]{0,60}no_rows_updated/.test(sched));

  console.log(`\n────────── ${pass} passaram, ${fail} falharam ──────────`);
  if (fail) {
    console.log("FALHAS:");
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
