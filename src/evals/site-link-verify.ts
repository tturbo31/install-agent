/**
 * LINK DO SITE NOVO (aviso do dono, 22/09/2026): https://ozzifloors.company
 *
 * Quando o cliente pede para ver amostras / fotos / cores / o site, a resposta
 * (pronta ou do modelo) manda o link NOVO. O antigo (www.ozzifloors.com) não
 * pode sair mais em nenhum canal, nem copiado do histórico da conversa:
 *   1. fonte: nenhum texto de cliente em src/lib e src/app ainda tem o link antigo
 *   2. canonicalizeSiteLink: toda grafia do antigo vira o novo; e-mails,
 *      subdomínios e caminhos reais ficam intactos
 *   3. stripForbiddenTags (portão final dos 3 webhooks) canonicaliza e, ao
 *      limpar [SEND_IMAGES], anexa o link novo
 *   4. smallJobPhotosMessage (menos de 400 sqft) nos 3 idiomas
 *   5. SYSTEM_PROMPT ensina o novo e proíbe o antigo
 *   6. respostas prontas see_options_en / see_options_pt (puro, 0 tokens)
 *   7. AO VIVO (pula com DET_ONLY=1): histórico com o link ANTIGO em fala nossa
 *      + cliente pede o link de novo → sai o NOVO; "what's your website?" → NOVO
 *
 * Run: npx tsx src/evals/site-link-verify.ts   (DET_ONLY=1 pula a parte 7)
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
function loadEnv() {
  try {
    const c = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of c.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* sem .env.local: só a parte pura roda */ }
}
loadEnv();
process.env.ANTHROPIC_API_KEY ||= "unused-pure-eval";
import { getAIResponse, canonicalizeSiteLink, stripForbiddenTags, smallJobPhotosMessage, SITE_URL, type ChatMessage } from "../lib/ai";
import { SYSTEM_PROMPT } from "../lib/system-prompt";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const OLD_LINK = /https?:\/\/(?:www\.)?ozzifloors\.com(?!pany)|www\.ozzifloors\.com/i;
const NEW_LINK = /https:\/\/ozzifloors\.company(?![\w-])/;
const NOTE = "\n\n[SYSTEM: TODAY: Tuesday, September 22, 2026 [2026-09-22].]";

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

