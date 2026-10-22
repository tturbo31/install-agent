// Envio manual do aviso de vespera do Jeff Jacobs (job 23/10 sem vendedor), pedido do dono em 22/10/2026:
// a rotina das 13:00 UTC de hoje mandou o job para revisao manual sem chamar o agente.
// 1) dry: confere a mensagem exata (data de amanha, contato Ozzi (561) 674-8334, sem "sales rep");
// 2) so se o dry passar: envio real; 3) prova: historico + registro instalacao_log.
//   node scripts/tmp-enviar-jeff-2210.mjs            -> so o dry
//   node scripts/tmp-enviar-jeff-2210.mjs --enviar   -> dry + envio real
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
const env = {}; for (const l of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = "https://instagram-dm-agent-chi.vercel.app/api/confirmar-instalacao";
const ag = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TEL = "13059686096";
const body = { telefone_cliente: TEL, data_instalacao: "Friday, October 23", nome_cliente: "Jeff" };
const post = async (b) => { const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.INSTALACAO_TOKEN }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const dry = await post({ ...body, dry: true });
console.log("DRY:", dry.status, JSON.stringify({ bloqueado: dry.json?.bloqueado, duplicado: dry.json?.duplicado, data_check: dry.json?.data_check, verificacao: dry.json?.verificacao && { ok: dry.json.verificacao.ok, bloquear: dry.json.verificacao.bloquear, quotes: dry.json.verificacao.quotes, jobs: dry.json.verificacao.jobs } }));
console.log("MENSAGEM:\n" + (dry.json?.mensagem ?? "(nenhuma)") + "\n");
const m = dry.json?.mensagem ?? "";
const okDry = dry.status === 200 && dry.json?.bloqueado === false && dry.json?.duplicado === false && dry.json?.data_check?.status === "ok"
  && /starts tomorrow, Friday, October 23\. Our installation team will arrive between 10am and 11am/.test(m)
  && /reach out directly to Ozzi at \(561\) 674-8334\./.test(m) && !/sales rep/.test(m) && /^Hi Jeff! This is Ozzi Floors/.test(m);
console.log("dry aprovado:", okDry);
if (!okDry) { console.log("NADA enviado"); process.exit(1); }
if (!process.argv.includes("--enviar")) { console.log("(sem --enviar: nada enviado)"); process.exit(0); }
const real = await post(body);
console.log("ENVIO:", real.status, JSON.stringify({ ok: real.json?.ok, enviado: real.json?.enviado, registrado: real.json?.registrado, bloqueado: real.json?.bloqueado, motivo: real.json?.motivo }));
const { data: conv } = await ag.from("instagram_conversations").select("id, mode").eq("igsid", `wa_${TEL}`).maybeSingle();
const { data: msgs } = await ag.from("instagram_messages").select("role, content, created_at").eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(3);
console.log("HISTORICO (ultimas 3):"); for (const x of (msgs ?? []).reverse()) console.log("  ", x.created_at.slice(0, 19), x.role, x.content.replace(/\s+/g, " ").slice(0, 110));
const { data: regs } = await ag.from("platform_settings").select("platform").gte("platform", "instalacao_log_" + String(Date.now() - 10 * 60_000).padStart(13, "0")).lt("platform", "instalacao_log_9999999999999");
for (const r of regs ?? []) { const mm = r.platform.match(/::([\s\S]*)$/); const rec = mm ? JSON.parse(decodeURIComponent(mm[1])) : null; if (rec?.tel === TEL) console.log("REGISTRO:", rec.t, rec.st, rec.data, rec.err ?? ""); }
