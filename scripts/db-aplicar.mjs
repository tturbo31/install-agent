// APLICA UMA MIGRATION NO POSTGRES DO AGENTE POR CONEXÃO DIRETA (31/07/2026)
//
// Por que existe: o token de GERENCIAMENTO do Supabase deste projeto está morto,
// então nenhuma DDL passa pela API de management — e por isso a migração
// 003_funil_capturas nunca foi aplicada. Consequência real: a caixa-preta dos
// webhooks cai no fallback de chunks em platform_settings, que tem teto de
// ~12,8KB por captura, e webhooks grandes de WhatsApp TRUNCAM (22 truncadas nas
// últimas 168h de tráfego).
//
// A Ozzi Plataforma resolve o mesmo problema há semanas conectando DIRETO no
// Postgres com a senha do banco (scripts/db-aplicar.mjs de lá). Este script é o
// mesmo método apontado para o projeto do AGENTE — o endpoint já foi
// verificado e responde:
//
//     aws-1-us-east-2.pooler.supabase.com:5432  usuário postgres.xmgwuvkbhflyiuclgszl
//
// (a resposta ao teste foi "password authentication failed", o que prova que o
// host e o usuário estão certos: falta SÓ a senha.)
//
// ─── O PASSO QUE DEPENDE DO DONO ────────────────────────────────────────────
// 1. Abrir https://supabase.com/dashboard/project/xmgwuvkbhflyiuclgszl/settings/database
// 2. Em "Database password", clicar em "Reset database password" e copiar a
//    senha gerada (a original não é exibida de novo depois da criação).
// 3. Colar no .env.local DESTE projeto, numa linha nova:
//        SUPABASE_DB_PASSWORD=<senha>
// 4. Rodar:
//        npm install pg --save-dev
//        node --env-file=.env.local scripts/db-aplicar.mjs supabase/migrations/003_funil_capturas.sql
//
// Nenhum deploy é necessário depois: src/lib/funil-raw.ts detecta a tabela
// sozinho na primeira captura e para de usar o fallback.
import { readFileSync } from "node:fs";
import pg from "pg";

const arquivo = process.argv[2] ?? "supabase/migrations/003_funil_capturas.sql";
const sql = readFileSync(arquivo, "utf8");

const senha = process.env.SUPABASE_DB_PASSWORD;
if (!senha) {
  console.error("SUPABASE_DB_PASSWORD ausente no .env.local deste projeto.");
  console.error("Pegue/gere em: Supabase Dashboard -> Project Settings -> Database -> Database password.");
  process.exit(1);
}

const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];

// Candidatos: conexão direta (IPv6, costuma não resolver desta máquina) e os
// poolers Supavisor (IPv4). O primeiro que aceitar a senha vale.
const regioes = ["us-east-2", "us-east-1", "us-west-1", "us-west-2", "sa-east-1"];
const candidatos = [
  { host: `db.${ref}.supabase.co`, port: 5432, user: "postgres" },
  ...["aws-1", "aws-0"].flatMap((p) =>
    regioes.map((r) => ({ host: `${p}-${r}.pooler.supabase.com`, port: 5432, user: `postgres.${ref}` }))
  ),
];

async function conectar() {
  for (const c of candidatos) {
    const client = new pg.Client({
      ...c,
      database: "postgres",
      password: senha,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    try {
      await client.connect();
      console.log(`Conectado via ${c.host} (usuário ${c.user})`);
      return client;
    } catch (err) {
      const msg = String(err.message ?? err);
      if (/password authentication failed/i.test(msg)) {
        throw new Error(
          `Host certo (${c.host}), senha errada. Resete em: ` +
            `https://supabase.com/dashboard/project/${ref}/settings/database`
        );
      }
      console.log(`  (${c.host}: ${msg.split("\n")[0].slice(0, 90)})`);
    }
  }
  throw new Error("Nenhum endpoint de conexão funcionou.");
}

const client = await conectar();
try {
  console.log(`\nAplicando ${arquivo}...`);
  await client.query(sql);
  console.log("Migration aplicada com sucesso.\n");

  const { rows } = await client.query(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name`);
  console.log(`TABELAS (${rows.length}):`);
  for (const t of rows) console.log(`  - ${t.table_name}`);
  if (rows.some((t) => t.table_name === "funil_capturas")) {
    console.log("\n✅ funil_capturas existe — a caixa-preta para de truncar na próxima captura.");
    console.log("   (nenhum deploy necessário: funil-raw.ts detecta a tabela sozinho)");
  }
} finally {
  await client.end();
}
