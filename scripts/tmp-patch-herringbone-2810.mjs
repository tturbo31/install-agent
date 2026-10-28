// 28/10/2026 — Herringbone: o dono corrigiu os preços. $7.50/sqft é a PROMO e já
// inclui o vinil de luxo em herringbone (acabamento madeira), a instalação e o
// quarter round; $4/sqft é SÓ a mão de obra. Desde 03/10 o prompt/backstop/Dreaming
// tratavam $7.50 como "material em cima dos $4" ($11.50) e em 28/10 o bot disse
// "Herringbone is $7.50 per sqft for the material and $4 per sqft for the labor"
// (fb_28151851617823353). Patch exato, CRLF preservado, aborta se algo não bater.
import { applyPatches } from "./tmp-patch-lib.mjs";

const SP = "src/lib/system-prompt.ts";
const AI = "src/lib/ai.ts";
const DR = "src/lib/dreaming.ts";
const LC = "src/evals/language-consistency-verify.ts";
const TR = "src/evals/tile-removal-verify.ts";

applyPatches([
  // ── system-prompt.ts ──────────────────────────────────────────────────────
  {
    file: SP,
    find: String.raw`- HERRINGBONE (any herringbone floor, even vinyl): NOT the $5 promo. $4 per sqft for the installation labor, and our herringbone material is $7.50 per sqft on top. Give both. See HERRINGBONE PATTERN.`,
    replace: String.raw`- HERRINGBONE (any herringbone floor, even vinyl): NOT the $5 promo. Our herringbone promo is $7.50 per sqft and that already includes our luxury vinyl herringbone floor (wood finish), the installation labor and the quarter round; labor only (the client supplies the material) is $4 per sqft. Give both, and never call the $7.50 a material price. See HERRINGBONE PATTERN.`,
  },
  {
    file: SP,
    find: String.raw`Herringbone install (labor only): $4/sqft. Herringbone material (our luxury vinyl herringbone): $7.50/sqft on top of the labor. Herringbone is NEVER the $5 promo (see HERRINGBONE PATTERN)`,
    replace: String.raw`Herringbone promo (our luxury vinyl herringbone floor + installation + quarter round, all included): $7.50/sqft. Herringbone install only (client supplies the material): $4/sqft. Herringbone is NEVER the $5 promo and $7.50 is NEVER a material-only price (see HERRINGBONE PATTERN)`,
  },
  {
    file: SP,
    find: String.raw`## HERRINGBONE PATTERN (owner rule 2026-10-03)`,
    replace: String.raw`## HERRINGBONE PATTERN (owner rule 2026-10-03, prices corrected by the owner 2026-10-28)`,
  },
  {
    file: SP,
    find: String.raw`- INSTALLATION LABOR: $4 per square foot to install a herringbone floor, labor only.
- MATERIAL: our herringbone material is luxury vinyl at $7.50 per square foot, charged on top of the labor. With our material that is $11.50 per square foot in total ($4 labor plus $7.50 material).
Every time you price herringbone, give BOTH figures and say what each one covers, in one short sentence. Never say the herringbone price "includes the floor", never quote $5 (or the $2 install rate, or the $3.20 hardwood rate) for a herringbone floor, and never bring the quarter round into it (that belongs to the $5 promo).`,
    replace: String.raw`- HERRINGBONE PROMO (with our floor): $7.50 per square foot, and that price ALREADY INCLUDES our luxury vinyl herringbone floor in a wood finish, the installation labor and the quarter round. Nothing is charged on top of it.
- LABOR ONLY (the client supplies the herringbone material): $4 per square foot for the installation.
Every time you price herringbone, give BOTH figures and say what each one covers, in one short sentence: $7.50 per sqft with our floor, the installation and the quarter round included, or $4 per sqft labor only if they supply the material. The $7.50 is NEVER a material price and NEVER "on top of" the labor: never say "$7.50 for the material", "our herringbone material is $7.50", "$4 labor plus $7.50 material" or "$11.50", and never say the material is charged separately. Never quote $5 (or the $2 install rate, or the $3.20 hardwood rate) for a herringbone floor.`,
  },
  {
    file: SP,
    find: String.raw`Tile or porcelain laid in a herringbone pattern stays on the TILE rules (labor only at $4.50 per sqft, we don't sell tile material).
The sqft rules do not change: 500 sqft or more, no total by DM, propose the free visit; 400 to 499 sqft, one clean total (450 sqft labor only = 450 x 4 = about $1,800; 450 sqft with our material = 450 x 11.50 = about $5,175); under 400 sqft, no price and no visit, Ozzi direct at (561) 674-8334.
Example: "Herringbone has its own price, it's $4 per sqft for the installation labor, and our herringbone material is $7.50 per sqft. Is it one area or the whole house?"
Spanish: "El herringbone tiene su propio precio, son $4 por sqft de mano de obra de instalación, y nuestro material herringbone es $7.50 por sqft." Portuguese: "O herringbone tem preço próprio, são $4 por sqft da mão de obra de instalação, e o nosso material herringbone é $7.50 por sqft."`,
    replace: String.raw`Our herringbone ads say "1000 sq.ft. for $4,000 without materials / $7,600 with materials": when the client quotes those figures they are ours, the $4,000 is the herringbone installation only and the $7,600 is the herringbone promo with our floor, the installation and the quarter round included. Never recalculate the ad's figures, quote the per-square-foot prices above.
Tile or porcelain laid in a herringbone pattern stays on the TILE rules (labor only at $4.50 per sqft, we don't sell tile material).
The sqft rules do not change: 500 sqft or more, no total by DM, propose the free visit; 400 to 499 sqft, one clean total (450 sqft with our floor = 450 x 7.50 = about $3,375; 450 sqft labor only = 450 x 4 = about $1,800); under 400 sqft, no price and no visit, Ozzi direct at (561) 674-8334.
Example: "Herringbone has its own promo: $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included, or $4 per sqft labor only if you supply the material. Is it one area or the whole house?"
Spanish: "El herringbone tiene su propia promo: $7.50 por sqft con nuestro piso de vinyl de lujo en herringbone, la instalación y el quarter round incluidos, o $4 por sqft solo mano de obra si tú pones el material." Portuguese: "O herringbone tem promoção própria: $7.50 por sqft com o nosso piso vinílico de luxo em herringbone, a instalação e o quarter round incluídos, ou $4 por sqft só a mão de obra se você fornecer o material."`,
  },

  // ── ai.ts: notas e regras ─────────────────────────────────────────────────
  {
    file: AI,
    find: String.raw`(a HERRINGBONE floor is the exception, it is never the $5 promo: $4 per sqft labor plus $7.50 per sqft for our herringbone material, see HERRINGBONE PATTERN)`,
    replace: String.raw`(a HERRINGBONE floor is the exception, it is never the $5 promo: its own promo is $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included, or $4 per sqft labor only when they supply the material, see HERRINGBONE PATTERN)`,
  },
  {
    file: AI,
    find: String.raw`herringbone sqft x $4 labor only or sqft x $11.50 with our herringbone material`,
    replace: String.raw`herringbone sqft x $7.50 with our herringbone floor, installation and quarter round included, or sqft x $4 labor only`,
  },
  {
    file: AI,
    find: String.raw`A herringbone floor has its own price instead ($4 per sqft labor, $7.50 per sqft for our herringbone material).`,
    replace: String.raw`A herringbone floor has its own promo instead ($7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included; $4 per sqft labor only when the client supplies the material; never "$7.50 for the material").`,
  },
  {
    file: AI,
    find: String.raw`the $5,100 line is our $5 per square foot promo with the luxury vinyl floor, the installation and the quarter round included, then continue the normal flow with the size rules unchanged.`,
    replace: String.raw`the $5,100 line is our $5 per square foot promo with the luxury vinyl floor, the installation and the quarter round included, then continue the normal flow with the size rules unchanged. Our HERRINGBONE ads show "$4,000 for 1000 sq ft without materials" and "$7,600 for 1000 sq ft with materials": those are ours too, the $4,000 is the herringbone installation only and the $7,600 line is our herringbone promo with the luxury vinyl herringbone floor, the installation and the quarter round included (per square foot: $7.50 with everything included, $4 labor only, see HERRINGBONE PATTERN), never recalculate the ad's figures.`,
  },

  // ── ai.ts: backstop ───────────────────────────────────────────────────────
  {
    file: AI,
    find: String.raw`// Regra do dono: herringbone NUNCA é a promo de $5, é $4/sqft só a mão de obra
// e o material herringbone (o nosso vinil) $7.50/sqft. O prompt ganhou a seção
// HERRINGBONE PATTERN; esta rede segura o que escapar: com o cliente falando de
// herringbone (tile/porcelanato em herringbone segue a regra de tile) e a reply
// cotando a taxa de $5, $2 ou $3.20 por sqft sem dar os $4 + $7.50, a frase do
// preço vira o preço do herringbone no idioma do cliente e o resto fica igual.
// HERRINGBONE_BACKSTOP=off desliga.`,
    replace: String.raw`// Regra do dono (03/10, preços corrigidos pelo dono em 28/10/2026): herringbone
// NUNCA é a promo de $5. A promo do herringbone é $7.50/sqft e JÁ INCLUI o nosso
// vinil de luxo em herringbone (acabamento madeira), a instalação e o quarter
// round; $4/sqft é SÓ a mão de obra (cliente fornece o material). De 03/10 a
// 28/10 isto aqui lia "$4 mão de obra + $7.50 material" ($11.50) e em 28/10 o
// bot disse "Herringbone is $7.50 per sqft for the material and $4 per sqft for
// the labor" (fb_28151851617823353, 850 sqft); o dono corrigiu à mão. O prompt
// tem a seção HERRINGBONE PATTERN; esta rede segura o que escapar: com o cliente
// falando de herringbone (tile/porcelanato em herringbone segue a regra de tile)
// e a reply cotando $5, $2 ou $3.20 por sqft sem dar os $7.50 + $4, OU vendendo
// os $7.50 como material ("for the material", "material is $7.50", "plus $7.50",
// "on top of the labor", "$11.50"), a frase do preço vira o preço do herringbone
// no idioma do cliente e o resto fica igual. HERRINGBONE_BACKSTOP=off desliga.`,
  },
  {
    file: AI,
    find: String.raw`export function replyMispricesHerringbone(text: string): boolean {
  const prose = normalizeSmartPunct(stripProtectedTags(text));
  if (!HERRINGBONE_WRONG_RATE.test(prose)) return false;`,
    replace: String.raw`// The framing the owner corrected on 28/10/2026: the $7.50 sold as the MATERIAL
// price on top of the $4 labor ("$7.50 per sqft for the material", "our
// herringbone material is $7.50", "$4 labor plus $7.50 material", "$7.50 on top
// of the labor", "$11.50 in total"). "$7.50 with the material included" and
// "includes the material" are the right wording and are left alone.
const HERRINGBONE_MATERIAL_FRAMING = /\$\s?11\.50?(?!\d)|\$\s?7\.50?(?!\d)[^.!?\n]{0,40}?(?:(?<![a-zà-ÿ])(?:for|of|de|do|del|da|por|para|is|es|é)(?![a-zà-ÿ])\s+(?:the\s+|el\s+|o\s+|a\s+|our\s+|nuestro\s+|nosso\s+|o\s+nosso\s+)?(?:herringbone\s+)?materia|(?<![a-zà-ÿ])on\s+top(?![a-zà-ÿ])|(?<![a-zà-ÿ])(?:plus|extra|adicional\w*|mais|m[aá]s)\s+(?:the\s+|la\s+|a\s+|el\s+|o\s+)?(?:\$\s?4(?![\d,]|\.\d)|labor|install\w*|mano\s+de\s+obra|m[aã]o\s+de\s+obra|instala\w*))|materia\w*(?:\s+(?:herringbone|de\s+herringbone|en\s+espiga))?\s+(?:is|es|é|at|por|de|runs|costs?|cuesta|custa|sale|fica)\s+(?:about\s+|around\s+|unos\s+|uns\s+)?\$\s?7\.50?(?!\d)|(?<![a-zà-ÿ])(?:plus|mais|m[aá]s)\s+\$\s?7\.50?(?!\d)|\+\s*\$\s?7\.50?(?!\d)/i;
export function replyMispricesHerringbone(text: string): boolean {
  const prose = normalizeSmartPunct(stripProtectedTags(text));
  if (HERRINGBONE_MATERIAL_FRAMING.test(prose)) return true;
  if (!HERRINGBONE_WRONG_RATE.test(prose)) return false;`,
  },
  {
    file: AI,
    find: String.raw`const HERRINGBONE_PRICE: Record<"en" | "es" | "pt", { herringbone: string; mixed: string }> = {
  en: {
    herringbone: "Herringbone has its own price, it's $4 per sqft for the installation labor, and our herringbone material is $7.50 per sqft.",
    mixed: "The herringbone has its own price, $4 per sqft for the installation labor plus $7.50 per sqft for our herringbone material, and the regular planks are our vinyl promo at $5 per sqft with the floor, installation and quarter round included.",
  },
  es: {
    herringbone: "El herringbone tiene su propio precio, son $4 por sqft de mano de obra de instalación, y nuestro material herringbone es $7.50 por sqft.",
    mixed: "El herringbone tiene su propio precio, $4 por sqft de mano de obra más $7.50 por sqft de nuestro material herringbone, y las tablas normales van con nuestra promo de vinyl a $5 por sqft con el piso, la instalación y el quarter round incluidos.",
  },
  pt: {
    herringbone: "O herringbone tem preço próprio, são $4 por sqft da mão de obra de instalação, e o nosso material herringbone é $7.50 por sqft.",
    mixed: "O herringbone tem preço próprio, $4 por sqft da mão de obra mais $7.50 por sqft do nosso material herringbone, e as réguas normais ficam na nossa promo de vinil a $5 por sqft com o piso, a instalação e o quarter round incluídos.",
  },
};`,
    replace: String.raw`const HERRINGBONE_PRICE: Record<"en" | "es" | "pt", { herringbone: string; mixed: string }> = {
  en: {
    herringbone: "Herringbone has its own promo: $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included, or $4 per sqft labor only if you supply the material.",
    mixed: "The herringbone has its own promo, $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included (or $4 per sqft labor only if you supply the material), and the regular planks are our vinyl promo at $5 per sqft with the floor, installation and quarter round included.",
  },
  es: {
    herringbone: "El herringbone tiene su propia promo: $7.50 por sqft con nuestro piso de vinyl de lujo en herringbone, la instalación y el quarter round incluidos, o $4 por sqft solo mano de obra si tú pones el material.",
    mixed: "El herringbone tiene su propia promo, $7.50 por sqft con nuestro piso de vinyl de lujo en herringbone, la instalación y el quarter round incluidos (o $4 por sqft solo mano de obra si tú pones el material), y las tablas normales van con nuestra promo de vinyl a $5 por sqft con el piso, la instalación y el quarter round incluidos.",
  },
  pt: {
    herringbone: "O herringbone tem promoção própria: $7.50 por sqft com o nosso piso vinílico de luxo em herringbone, a instalação e o quarter round incluídos, ou $4 por sqft só a mão de obra se você fornecer o material.",
    mixed: "O herringbone tem promoção própria, $7.50 por sqft com o nosso piso vinílico de luxo em herringbone, a instalação e o quarter round incluídos (ou $4 por sqft só a mão de obra se você fornecer o material), e as réguas normais ficam na nossa promo de vinil a $5 por sqft com o piso, a instalação e o quarter round incluídos.",
  },
};`,
  },
  {
    file: AI,
    find: String.raw`      if (!HERRINGBONE_WRONG_RATE.test(s)) { out.push(s); continue; }`,
    replace: String.raw`      if (!HERRINGBONE_WRONG_RATE.test(s) && !HERRINGBONE_MATERIAL_FRAMING.test(s)) { out.push(s); continue; }`,
  },
  {
    file: AI,
    find: String.raw`      const keep = ask && !HERRINGBONE_WRONG_RATE.test(ask[1]) ? " " + ask[1].charAt(0).toUpperCase() + ask[1].slice(1) : "";`,
    replace: String.raw`      const keep = ask && !HERRINGBONE_WRONG_RATE.test(ask[1]) && !HERRINGBONE_MATERIAL_FRAMING.test(ask[1]) ? " " + ask[1].charAt(0).toUpperCase() + ask[1].slice(1) : "";`,
  },
  {
    file: AI,
    find: String.raw`    // Herringbone (dono, 03/10/2026): nunca a promo de $5; $4/sqft mão de obra +
    // $7.50/sqft o nosso material herringbone.`,
    replace: String.raw`    // Herringbone (dono, 03/10 e 28/10/2026): nunca a promo de $5; $7.50/sqft com o
    // nosso vinil herringbone + instalação + quarter round, ou $4/sqft só mão de obra.`,
  },
  {
    file: AI,
    find: "the reply quoted the $5/$2/$3.20 rate for a herringbone floor, replaced with $4 labor + $7.50 material",
    replace: "the reply quoted the $5/$2/$3.20 rate or sold the $7.50 as material for a herringbone floor, replaced with $7.50 all included / $4 labor only",
  },

  // ── dreaming.ts ───────────────────────────────────────────────────────────
  {
    file: DR,
    find: String.raw`Herringbone: $4/sqft labor + $7.50/sqft our herringbone material (never the $5 promo).`,
    replace: String.raw`Herringbone: $7.50/sqft with our luxury vinyl herringbone floor, installation and quarter round included, or $4/sqft labor only (never the $5 promo, and $7.50 is never a material-only price).`,
  },
  {
    file: DR,
    find: String.raw`16. HERRINGBONE IS NEVER THE $5 PROMO (owner rule 2026-10-03): a herringbone floor (even vinyl, even the one from our own posts) is $4 per sqft for the installation labor plus $7.50 per sqft for our herringbone material, both stated with what each covers. NEVER write a learning or a suggested reply that quotes $5 per sqft, "floor, labor and quarter round included", the $2 install rate or the $3.20 hardwood rate for herringbone. Conversations before 2026-10-03 show the agent quoting $5 for herringbone; that is the error that was fixed, not a pattern.`,
    replace: String.raw`16. HERRINGBONE IS NEVER THE $5 PROMO (owner rule 2026-10-03, prices corrected by the owner 2026-10-28): a herringbone floor (even vinyl, even the one from our own posts) has its own promo of $7.50 per sqft that ALREADY INCLUDES our luxury vinyl herringbone floor, the installation and the quarter round, or $4 per sqft labor only when the client supplies the material, both stated with what each covers. NEVER write a learning or a suggested reply that quotes $5 per sqft, the $2 install rate or the $3.20 hardwood rate for herringbone, and NEVER one that sells the $7.50 as a material price ("$7.50 for the material", "$4 labor plus $7.50 material", "$11.50"). Conversations before 2026-10-28 show the agent quoting $5, or "$4 labor + $7.50 material", for herringbone; those are the errors that were fixed, not a pattern.`,
  },

  // ── fixtures de outros evals ──────────────────────────────────────────────
  {
    file: LC,
    find: String.raw`"Herringbone has its own price, it's $4 per sqft for the installation labor, and our herringbone material is $7.50 per sqft. Cuántos pies cuadrados tienes aproximadamente?",`,
    replace: String.raw`"Herringbone has its own promo: $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included, or $4 per sqft labor only if you supply the material. Cuántos pies cuadrados tienes aproximadamente?",`,
  },
  {
    file: TR,
    find: String.raw`ck("herringbone $11.50 untouched", fixTileRemovalRate("With our material that is $11.50 per sqft, removal not included.") === "With our material that is $11.50 per sqft, removal not included.");`,
    replace: String.raw`ck("herringbone $7.50 untouched", fixTileRemovalRate("Herringbone is $7.50 per sqft with our floor, the installation and the quarter round included, removal not included.") === "Herringbone is $7.50 per sqft with our floor, the installation and the quarter round included, removal not included.");`,
  },
]);
