// READ-ONLY: full history of conversation c8b93958-002b-4659-85ef-be22ebedda70 (herringbone misprice, 28/10/2026)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const id = "c8b93958-002b-4659-85ef-be22ebedda70";
const { data: conv } = await sb.from("instagram_conversations").select("*").eq("id", id).single();
console.log("conv:", JSON.stringify(conv));
const { data: msgs } = await sb.from("instagram_messages").select("role,content,created_at").eq("conversation_id", id).order("created_at", { ascending: true }).limit(60);
for (const m of msgs ?? []) console.log(`[${m.created_at}] ${m.role}: ${String(m.content).replace(/\s+/g, " ").slice(0, 700)}`);
