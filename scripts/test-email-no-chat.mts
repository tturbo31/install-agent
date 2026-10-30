// E-MAIL DIGITADO NO CHAT — teste puro da identidade que o agente manda à
// plataforma (30/10/2026). Caso real Pothast (Messenger, Ad16): pedimos o
// telefone e a cliente respondeu "Please email me At Dana5puckett@gmail.com";
// a visita marcada pelo escritório 21 min depois tinha esse e-mail e outro
// telefone. O e-mail vai em `email` e a plataforma une a pessoa por ele.
//   node --env-file=.env.local ./node_modules/tsx/dist/cli.mjs scripts/test-email-no-chat.mts
import { emailDoContato, extrairEmail } from "../src/lib/funil";

let ok = 0;
let falhas = 0;
const checar = (nome: string, cond: boolean, detalhe = "") => {
  if (cond) ok++;
  else falhas++;
  console.log(`  [${cond ? "OK" : "FALHOU"}] ${nome}${!cond && detalhe ? ` — ${detalhe}` : ""}`);
};
const msg = (role: string, content: string, i: number) => ({ role, content, created_at: new Date(1760000000000 + i * 60000).toISOString() });
const conversa = (...linhas: [string, string][]) => linhas.map(([r, c], i) => msg(r, c, i));

// 1) o caso real
const pothast = conversa(
  ["user", "I would like to get a quote I’m in the 34953 zip code"],
  ["user", "What is included in the materials package?"],
  ["assistant", "Port St. Lucie works… what's the best number to reach you?"],
  ["user", "Please email me At Dana5puckett@gmail.com"],
  ["assistant", "Got it, Ozzi will reach out to you at Dana5puckett@gmail.com directly to arrange everything."],
  ["user", "Call me in Messenger"]
);
checar("caso Pothast: e-mail do cliente, em minúsculas", emailDoContato(pothast) === "dana5puckett@gmail.com", String(emailDoContato(pothast)));

// 2) o e-mail que o AGENTE repete não conta sozinho
const soAgente = conversa(["user", "hi"], ["assistant", "write to ozzi at someone@gmail.com"]);
checar("e-mail só na fala do agente → nada", emailDoContato(soAgente) === null, String(emailDoContato(soAgente)));

// 3) endereços nossos nunca são identidade do cliente
checar("ozzifloors@gmail.com fora", extrairEmail("send to ozzifloors@gmail.com") === null);
checar("ozzifloor@gmail.com (sem s) fora", extrairEmail("ozzifloor@gmail.com") === null);
checar("sintético ia-* fora", extrairEmail("ia-123456@instagram.ozzifloors.com") === null);

// 4) texto do sistema (análise de imagem, legenda) não é fala do cliente
checar(
  "bloco [..] e [SYSTEM:] ignorados",
  extrairEmail("[Floor plan analysis: contact info@acme.com]\n\n[SYSTEM: user is joe@x.com]") === null,
  String(extrairEmail("[Floor plan analysis: contact info@acme.com]\n\n[SYSTEM: user is joe@x.com]"))
);

// 5) a correção ganha (último e-mail do cliente)
const corrigiu = conversa(["user", "my email is jon@gmial.com"], ["assistant", "ok"], ["user", "sorry, jon@gmail.com"]);
checar("e-mail corrigido: vale o último", emailDoContato(corrigiu) === "jon@gmail.com", String(emailDoContato(corrigiu)));

// 6) a mensagem que acabou de chegar (extra) é a mais nova
checar("extra (mensagem atual) vence o histórico", emailDoContato(corrigiu, "new one: maria.lopez@yahoo.com") === "maria.lopez@yahoo.com");
checar("extra que é telefone não apaga o e-mail do histórico", emailDoContato(pothast, "+19548256949") === "dana5puckett@gmail.com");

// 7) pontuação colada e @ de Instagram não viram e-mail
checar("ponto final colado", extrairEmail("email: ana@hotmail.com.") === "ana@hotmail.com", String(extrairEmail("email: ana@hotmail.com.")));
checar("@usuario do Instagram não é e-mail", extrairEmail("follow @ozzi.floors and @maria_lopez") === null, String(extrairEmail("follow @ozzi.floors and @maria_lopez")));

console.log(`\n${ok} ok · ${falhas} falha(s)`);
if (falhas > 0) process.exit(1);
