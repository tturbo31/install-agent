// RESGATE — Josue Gonzalez (WA 16032882225), ATUALIZADO 05/09/2026.
//
// O rescue-josue-0309.mjs NUNCA foi enviado (conferido 05/09: zero mensagens
// na janela e zero visitas no scheduler para esse telefone). O cliente ficou
// acreditando na visita fantasma de SÁBADO 05/09 9am — que é HOJE.
//
// Slots do script antigo (sáb 11am/1pm) já eram: conferido só-leitura em
// 05/09 de manhã, o sábado está TODO ocupado. Aberturas reais:
//   domingo 06/09: 7pm   |   segunda 07/09: 9am, 1pm-7pm
//
// Uso:
//   node scripts/rescue-josue-0509.mjs            (dry-run: só mostra, não envia)
//   node scripts/rescue-josue-0509.mjs --send     (envia de verdade)
//
// Regra 24 respeitada: não dizemos que o horário "foi tomado".
import { readFileSync } from "fs";

const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const SECRET = process.env.ADMIN_SECRET ?? env.ADMIN_SECRET;
if (!SECRET) { console.error("ADMIN_SECRET não encontrado (env ou .env.local)"); process.exit(1); }

const send = process.argv.includes("--send");
const body = {
  tipo: "mensagem_direta",
  telefone: "16032882225",
  mensagem: "Hi Josue! I'm really sorry about the mix-up with your Saturday visit, I couldn't lock in the 9am today and I should have told you sooner. I'd still love to come measure at 324 North E Street, Lake Worth: I have tomorrow Sunday at 7pm, or Monday at 9am or 1pm. Which one works better for you and I'll get you confirmed right away?",
  dry: !send,
};
console.log((send ? "ENVIANDO" : "DRY-RUN (nada será enviado; rode com --send)") + ":\n" + body.mensagem + "\n");
const res = await fetch("https://instagram-dm-agent-chi.vercel.app/api/enviar", {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-secret": SECRET },
  body: JSON.stringify(body),
});
console.log(res.status, await res.text());
