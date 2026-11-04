/**
 * BUSCA DE CLIENTE NO PAINEL (04/11/2026): achar a conversa pelo que o cliente
 * mandou — telefone em qualquer formato, endereço/ZIP, nome do perfil, trecho.
 *
 * Puro (sem modelo, sem banco). Prova:
 *  1. parseSearchQuery: número puro → modo telefone (dígitos); texto/endereço →
 *     palavras sem acento, sem caracteres reservados do PostgREST; curto → nada.
 *  2. digitsPattern: "(954) 123-4567", "954.123.4567" e "9541234567" batem na
 *     mesma busca; dígitos fora de ordem não batem.
 *  3. matchConversationLocally: número do WhatsApp no igsid; nome sem acento;
 *     "105 bandol" acha "105bandol street" (número colado, 26/10); ZIP na última
 *     mensagem; texto só dentro de [SYSTEM:] NÃO conta.
 *  4. highlightSegments / snippetAround: marca o trecho certo e recorta em volta.
 *  5. orGroupAllWords, igsidFromBookingEmail, formatPhone, mergeMatches,
 *     looksLikeAddress, sanitizeWord.
 * Run: npx tsx src/evals/conversation-search-verify.ts
 */
import {
  parseSearchQuery,
  digitsPattern,
  matchConversationLocally,
  highlightSegments,
  snippetAround,
  orGroupAllWords,
  igsidFromBookingEmail,
  mergeMatches,
  scoreOf,
  looksLikeAddress,
  classifyDigitsMatch,
  sanitizeWord,
  foldAccents,
  cleanClientText,
} from "../lib/conversation-search";
import { formatPhone, waPhoneDigits, getChannel } from "../lib/channel";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}

console.log("\n━━ 1. parseSearchQuery ━━");
{
  const p = parseSearchQuery("954 123 4567");
  ck("'954 123 4567' → telefone 9541234567", p.mode === "phone" && p.digits === "9541234567", JSON.stringify(p));
  ck("'(561) 674-8334' → telefone", parseSearchQuery("(561) 674-8334").mode === "phone");
  ck("'8334' (4 últimos) → telefone", parseSearchQuery("8334").mode === "phone");
  ck("'33056' (ZIP) → telefone/dígitos", parseSearchQuery("33056").mode === "phone");
  ck("'+1 561 303 7754' → telefone 15613037754", parseSearchQuery("+1 561 303 7754").digits === "15613037754");
  const a = parseSearchQuery("105 Bandol");
  ck("'105 Bandol' → texto ['105','bandol']", a.mode === "text" && a.words.join("|") === "105|bandol", JSON.stringify(a));
  const b = parseSearchQuery("3285 Nw 211th St");
  ck("'3285 Nw 211th St' → texto (letras ≥ 3), não telefone", b.mode === "text" && b.words.includes("3285"), JSON.stringify(b));
  ck("'José' → texto 'jose' (sem acento)", parseSearchQuery("José").words[0] === "jose");
  ck("'j' → nada", parseSearchQuery("j").mode === "none");
  ck("'   ' → nada", parseSearchQuery("   ").mode === "none");
  ck("'ab,cd.(ef)' → , e . separam; ( ) somem", parseSearchQuery("ab,cd.(ef)").words.join("|") === "ab|cd|ef", JSON.stringify(parseSearchQuery("ab,cd.(ef)")));
  ck("'954' (3 dígitos) → texto ['954']", parseSearchQuery("954").mode === "text" && parseSearchQuery("954").words[0] === "954");
}

console.log("\n━━ 2. digitsPattern ━━");
{
  const re = new RegExp(digitsPattern("9541234567"));
  ck("(954) 123-4567 bate", re.test("my number is (954) 123-4567 thanks"));
  ck("954.123.4567 bate", re.test("954.123.4567"));
  ck("9541234567 bate", re.test("call 9541234567"));
  ck("954 1234 567 bate (só a ordem importa)", re.test("954 1234 567"));
  ck("9541234568 NÃO bate", !re.test("9541234568"));
  ck("dígitos fora de ordem NÃO batem", !re.test("4567 123 954"));
  ck("padrão não tem , ( ) (seguro no PostgREST)", !/[,()]/.test(digitsPattern("12345")));
}

