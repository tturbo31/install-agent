// SÓ LEITURA + IA: reescreve as nudges das conversas que receberam o formato
// "financing through our partner" e mostra o novo texto. Nada é enviado nem
// gravado. Run: npx tsx scripts/tmp-nudge-live-0211.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const { composeColdLeadNudge, pickLang, soundsLikeSpam } = await import("../src/lib/followup.ts");
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const desde = new Date(Date.now() - 5 * 864e5).toISOString();
const { data: nudges } = await app.from("instagram_messages").select("conversation_id, content, created_at")
  .eq("role", "assistant").gte("created_at", desde).ilike("content", "%FOLLOWUP_NUDGE%").ilike("content", "%financ%")
  .order("created_at", { ascending: false }).limit(Number(process.env.N || 12));
let ai = 0, fallback = 0, spam = 0;
for (const n of nudges ?? []) {
  const { data: hist } = await app.from("instagram_messages").select("role, content, created_at")
    .eq("conversation_id", n.conversation_id).lt("created_at", n.created_at).order("created_at", { ascending: true });
  const strip = (c) => (c || "").split(/\n\n?\[SYSTEM:/)[0];
  const lastBot = [...hist].reverse().find((m) => m.role === "assistant");
  const lang = pickLang(hist.filter((m) => m.role === "user").map((m) => strip(m.content)), lastBot?.content);
  const novo = await composeColdLeadNudge(hist, lang);
  if (novo) ai++; else fallback++;
  if (novo && soundsLikeSpam(novo)) spam++;
  console.log(`\nANTES: ${strip(n.content)}\nDEPOIS (${lang}): ${novo ?? "[template fixo]"}`);
}
console.log(`\nIA=${ai} template=${fallback} spam_que_passou=${spam}`);
