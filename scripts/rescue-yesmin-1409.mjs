// RESGATE — Yesmin Alabart (WA 17862771353), 14/09/2026.
//
// Ontem (13/09 18:02) o bot escreveu "Listo Yesmin, te agendo el lunes 14 de
// septiembre a las 3pm" SEM gravar a visita (nunca emitiu o [BOOK]). Ela acha
// que tem visita HOJE às 15h em 1846 Willey St, Hollywood FL 33020.
// Conferido só-leitura hoje de manhã: 15h e 16h de hoje já foram tomados por
// outras clientes; aberturas reais de hoje: 17h, 18h, 19h, 20h; amanhã (ter 15):
// 11am, 1pm, 2pm, 3pm, 4pm, 5pm, 6pm, 7pm, 8pm.
//
// A mensagem pede desculpa, oferece 2 horários e a resposta dela ("a las 5")
// cai no bot, que grava o [BOOK] normalmente (agora com o retry forçado).
//
// Uso:
//   node scripts/rescue-yesmin-1409.mjs            (dry-run: só mostra, não envia)
//   node scripts/rescue-yesmin-1409.mjs --send     (envia de verdade)
import { readFileSync } from "fs";

const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const SECRET = process.env.ADMIN_SECRET ?? env.ADMIN_SECRET;
if (!SECRET) { console.error("ADMIN_SECRET não encontrado (env ou .env.local)"); process.exit(1); }

const send = process.argv.includes("--send");
const body = {
  tipo: "mensagem_direta",
  telefone: "17862771353",
  mensagem: "Hola Yesmin, te pido disculpas: ayer te dije que quedaba agendada la visita de hoy a las 3pm y no logré dejarla registrada en el sistema, y esa hora ya no está disponible. Sigo con muchas ganas de ir a medir en 1846 Willey St: hoy tengo a las 5pm o a las 6pm, o mañana martes a las 11am o a la 1pm. Cual te queda mejor y te la confirmo de inmediato? Si prefieres, también puedes llamar o escribirle a Ozzi directamente al (561) 674-8334.",
  dry: !send,
};
console.log((send ? "ENVIANDO" : "DRY-RUN (nada será enviado; rode com --send)") + ":\n" + body.mensagem + "\n");
const res = await fetch("https://instagram-dm-agent-chi.vercel.app/api/enviar", {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-secret": SECRET },
  body: JSON.stringify(body),
});
console.log(res.status, await res.text());