console.log("\n━━ 3. matchConversationLocally ━━");
{
  const wa = { igsid: "wa_15613037754", name: "Taneeka", username: null, last_message: "ok" };
  const m1 = matchConversationLocally(wa, parseSearchQuery("303 7754"));
  ck("número do WhatsApp no igsid → telefone", m1?.kind === "telefone" && m1.text === "+1 (561) 303-7754", JSON.stringify(m1));
  ck("4 últimos dígitos acham o WhatsApp", matchConversationLocally(wa, parseSearchQuery("7754"))?.kind === "telefone");
  ck("outro número não acha", matchConversationLocally(wa, parseSearchQuery("9999")) === null);

  const ig = { igsid: "1234567890", name: "José Silva", username: "jose.silva", last_message: "hi" };
  ck("'jose' acha 'José Silva' (sem acento)", matchConversationLocally(ig, parseSearchQuery("jose"))?.kind === "nome");
  ck("'silva jose' (ordem trocada) acha", matchConversationLocally(ig, parseSearchQuery("silva jose"))?.kind === "nome");
  ck("'jose.silva' (@) acha", matchConversationLocally(ig, parseSearchQuery("jose.silva"))?.kind === "nome");
  ck("'maria' não acha", matchConversationLocally(ig, parseSearchQuery("maria")) === null);

  const glued = { igsid: "fb_1", name: null, username: null, last_message: "105bandol street port st lucie" };
  const m2 = matchConversationLocally(glued, parseSearchQuery("105 bandol"));
  ck("'105 bandol' acha '105bandol street' → endereço", m2?.kind === "endereco", JSON.stringify(m2));

  const zip = { igsid: "fb_2", name: null, username: null, last_message: "3285 Nw 211th St, Miami Gardens, 33056" };
  const m3 = matchConversationLocally(zip, parseSearchQuery("33056"));
  ck("ZIP na última mensagem → endereço", m3?.kind === "endereco", JSON.stringify(m3));
  ck("'211th' acha a rua", matchConversationLocally(zip, parseSearchQuery("211th"))?.kind === "endereco");

  const sys = { igsid: "fb_3", name: null, username: null, last_message: "1pm\n\n[SYSTEM: client near 33056, phone 9541234567]" };
  ck("texto só no [SYSTEM:] NÃO conta (ZIP)", matchConversationLocally(sys, parseSearchQuery("33056")) === null);
  ck("texto só no [SYSTEM:] NÃO conta (telefone)", matchConversationLocally(sys, parseSearchQuery("954 123 4567")) === null);

  const plain = { igsid: "fb_4", name: null, username: null, last_message: "I want vinyl for the whole house" };
  ck("trecho de mensagem → mensagem", matchConversationLocally(plain, parseSearchQuery("whole house"))?.kind === "mensagem");

  // Rótulo na busca por dígitos: só é "telefone" se os dígitos estão DENTRO de um telefone.
  const addrPhone = "7182 SW 20th Pl, Davie, FL 33317. Tel 954-555-0199";
  ck("ZIP numa mensagem que também tem telefone → endereço", classifyDigitsMatch(addrPhone, "33317") === "endereco");
  ck("4 últimos do telefone na mesma mensagem → telefone", classifyDigitsMatch(addrPhone, "0199") === "telefone");
  ck("dígitos soltos sem rua nem ZIP → mensagem", classifyDigitsMatch("I have 1200 sq ft", "1200") === "mensagem");
  const addrPhoneRow = { igsid: "fb_5", name: null, username: null, last_message: addrPhone };
  ck("linha local usa o mesmo rótulo (ZIP → endereço)", matchConversationLocally(addrPhoneRow, parseSearchQuery("33317"))?.kind === "endereco");
}

