// AUDITORIA (E CORREÇÃO) DA ASSINATURA DE WEBHOOK DO INSTAGRAM
//
// Por que existe: em 28/07/2026 o Facebook estava com ZERO referrals de anúncio.
// A causa era a PÁGINA assinada só em `messages` — faltava `messaging_referrals`.
// Depois do POST /{page-id}/subscribed_apps o canal foi para 134/134 leads com
// anúncio (100%). O Instagram ficou em 47% e essa mesma auditoria nunca tinha
// sido feita nele.
//
// ATENÇÃO — o Instagram aqui NÃO é "Messenger API for Instagram" (aquele que
// pendura a conta numa Página do Facebook). É a **Instagram API with Instagram
// Login**: token nativo `IGAA…`, host `graph.instagram.com`, e a assinatura mora
// na PRÓPRIA CONTA (`/me/subscribed_apps`), não na Página. Por isso o campo
// chama `messaging_referral` (singular) e não `messaging_referrals` (plural, que
// é o nome no objeto `page`). Procurar no lugar do Facebook não acha nada.
//
// O token VIVO não está no .env: ele se auto-renova e mora em
// platform_settings (`igtok|<iso>|<token>`, ver src/lib/ig-token.ts).
//
// Uso: node --env-file=.env.local scripts/assinatura-ig.mjs            (só LÊ)
//      node --env-file=.env.local scripts/assinatura-ig.mjs --corrigir  (assina)
//
// O --corrigir é ADITIVO: lê o conjunto atual e reenvia ele INTEIRO mais os
// campos que faltam. O POST substitui o conjunto, então esquecer um campo o
// derrubaria — foi por isso que a correção do Facebook precisou de 2 tentativas.
import { createClient } from "@supabase/supabase-js";

const CORRIGIR = process.argv.includes("--corrigir");
const GRAPH = "https://graph.instagram.com/v21.0";

// Campos que ESTE código sabe tratar. Não assinar nada além disso: campo que
// ninguém consome vira tráfego e risco de comportamento novo sem querer.
const DESEJADOS = [
  "messages",
  "messaging_postbacks",
  "messaging_optins",
  "message_reactions",
  "agent_messages",
  "messaging_referral", // ← o que faltava: clique em anúncio com destino Direct
];

const ag = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await ag.from("platform_settings").select("platform").like("platform", "igtok|%");
const guardado = (data ?? [])
  .map((r) => {
    const [, quando, tok] = String(r.platform).split("|");
    return quando && tok ? { quando, tok } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.quando.localeCompare(a.quando))[0];
const T = guardado?.tok ?? process.env.INSTAGRAM_ACCESS_TOKEN;
if (!T) {
  console.error("Nenhum token do Instagram (nem no banco nem no .env).");
  process.exit(1);
}
console.log(`token: ${guardado ? `do banco, renovado em ${guardado.quando}` : "do .env"} — ${String(T).slice(0, 12)}…\n`);

async function chamar(rotulo, url, metodo = "GET") {
  const r = await fetch(url, { method: metodo });
  const b = await r.json().catch(() => ({}));
  console.log(`── ${rotulo}  [HTTP ${r.status}]`);
  console.log(JSON.stringify(b, null, 1));
  console.log("");
  return b;
}

const me = await chamar("GET /me (que conta é esta)", `${GRAPH}/me?fields=id,user_id,username,name,account_type&access_token=${T}`);
const antes = await chamar("GET /me/subscribed_apps (ANTES)", `${GRAPH}/me/subscribed_apps?access_token=${T}`);

const apps = antes?.data ?? [];
const atuais = apps[0]?.subscribed_fields ?? [];
const faltando = DESEJADOS.filter((c) => !atuais.includes(c));
const extras = atuais.filter((c) => !DESEJADOS.includes(c));

console.log("═══ DIAGNÓSTICO ═══");
console.log(`conta          : @${me?.username ?? "?"} (${me?.account_type ?? "?"})`);
console.log(`apps inscritos : ${apps.length}${apps.length > 1 ? "  ⚠️ MAIS DE UM — conferir handover/receptor primário" : ""}`);
for (const a of apps) console.log(`   app ${a.id}: ${(a.subscribed_fields ?? []).join(", ")}`);
console.log(`assinados      : ${atuais.join(", ") || "(nenhum)"}`);
console.log(`FALTANDO       : ${faltando.join(", ") || "(nada)"}`);
if (extras.length) console.log(`extras (mantidos): ${extras.join(", ")}`);
console.log(
  faltando.includes("messaging_referral")
    ? "\n🔴 `messaging_referral` NÃO está assinado — o clique em anúncio com destino Direct não chega neste app."
    : "\n✅ `messaging_referral` está assinado."
);

if (!CORRIGIR) {
  if (faltando.length) console.log("\nRode com --corrigir para assinar (aditivo, mantém o que já existe).");
  process.exit(0);
}
if (!faltando.length) {
  console.log("\nNada a corrigir.");
  process.exit(0);
}

// União: tudo o que já existia + o que falta. NUNCA só os que faltam.
const uniao = [...new Set([...atuais, ...DESEJADOS])];
console.log(`\n═══ CORRIGINDO ═══\nPOST subscribed_fields = ${uniao.join(",")}\n`);
await chamar(
  "POST /me/subscribed_apps",
  `${GRAPH}/me/subscribed_apps?subscribed_fields=${encodeURIComponent(uniao.join(","))}&access_token=${T}`,
  "POST"
);

const depois = await chamar("GET /me/subscribed_apps (DEPOIS)", `${GRAPH}/me/subscribed_apps?access_token=${T}`);
const agora = depois?.data?.[0]?.subscribed_fields ?? [];
const perdidos = atuais.filter((c) => !agora.includes(c));
console.log("═══ RESULTADO ═══");
console.log(`assinados agora : ${agora.join(", ") || "(nenhum)"}`);
console.log(agora.includes("messaging_referral") ? "✅ messaging_referral ATIVO" : "❌ messaging_referral continua fora");
if (perdidos.length) console.log(`🔴 CAMPOS PERDIDOS na escrita: ${perdidos.join(", ")} — reassinar AGORA`);
else console.log("✅ nenhum campo anterior foi perdido");
process.exit(agora.includes("messaging_referral") && perdidos.length === 0 ? 0 : 1);
