// 02/11/2026 — resgate dos clientes que ficaram sem resposta durante a queda do
// Instagram Direct (31/10 21h UTC → 02/11 02h UTC) e do lead do Messenger cujo
// replay automático não gerou resposta. Mesmo mecanismo do recoverLostReplies
// (delivery.ts): re-POSTa a última bolha gravada do cliente no webhook de
// PRODUÇÃO com o header x-ozzi-replay; o pipeline normal responde com o token
// válido da Vercel. Só conversas cuja última mensagem ainda está dentro da
// janela de 24h da Meta (fora dela a API recusa com erro 10).
//
// Uso:  DRY=1 node scripts/tmp-rescue-0211.mjs <igsid...>   (só lista)
//             node scripts/tmp-rescue-0211.mjs <igsid...>   (reprocessa e responde)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {}; for (const l of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BASE = "https://instagram-dm-agent-chi.vercel.app";
const IG_BUSINESS_ID = "1940528653163182";
const FB_PAGE_ID = env.FACEBOOK_PAGE_ID || "";
const SECRET = env.ADMIN_SECRET;
const ids = process.argv.slice(2);
const dry = process.env.DRY === "1";
for (const igsid of ids) {
  const { data: c } = await app.from("instagram_conversations").select("id,igsid,mode,name,username").eq("igsid", igsid).maybeSingle();
  if (!c) { console.log(`?? ${igsid} não encontrada`); continue; }
  const { data: msgs } = await app.from("instagram_messages").select("id,role,content,created_at,instagram_msg_id").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1);
  const newest = msgs?.[0];
  const ageH = (Date.now() - Date.parse(newest?.created_at ?? 0)) / 3600000;
  if (!newest || newest.role !== "user") { console.log(`-- ${igsid}: última msg não é do cliente, pulando`); continue; }
  if (c.mode === "human") { console.log(`-- ${igsid}: mode=human, pulando`); continue; }
  if (ageH > 24) { console.log(`-- ${igsid} (${c.name || c.username}): ${ageH.toFixed(1)}h, fora da janela de 24h, pulando`); continue; }
  if (!newest.instagram_msg_id) { console.log(`-- ${igsid}: sem mid, pulando`); continue; }
  const fb = igsid.startsWith("fb_");
  const clientId = fb ? igsid.slice(3) : igsid;
  const ownId = fb ? FB_PAGE_ID : IG_BUSINESS_ID;
  const ts = Date.parse(newest.created_at);
  const text = newest.content.split(/\n\n?\[SYSTEM:/)[0];
  const payload = { object: fb ? "page" : "instagram", entry: [{ id: ownId, time: ts, messaging: [{ sender: { id: clientId }, recipient: { id: ownId }, timestamp: ts, message: { mid: newest.instagram_msg_id, text } }] }] };
  console.log(`${dry ? "DRY " : ""}replay ${fb ? "FB" : "IG"} ${igsid} (${c.name || c.username || ""}) ${ageH.toFixed(1)}h «${text.slice(0, 60)}»`);
  if (dry) continue;
  const res = await fetch(BASE + (fb ? "/api/fb-webhook" : "/api/webhook"), { method: "POST", headers: { "Content-Type": "application/json", "x-ozzi-replay": SECRET }, body: JSON.stringify(payload) });
  console.log(`   → HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 1500));
}
