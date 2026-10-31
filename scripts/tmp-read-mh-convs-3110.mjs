// READ-ONLY (2026-10-31): the conversations that got the old "we don't do
// mobile homes" decline: who they are and what they said, so the owner can
// call back the real mobile home leads.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const ids = ["e2d827a9-45e6-4332-9d70-fbc0ce78359d", "9c8d4654-3caa-4797-9b6e-9102a19f9971", "725dfeb9-0258-499d-b8bc-264d38ba99cf", "9e7117ca-e23f-433a-b685-66de0a600b51"];
for (const id of ids) {
  const { data: c } = await sb.from("instagram_conversations").select("*").eq("id", id).maybeSingle();
  const pick = c ? Object.fromEntries(Object.entries(c).filter(([k]) => /igsid|name|user|phone|mode|platform|channel|updated/i.test(k))) : null;
  console.log("\n=== " + id + " " + JSON.stringify(pick));
  const { data: msgs } = await sb.from("instagram_messages").select("role, content, created_at").eq("conversation_id", id).order("created_at", { ascending: true }).limit(60);
  for (const m of (msgs || []).slice(-14)) console.log("  " + m.created_at.slice(5, 16) + " " + m.role.padEnd(9) + " " + (m.content || "").replace(/\s+/g, " ").slice(0, 170));
}
