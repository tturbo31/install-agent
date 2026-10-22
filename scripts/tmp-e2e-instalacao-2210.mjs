// E2E em PRODUÇÃO das travas "só quem tem obra amanhã" (22/10/2026, caso Dayana).
// NADA é enviado a cliente: só dry, chamadas que o endpoint tem que recusar, e
// um telefone 555 (inexistente) para o caminho não-dry da trava de data.
//   node scripts/tmp-e2e-instalacao-2210.mjs [urlAgente] [urlPlataforma]
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
const env = {}; for (const l of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const URL = (process.argv[2] ?? "https://instagram-dm-agent-chi.vercel.app") + "/api/confirmar-instalacao";
const PLAT = (process.argv[3] ?? env.PLATAFORMA_URL ?? "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
const TOKEN = env.INSTALACAO_TOKEN;
const ag = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ck = (n, c, d = "") => { if (c) { pass++; console.log("  OK ", n); } else { fail++; console.log("  FAIL", n, "<<" + String(d).slice(0, 400) + ">>"); } };
const post = async (body, token = TOKEN) => { const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const fmt = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(d);
const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const amanhaFL = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`); amanhaFL.setUTCDate(amanhaFL.getUTCDate() + 1);
const amanhaTxt = fmt(amanhaFL); // "Friday, October 23"
const amanhaIso = amanhaFL.toISOString().slice(0, 10);
const depoisTxt = fmt(new Date(amanhaFL.getTime() + 2 * 86400000));
console.log(`amanha na Florida: ${amanhaTxt} (${amanhaIso})`);
const msgsDe = async (tel) => { const { data: c } = await ag.from("instagram_conversations").select("id").eq("igsid", `wa_${tel}`).maybeSingle(); if (!c) return 0; const { count } = await ag.from("instagram_messages").select("id", { count: "exact", head: true }).eq("conversation_id", c.id); return count ?? 0; };

console.log("\nPLATAFORMA: GET /api/instalacao/verificar");
const gv = async (tel) => { const r = await fetch(`${PLAT}/api/instalacao/verificar?telefone=${tel}`, { headers: { "x-webhook-token": env.PLATAFORMA_WEBHOOK_TOKEN } }); return { status: r.status, json: await r.json().catch(() => null) }; };
const v1 = await gv("17868770477");
ck("Dayana -> bloquear:true (obra concluida 20/10, sem contrato novo)", v1.status === 200 && v1.json?.bloquear === true && /2026-10-20/.test(v1.json?.motivo ?? ""), JSON.stringify(v1.json).slice(0, 300));
const v2 = await gv("17864574876");
ck("Sonia Gordon -> bloquear:false (contrato 15/10, sem job)", v2.status === 200 && v2.json?.bloquear === false, JSON.stringify(v2.json).slice(0, 300));
const v3 = await fetch(`${PLAT}/api/instalacao/verificar?telefone=17868770477`);
ck("sem token -> 401", v3.status === 401, String(v3.status));

console.log("\nGET uso do agente");
const g = await (await fetch(URL)).json();
ck("GET explica a trava de data/plataforma", /AMANHA na Florida/.test(g?.nota ?? "") && /409/.test(g?.nota ?? ""), JSON.stringify(g).slice(0, 300));

console.log("\nDRY Dayana com a data de amanha -> bloqueado pela PLATAFORMA (obra concluida), nada enviado");
const antesD = await msgsDe("17868770477");
const d1 = await post({ telefone_cliente: "17868770477", data_instalacao: amanhaTxt, nome_cliente: "Dayana", nome_vendedor: "Chris", telefone_vendedor: "(954) 487-7741", dry: true });
ck("200 dry, bloqueado:true, data_check ok", d1.status === 200 && d1.json?.dry === true && d1.json?.bloqueado === true && d1.json?.data_check?.status === "ok", JSON.stringify(d1.json).slice(0, 400));
ck("motivo = obra concluida em 2026-10-20", /CONCLU[I\u00cd]DA em 2026-10-20/i.test(d1.json?.motivo ?? ""), d1.json?.motivo);
ck("verificacao.ok e bloquear:true", d1.json?.verificacao?.ok === true && d1.json?.verificacao?.bloquear === true, JSON.stringify(d1.json?.verificacao));

console.log("\nDRY Sonia Gordon com a data de amanha -> LIBERADO (duplicado: ja avisada hoje)");
const d2 = await post({ telefone_cliente: "17864574876", data_instalacao: amanhaTxt, nome_cliente: "Sonia Gordon", nome_vendedor: "Alexandre", telefone_vendedor: "(561) 609-9025", dry: true });
ck("200 dry, bloqueado:false, verificacao liberou", d2.status === 200 && d2.json?.bloqueado === false && d2.json?.verificacao?.ok === true && d2.json?.verificacao?.bloquear === false, JSON.stringify(d2.json).slice(0, 400));

console.log("\nDRY telefone desconhecido com data que NAO e amanha -> bloqueado pela DATA");
const d3 = await post({ telefone_cliente: "15550000001", data_instalacao: depoisTxt, nome_cliente: "Teste Data", nome_vendedor: "Diego", telefone_vendedor: "(954) 325-6735", dry: true });
ck("200 dry, bloqueado:true, data_check nao_e_amanha", d3.status === 200 && d3.json?.bloqueado === true && d3.json?.data_check?.status === "nao_e_amanha" && d3.json?.data_check?.amanha === amanhaIso, JSON.stringify(d3.json).slice(0, 400));
ck("nao gastou chamada na plataforma (verificacao null)", d3.json?.verificacao === null, JSON.stringify(d3.json?.verificacao));

console.log("\nNAO-DRY telefone 555 (inexistente) com data que NAO e amanha -> 409, NADA enviado, dono avisado");
const n1 = await post({ telefone_cliente: "15550000001", data_instalacao: depoisTxt, nome_cliente: "Teste Trava Data", nome_vendedor: "Diego", telefone_vendedor: "(954) 325-6735" });
ck("409 bloqueado com motivo", n1.status === 409 && n1.json?.ok === false && n1.json?.bloqueado === true && /nao e amanha/.test(n1.json?.motivo ?? ""), JSON.stringify(n1.json).slice(0, 400));
ck("sem conversa criada para o 555 (nada gravado)", (await msgsDe("15550000001")) === 0);

console.log("\nDRY telefone desconhecido com data de amanha -> liberado (plataforma: 0 quotes)");
const d4 = await post({ telefone_cliente: "15550000001", data_instalacao: amanhaTxt, nome_cliente: "Teste Livre", nome_vendedor: "Diego", telefone_vendedor: "(954) 325-6735", dry: true });
ck("200 dry, bloqueado:false, verificacao 0 quotes", d4.status === 200 && d4.json?.bloqueado === false && d4.json?.verificacao?.ok === true && d4.json?.verificacao?.quotes === 0, JSON.stringify(d4.json).slice(0, 400));

console.log("\nDRY sem vendedor -> contato e o Ozzi (561) 674-8334 (regra do dono 22/10/2026)");
const d5 = await post({ telefone_cliente: "15550000001", data_instalacao: amanhaTxt, nome_cliente: "Teste Sem Vendedor", dry: true });
ck("mensagem traz 'reach out directly to Ozzi at (561) 674-8334'", d5.status === 200 && /reach out directly to Ozzi at \(561\) 674-8334\./.test(d5.json?.mensagem ?? ""), d5.json?.mensagem);
ck("mensagem nao fala em 'sales rep' sem vendedor", !/sales rep/.test(d5.json?.mensagem ?? ""), d5.json?.mensagem);
const d6 = await post({ telefone_cliente: "15550000001", data_instalacao: amanhaTxt, nome_cliente: "Teste Vendedor Sem Fone", nome_vendedor: "Chris", dry: true });
ck("vendedor sem telefone -> tambem cai no Ozzi", /reach out directly to Ozzi at \(561\) 674-8334\./.test(d6.json?.mensagem ?? ""), d6.json?.mensagem);

console.log("\nDayana: nenhuma mensagem nova no historico depois dos testes");
const depoisD = await msgsDe("17868770477");
ck("historico da Dayana intacto", depoisD === antesD, `${antesD} -> ${depoisD}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
