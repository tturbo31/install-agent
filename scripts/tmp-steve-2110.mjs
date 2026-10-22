// SÓ LEITURA (21/10/2026): conversa do Steve Leone (Messenger) + bookings com Crescendo/407-534-0007.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: byName, error: e1 } = await app.from("instagram_conversations").select("*").ilike("name", "%leone%");
if (e1) { console.error("ERR name:", e1.message); }
const { data: byMsg, error: e2 } = await app.from("instagram_messages").select("conversation_id,created_at").or("content.ilike.%34786%,content.ilike.%Crescendo%").order("created_at", { ascending: false }).limit(20);
if (e2) { console.error("ERR msg:", e2.message); }
const ids = [...new Set([...(byName ?? []).map(c => c.id), ...(byMsg ?? []).map(m => m.conversation_id)])];
console.log("conversas candidatas:", ids.length, "| por nome:", (byName ?? []).map(c => `${c.igsid} ${c.name}`).join(", "));
for (const id of ids) {
  const { data: conv } = await app.from("instagram_conversations").select("*").eq("id", id).single();
  const { data: msgs } = await app.from("instagram_messages").select("role,content,created_at,id").eq("conversation_id", id).order("created_at", { ascending: true });
  console.log("\n==================== CONVERSA", conv?.igsid, "|", conv?.name, "====================");
  const { id: _i, ...rest } = conv ?? {};
  console.log("CONV:", JSON.stringify(rest));
  for (const m of msgs ?? []) {
    const et = new Date(m.created_at).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    console.log(`[${et} ET] ${m.role.toUpperCase()}: ${String(m.content).replace(/\n/g, " ⏎ ")}`);
  }
}
// scheduler: bookings com esse endereço/telefone
const sched = createClient("https://wtyezgfzzetfrhoaqemt.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4", { auth: { persistSession: false } });
const { error: authErr } = await sched.auth.signInWithPassword({ email: "ia@ozzifloors.com", password: "OzziIA2026!" });
if (authErr) { console.error("AUTH sched:", authErr.message); process.exit(0); }
const { data: books, error: e3 } = await sched.from("bookings").select("*").or("address.ilike.%Crescendo%,address.ilike.%Windermere%,phone.ilike.%5340007%,address.ilike.%34786%");
if (e3) console.error("ERR bookings:", e3.message);
console.log("\n==================== BOOKINGS Windermere/Crescendo/407-534-0007 ====================");
console.log("total:", (books ?? []).length);
for (const b of books ?? []) console.log(JSON.stringify(b));