async function main() {
  console.log("\n━━ 1. fonte: nenhum link antigo em texto que vai ao cliente (src/lib, src/app) ━━");
  const hits: string[] = [];
  for (const f of [...walk("src/lib"), ...walk("src/app")]) {
    const lines = readFileSync(f, "utf-8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return; // comentários podem citar o endereço antigo
      if (OLD_LINK.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  ck("zero ocorrências de www.ozzifloors.com / https://ozzifloors.com fora de comentários", hits.length === 0, hits.join(" | "));
  ck("SITE_URL é exatamente https://ozzifloors.company", SITE_URL === "https://ozzifloors.company");

  console.log("\n━━ 2. canonicalizeSiteLink ━━");
  const c = canonicalizeSiteLink;
  ck("https://www.ozzifloors.com → novo", c("https://www.ozzifloors.com") === SITE_URL, c("https://www.ozzifloors.com"));
  ck("com barra final e vírgula: '…ozzifloors.com/,' → '…company,'", c("See https://www.ozzifloors.com/, and I bring samples.") === `See ${SITE_URL}, and I bring samples.`, c("See https://www.ozzifloors.com/, and I bring samples."));
  ck("sem esquema: 'at ozzifloors.com and' → link completo", c("Browse at ozzifloors.com and on Instagram") === `Browse at ${SITE_URL} and on Instagram`, c("Browse at ozzifloors.com and on Instagram"));
  ck("http:// e www: 'http://www.ozzifloors.com.' → novo + ponto", c("Site: http://www.ozzifloors.com.") === `Site: ${SITE_URL}.`, c("Site: http://www.ozzifloors.com."));
  ck("maiúsculas: 'OzziFloors.com' → novo", c("Go to OzziFloors.com") === `Go to ${SITE_URL}`, c("Go to OzziFloors.com"));
  ck("novo com barra final solta → sem barra", c(`${SITE_URL}/ ok`) === `${SITE_URL} ok`, c(`${SITE_URL}/ ok`));
  ck("novo já canônico fica igual", c(`See ${SITE_URL}, thanks`) === `See ${SITE_URL}, thanks`);
  ck("caminho real preservado: …company/gallery", c("https://www.ozzifloors.com/gallery") === `${SITE_URL}/gallery`, c("https://www.ozzifloors.com/gallery"));
  ck("e-mail da empresa intacto (ozzifloors@gmail.com)", c("Email us at ozzifloors@gmail.com") === "Email us at ozzifloors@gmail.com");
  ck("e-mail do bot intacto (ia@ozzifloors.com)", c("ia@ozzifloors.com") === "ia@ozzifloors.com");
  ck("subdomínio da agenda intacto (ia-1@instagram.ozzifloors.com)", c("ia-1@instagram.ozzifloors.com") === "ia-1@instagram.ozzifloors.com");
  ck("landing do Google intacta (go.ozzifloors.com)", c("go.ozzifloors.com") === "go.ozzifloors.com");
  ck("texto sem link: identidade", c("Is it one area or the whole house?") === "Is it one area or the whole house?");
  const book = 'All set![BOOK:{"name":"Ana","phone":"3055550142","address":"1 Main St, Miami FL 33101","date":"2026-09-25","time":"09:00","notes":"vinyl"}]';
  ck("[BOOK:{…}] intacto", c(book) === book);
  ck("vazio / undefined não quebra", c("") === "" && c(undefined as unknown as string) === undefined);

  console.log("\n━━ 3. stripForbiddenTags (portão final dos webhooks) ━━");
  const s1 = stripForbiddenTags("Hi![SEND_IMAGES: a.jpg]");
  ck("[SEND_IMAGES] removido e link NOVO anexado", !/SEND_IMAGES/.test(s1) && NEW_LINK.test(s1) && !OLD_LINK.test(s1), s1);
  const s2 = stripForbiddenTags("See https://www.ozzifloors.com [SEND_IMAGES: a.jpg]");
  ck("link antigo + tag → UM link novo, nenhum antigo", (s2.match(/ozzifloors\.company/g) ?? []).length === 1 && !OLD_LINK.test(s2), s2);
  const s3 = stripForbiddenTags("You can see our floors at https://www.ozzifloors.com, and I bring the samples.");
  ck("sem tag: ainda canonicaliza o link antigo", s3 === `You can see our floors at ${SITE_URL}, and I bring the samples.`, s3);
  ck("texto comum sem link: identidade", stripForbiddenTags("Monday at 9am or 11am?") === "Monday at 9am or 11am?");

  console.log("\n━━ 4. smallJobPhotosMessage (menos de 400 sqft) ━━");
  for (const l of ["en", "es", "pt"] as const) {
    const m = smallJobPhotosMessage(l);
    ck(`${l}: link novo + número do Ozzi, sem link antigo`, NEW_LINK.test(m) && /674[-\s]?8334/.test(m) && !OLD_LINK.test(m), m);
  }

  console.log("\n━━ 5. SYSTEM_PROMPT ━━");
  ck("ensina o link novo", (SYSTEM_PROMPT.match(new RegExp(SITE_URL.replace(/[.\/]/g, "\\$&"), "g")) ?? []).length >= 3);
  ck("nenhum link antigo (www.ozzifloors.com / https://ozzifloors.com)", !OLD_LINK.test(SYSTEM_PROMPT));
  ck("proíbe o antigo explicitamente", /old ozzifloors\.com no longer exists/.test(SYSTEM_PROMPT));

  console.log("\n━━ 6. respostas prontas (puro, 0 tokens) ━━");
  const origLog = console.log;
  const ask = async (msgs: ChatMessage[]) => { console.log = () => {}; try { return await getAIResponse(msgs, null, null, null, false); } finally { console.log = origLog; } };
  const en = await ask([U("Can you send me photos of your floors?" + NOTE)]);
  ck("EN 'send me photos' → link novo, 0 tokens", NEW_LINK.test(en.text) && !OLD_LINK.test(en.text) && en.inputTokens === 0, en.text);
  const en2 = await ask([U("Hi, I'm interested in vinyl"), A("Our vinyl promo is $5 per sqft and that already includes the floor, the installation and the quarter round. Is it one area or the whole house?"), U("what colors do you have?" + NOTE)]);
  ck("EN 'what colors do you have' → link novo, 0 tokens", NEW_LINK.test(en2.text) && !OLD_LINK.test(en2.text) && en2.inputTokens === 0, en2.text);
  const pt = await ask([U("Oi, quero vinyl"), A("Nossa promo de vinyl é $5 por pé quadrado e já inclui o piso, a instalação e o quarter round. É só uma área ou a casa toda?"), U("me manda fotos dos pisos?" + NOTE)]);
  ck("PT 'me manda fotos dos pisos' → link novo, 0 tokens", NEW_LINK.test(pt.text) && !OLD_LINK.test(pt.text) && pt.inputTokens === 0, pt.text);

  const live = process.env.DET_ONLY !== "1" && process.env.ANTHROPIC_API_KEY !== "unused-pure-eval";
  if (!live) { console.log("\n━━ 7. AO VIVO: pulado (DET_ONLY=1 ou sem ANTHROPIC_API_KEY) ━━"); return done(); }

  console.log("\n━━ 7. AO VIVO: o modelo nunca devolve o link antigo, nem copiando o histórico ━━");
  const histOld: ChatMessage[] = [
    U("Hi, I'm interested in vinyl flooring for my living room"),
    A("Great, our vinyl promo is $5 per sqft and that already includes the floor, the installation and the quarter round. Is it just one area or the whole house?"),
    U("just the living room, around 450 sqft. can you send me pictures?"),
    A("Sure, you can see our floors at https://www.ozzifloors.com, and I bring all the samples to the free visit. For 450 sqft that comes to about $2,250 all included. Want me to set up the free visit?"),
    U("that link doesn't open for me, can you send it again?" + NOTE),
  ];
  for (let i = 1; i <= 3; i++) {
    const r = await ask(histOld);
    console.log(`   [${i}] →`, r.text.replace(/\s+/g, " ").slice(0, 220));
    ck(`histórico com link antigo, pediu de novo → NOVO e nenhum antigo (${i}/3)`, NEW_LINK.test(r.text) && !OLD_LINK.test(r.text) && r.inputTokens > 0, r.text);
  }
  const histSite: ChatMessage[] = [
    U("Hi, do you install hardwood?"),
    A("Yes, for hardwood our promo is $3.20 per sqft for the installation labor, you supply the material. Is it one area or the whole house?"),
    U("what's your website?" + NOTE),
  ];
  for (let i = 1; i <= 3; i++) {
    const r = await ask(histSite);
    console.log(`   [${i}] →`, r.text.replace(/\s+/g, " ").slice(0, 220));
    ck(`"what's your website?" → link NOVO, nenhum antigo (${i}/3)`, NEW_LINK.test(r.text) && !OLD_LINK.test(r.text), r.text);
  }
  done();
}
function done() {
  console.log(`\n${pass} ✅  ${fail} ❌`);
  if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
