// PRÉVIA da resposta a comentários de anúncio/post do Facebook (SÓ LEITURA):
// o que a varredura (src/lib/post-comments.ts) faria agora — comentários
// pendentes, a classe (lead / critique / skip) e se responderia. Nunca trava,
// nunca envia, nunca grava.
//
// Uso: npx tsx scripts/preview-comentarios.mts            (lista)
//      npx tsx scripts/preview-comentarios.mts --classify (+ classificação, chama o Haiku)
import { readFileSync } from "fs";
for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const { previewPostComments } = await import("../src/lib/post-comments");
const r = await previewPostComments({ classify: process.argv.includes("--classify") });
console.log(`leitor: ${r.reader} | posts ativos (7d): ${r.posts} | comentários lidos: ${r.comments} | pendentes: ${r.pending.length}`);
const resumo: Record<string, number> = {};
for (const p of r.pending) {
  const k = p.cls ? `${p.cls}${p.wouldReply ? " → RESPONDE" : ""}` : "-";
  resumo[k] = (resumo[k] ?? 0) + 1;
  console.log(`${p.createdTime.slice(0, 16)} ${p.source.padEnd(4)} ${(p.cls ?? "").padEnd(8)} ${p.wouldReply ? "RESPONDE" : "        "} | ${p.message.replace(/\s+/g, " ").slice(0, 90)}`);
}
console.log(resumo);
