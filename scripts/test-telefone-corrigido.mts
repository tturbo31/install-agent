// TELEFONE CORRIGIDO NO CHAT — teste puro da identidade que o agente manda à
// plataforma (22/10/2026). Caso real Dilshad: "7727 Southampton Terr …
// 9648256949" e, horas depois, "let me give you my # again, 9548256949". O
// `telefone` continua o 1º digitado (fill-if-empty na plataforma); a correção
// vai em `telefone_conversa`, que une as duas identidades.
//   node --env-file=.env.local ./node_modules/tsx/dist/cli.mjs scripts/test-telefone-corrigido.mts
import { telefoneCorrigidoNoChat, telefoneDoContato, telefoneDigitadoNoWhatsApp } from "../src/lib/funil";

let ok = 0;
let falhas = 0;
const checar = (nome: string, cond: boolean, detalhe = "") => {
  if (cond) ok++;
  else falhas++;
  console.log(`  [${cond ? "OK" : "FALHOU"}] ${nome}${!cond && detalhe ? ` — ${detalhe}` : ""}`);
};
const msg = (role: string, content: string, i: number) => ({ role, content, created_at: new Date(1760000000000 + i * 60000).toISOString() });
const conversa = (...linhas: [string, string][]) => linhas.map(([r, c], i) => msg(r, c, i));

// 1) o caso real, Messenger
const dilshad = conversa(
  ["user", "Is installation labor cost extra?"],
  ["assistant", "Hi, our vinyl promo includes the floor…"],
  ["user", "7727 Southampton Terr F-403 Tamarac, Florida. 33321 9648256949"],
  ["assistant", "Appointment confirmed for Sunday, October 18 at 7pm."],
  ["user", "I didn't receive any call yet, but Iet me give you my # again, 9548256949. I'm waiting"]
);
checar("Messenger: `telefone` segue o 1º digitado", telefoneDoContato("fb_26152365841132464", dilshad) === "+19648256949", String(telefoneDoContato("fb_26152365841132464", dilshad)));
checar("Messenger: a correção vai em telefone_conversa", telefoneCorrigidoNoChat("fb_26152365841132464", dilshad) === "+19548256949", String(telefoneCorrigidoNoChat("fb_26152365841132464", dilshad)));

// 2) um número só → nada a corrigir
const umSo = conversa(["user", "my number is (954) 825-6949"], ["user", "954-825-6949 again, same one"]);
checar("mesmo número repetido não é correção", telefoneCorrigidoNoChat("fb_1", umSo) === null, String(telefoneCorrigidoNoChat("fb_1", umSo)));
checar("sem telefone nenhum → null", telefoneCorrigidoNoChat("fb_1", conversa(["user", "hello"], ["user", "1000 sq ft, zip 33321"])) === null);

// 3) três números: vence o ÚLTIMO diferente do principal
const tres = conversa(["user", "954 236 1837"], ["user", "sorry, 954 226 1837"], ["user", "actually call my husband 954 934 6633"]);
checar("vários números: o último diferente do 1º", telefoneCorrigidoNoChat("fb_2", tres) === "+19549346633", String(telefoneCorrigidoNoChat("fb_2", tres)));

// 4) WhatsApp: o principal é o número do chat; o digitado diferente vai em telefone_conversa
const wa = conversa(["user", "Daniel / Phone: 5618721042"], ["user", "sorry 561-872-1043"]);
checar("WhatsApp: principal = número do chat", telefoneDoContato("wa_972509892288", wa) === "+972509892288");
checar("WhatsApp: corrigido = último digitado diferente do chat", telefoneCorrigidoNoChat("wa_972509892288", wa) === "+15618721043", String(telefoneCorrigidoNoChat("wa_972509892288", wa)));
checar("WhatsApp: a função antiga segue dando o 1º (compatibilidade)", telefoneDigitadoNoWhatsApp("wa_972509892288", wa) === "+15618721042");
checar("WhatsApp: cliente digita o próprio número do chat → nada", telefoneCorrigidoNoChat("wa_19548256949", conversa(["user", "954-825-6949"])) === null);

// 5) texto do sistema e os NOSSOS números nunca contam
const sistema = conversa(["user", "[Floor plan analysis: … call (908) 803-1400 …] here is mine 305-555-0123"], ["user", "your number is 561-674-8334 right?"]);
checar("bloco do sistema e número da Ozzi ignorados", telefoneCorrigidoNoChat("fb_3", sistema) === null && telefoneDoContato("fb_3", sistema) === "+13055550123", `${telefoneDoContato("fb_3", sistema)} / ${telefoneCorrigidoNoChat("fb_3", sistema)}`);

// 6) `extra` (texto da mensagem que ainda não está no histórico) conta como última fala
checar("extra com número novo é a correção", telefoneCorrigidoNoChat("fb_4", conversa(["user", "786-200-2828"]), "oops, 786-200-2827") === "+17862002827");
checar("extra com o mesmo número não é correção", telefoneCorrigidoNoChat("fb_4", conversa(["user", "786-200-2828"]), "786 200 2828") === null);

console.log(`\n${ok} OK · ${falhas} FALHA(S)`);
process.exit(falhas > 0 ? 1 : 0);