console.log("\n━━ 4. highlightSegments / snippetAround ━━");
{
  const q = parseSearchQuery("954 123 4567");
  const segs = highlightSegments("call (954) 123-4567 now", q);
  ck("destaca o telefone inteiro com formatação", segs.some((s) => s.hit && s.text === "954) 123-4567"), JSON.stringify(segs));
  ck("texto em volta sem destaque", segs.filter((s) => !s.hit).map((s) => s.text).join("|") === "call (| now", JSON.stringify(segs));

  const qt = parseSearchQuery("bandol");
  const segs2 = highlightSegments("105Bandol Street", qt);
  ck("destaque sem caixa: 'Bandol' em '105Bandol'", segs2.some((s) => s.hit && s.text === "Bandol"), JSON.stringify(segs2));

  const qa = parseSearchQuery("jose");
  const segs3 = highlightSegments("Olá, José!", qa);
  ck("destaque sem acento mantém o original 'José'", segs3.some((s) => s.hit && s.text === "José"), JSON.stringify(segs3));

  const long = "a".repeat(200) + " my address is 105 Bandol St " + "b".repeat(200);
  const snip = snippetAround(long, parseSearchQuery("bandol"));
  ck("recorte curto em volta do trecho, com reticências", snip.startsWith("…") && snip.endsWith("…") && snip.includes("105 Bandol St") && snip.length < 140, snip);
  ck("texto curto volta inteiro", snippetAround("105 Bandol St", parseSearchQuery("bandol")) === "105 Bandol St");
  // Linha da lista (radius 20): trecho perto do FIM de um texto médio → corta o começo para o destaque aparecer.
  const mid = "11347 SW 112 Circle Lane South Miami, Fl 33176";
  const snipMid = snippetAround(mid, parseSearchQuery("33176"), 20);
  ck("trecho no fim de texto médio → começa com … e mostra o ZIP", snipMid.startsWith("…") && snipMid.endsWith("33176") && snipMid.length <= 30, snipMid);
  const snipStart = snippetAround(mid, parseSearchQuery("11347"), 20);
  ck("trecho no começo → sem … na frente, janela de ~2×radius", snipStart.startsWith("11347") && snipStart.endsWith("…") && snipStart.length <= 48, snipStart);
  ck("scoreOf: match mais forte + 1 por extra (visita+endereço > visita+visita)",
    scoreOf([{ kind: "visita", text: "a" }, { kind: "endereco", text: "b" }]) === 46 && scoreOf([{ kind: "visita", text: "a" }, { kind: "visita", text: "c" }]) === 46 && scoreOf([{ kind: "telefone", text: "x" }]) === 50 && scoreOf([]) === 0);
  ck("recorte limpa [SYSTEM:]", !snippetAround("hi [SYSTEM: x] bandol", parseSearchQuery("bandol")).includes("SYSTEM"));
}

console.log("\n━━ 5. helpers ━━");
{
  ck("orGroupAllWords 1 palavra", orGroupAllWords(["name", "username"], ["jo"]) === "name.ilike.*jo*,username.ilike.*jo*", orGroupAllWords(["name", "username"], ["jo"]));
  ck("orGroupAllWords 2 palavras → and(…)", orGroupAllWords(["address"], ["105", "bandol"]) === "and(address.ilike.*105*,address.ilike.*bandol*)", orGroupAllWords(["address"], ["105", "bandol"]));
  ck("igsidFromBookingEmail wa_", igsidFromBookingEmail("ia-wa_15613037754@instagram.ozzifloors.com") === "wa_15613037754");
  ck("igsidFromBookingEmail IG numérico", igsidFromBookingEmail("ia-1234567890@instagram.ozzifloors.com") === "1234567890");
  ck("igsidFromBookingEmail e-mail de gente → null", igsidFromBookingEmail("maria@gmail.com") === null);
  ck("formatPhone EUA", formatPhone("15613037754") === "+1 (561) 303-7754", formatPhone("15613037754"));
  ck("formatPhone 10 dígitos", formatPhone("5613037754") === "(561) 303-7754", formatPhone("5613037754"));
  ck("formatPhone Brasil", formatPhone("5511999999999") === "+55 11 99999-9999", formatPhone("5511999999999"));
  ck("formatPhone vazio", formatPhone(null) === "");
  ck("waPhoneDigits", waPhoneDigits("wa_15613037754") === "15613037754" && waPhoneDigits("fb_1") === null);
  ck("getChannel", getChannel("wa_1") === "whatsapp" && getChannel("fb_1") === "facebook" && getChannel("123") === "instagram");
  const merged = mergeMatches(
    [{ kind: "mensagem", text: "x" }, { kind: "telefone", text: "954" }],
    [{ kind: "telefone", text: "954" }, { kind: "endereco", text: "105 Bandol" }, { kind: "mensagem", text: "y" }],
  );
  ck("mergeMatches sem repetir, mais forte primeiro, máx 3", merged.length === 3 && merged[0].kind === "telefone" && merged[1].kind === "endereco", JSON.stringify(merged));
  ck("looksLikeAddress rua", looksLikeAddress("105 Bandol St"));
  ck("looksLikeAddress ZIP", looksLikeAddress("Miami 33176"));
  ck("looksLikeAddress texto comum → false", !looksLikeAddress("I want vinyl for the whole house"));
  ck("sanitizeWord tira , . ( ) % _ * \\ :", sanitizeWord("a,b.c(d)e%f_g*h\\i:j") === "abcdefghij", sanitizeWord("a,b.c(d)e%f_g*h\\i:j"));
  ck("foldAccents mantém comprimento", foldAccents("José Ângelo 🙂").length === "José Ângelo 🙂".length && foldAccents("José").startsWith("Jose"));
  ck("cleanClientText troca planta/áudio e tira SYSTEM", cleanClientText("[Floor plan analysis: 3x10m] ok [SYSTEM: x] [Voice: hi]") === "[planta] ok [áudio]", cleanClientText("[Floor plan analysis: 3x10m] ok [SYSTEM: x] [Voice: hi]"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
