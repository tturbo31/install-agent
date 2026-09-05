// RESGATE — Aida Álvarez (WA 13053051530), 05/09/2026.
//
// Tinha visita terça 01/09 3pm. Uma hora antes pediu "podrías pasar a las 5:00"
// e o bot ficou MUDO (buraco corrigido em 05/09: verbo "pasar a las N" não era
// remarcação). A visita das 3pm se perdeu ("Estuvo aquí no los vi"), o vendedor
// Alexandre a reprogramou para TERÇA 08/09 às 5pm no scheduler, e ela recebeu
// algo sobre "septiembre 8" que não entendeu. Mandou 5 mensagens confusas
// ("No me respondiste ok", "Que es esto? No entiendo") — todas sem resposta.
//
// Este script manda UMA mensagem em espanhol explicando a visita real de 08/09
// e perguntando se serve. Se ela responder pedindo outro horário, o bot agora
// engaja a remarcação normalmente.
//
// Uso:
//   node scripts/rescue-aida-0509.mjs            (dry-run: só mostra, não envia)
//   node scripts/rescue-aida-0509.mjs --send     (envia de verdade)
import { readFileSync } from "fs";

const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const SECRET = process.env.ADMIN_SECRET ?? env.ADMIN_SECRET;
if (!SECRET) { console.error("ADMIN_SECRET não encontrado (env ou .env.local)"); process.exit(1); }

const send = process.argv.includes("--send");
const body = {
  tipo: "mensagem_direta",
  telefone: "13053051530",
  mensagem: "Hola Aida, mil disculpas por la demora en responderle, se me pasaron sus mensajes y no fue mi intención dejarla sin respuesta. Le explico: su visita gratuita para medir en 13901 SW 176 Lane quedó reprogramada para el martes 8 de septiembre a las 5pm. Le funciona ese día y hora? Si prefiere otro momento, dígame y lo acomodamos sin problema.",
  dry: !send,
};
console.log((send ? "ENVIANDO" : "DRY-RUN (nada será enviado; rode com --send)") + ":\n" + body.mensagem + "\n");
const res = await fetch("https://instagram-dm-agent-chi.vercel.app/api/enviar", {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-secret": SECRET },
  body: JSON.stringify(body),
});
console.log(res.status, await res.text());
