// Tile removal = $2 per sqft (owner rule 2026-10-03; it was $1.50).
// History: 14 conversations in 30 days heard $1.50, among them Jennifer (IG
// 02/10): "Yes, tile demo is $1.50 per sqft on top of the installation labor".
// [1] static: no $1.50 left in the prompts. [2] deterministic backstop.
// [3] live, including a conversation that already carries the old $1.50.
// Run: npx tsx src/evals/tile-removal-verify.ts   (LIVE=0 skips [3])
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, fixTileRemovalRate, type ChatMessage } from "../lib/ai";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (content: string): ChatMessage => ({ role: "user", content });
const A = (content: string): ChatMessage => ({ role: "assistant", content });
const TWO = /\$\s?2(?:\.00)?(?![\d,]|\.\d)/;
const OLD = /1\.50|1,50/;

const JEN: ChatMessage[] = [
  U("What is the installation process?"),
  A("Hi, we move the furniture, install the floor and leave everything clean, usually in 2 to 3 days. Are you thinking tile, vinyl, or hardwood?"),
  U("Do you remove old flooring as well?"),
  U("Thinking tile"),
];

async function main() {
  console.log("\n[1] Static");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("prompt: Tile removal (demo) $2/sqft", /Tile removal \(demo\): \$2\/sqft/.test(sp));
  ck("prompt PRICING: Tile removal $2/sqft", /Tile removal: \$2\/sqft/.test(sp));
  ck("prompt has no $1.50 anywhere", !/\$1\.50/.test(sp), (sp.match(/.{60}\$1\.50.{40}/) ?? [""])[0]);
  ck("FINAL REMINDERS: demo/removal is $2/sqft", /Tile demo\/removal is \$2\/sqft extra/.test(ai));
  ck("FINAL REMINDERS: no $1.50/sqft", !/demo\/removal is \$1\.50/.test(ai));
  const dream = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
  ck("Dreaming has no $1.50 removal", !/\$1\.50/.test(dream));

  console.log("\n[2] Backstop");
  const cases: Array<[string, string]> = [
    ["Yes, tile demo is $1.50 per sqft on top of the installation labor. How many square feet are you thinking?", "Yes, tile demo is $2 per sqft on top of the installation labor. How many square feet are you thinking?"],
    ["The $1.50 per sqft covers tearing out the existing tile, so yes, it applies to whatever area needs demo.", "The $2 per sqft covers tearing out the existing tile, so yes, it applies to whatever area needs demo."],
    ["El demo cuesta $1.50 por pie cuadrado adicional.", "El demo cuesta $2 por pie cuadrado adicional."],
    ["A remoção do piso é $1.50 por sqft.", "A remoção do piso é $2 por sqft."],
  ];
  for (const [i, o] of cases) { const r = fixTileRemovalRate(i); ck(`fix: "${i.slice(0, 50)}"`, r === o, r); }
  const mixed = fixTileRemovalRate("Tile installation is $4.50 per sqft, labor only, and demo of the old floor is an extra $1.50 per sqft.");
  ck("keeps $4.50, swaps only the removal rate", /\$4\.50/.test(mixed) && /extra \$2 per sqft/.test(mixed) && !OLD.test(mixed), mixed);
  ck("herringbone $11.50 untouched", fixTileRemovalRate("With our material that is $11.50 per sqft, removal not included.") === "With our material that is $11.50 per sqft, removal not included.");
  ck("no removal context → untouched", fixTileRemovalRate("Baseboards run about $1.50 a foot.") === "Baseboards run about $1.50 a foot.");
  const tag = fixTileRemovalRate("Tile removal is $1.50 per sqft. [NOTIFY_OWNER]");
  ck("tag survives", tag === "Tile removal is $2 per sqft. [NOTIFY_OWNER]", tag);

  if (process.env.LIVE === "0") return;

  console.log("\n[3] Live");
  const runs = Number(process.env.RUNS || 3);
  const ask = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
  const live = async (name: string, msgs: ChatMessage[], ok: (r: string) => boolean) => {
    for (let i = 0; i < runs; i++) {
      const r = await ask(msgs);
      ck(`${name} #${i + 1}`, ok(r), r);
      console.log("     → " + r.replace(/\s+/g, " "));
    }
  };
  await live("Jennifer replay ('remove old flooring?' + 'Thinking tile') → $2, never $1.50", JEN, (r) => TWO.test(r) && !OLD.test(r));
  await live("direct 'how much to remove existing tile?'", [
    U("Hi, I want to install tile"),
    A("Tile installation is $4.50 per sqft for the labor only, you supply the tile. Is it one area or the whole house?"),
    U("How much do you charge to remove the existing tile first?"),
  ], (r) => TWO.test(r) && !OLD.test(r));
  await live("ES '¿cuánto cobran por quitar el piso viejo?'", [
    U("Hola, quiero instalar tile"),
    A("La instalación de tile es $4.50 por sqft, solo mano de obra, tú pones el material. Es un área o toda la casa?"),
    U("cuanto cobran por quitar la cerámica vieja?"),
  ], (r) => TWO.test(r) && !OLD.test(r));
  await live("history already says $1.50 → the new answer says $2", [
    ...JEN,
    A("Yes, tile demo is $1.50 per sqft on top of the installation labor. How many square feet are you thinking?"),
    U("Of demo? how much again per sqft for the demo?"),
  ], (r) => TWO.test(r) && !OLD.test(r));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
