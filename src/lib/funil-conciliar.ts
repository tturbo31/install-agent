// ─── CONCILIAÇÃO CONTRATO → LEAD, COM REPARO AUTOMÁTICO (31/07/2026) ─────────
//
// Promoção do scripts/backfill-clique-antigo.mjs (script de mão, rodado uma vez)
// para rotina permanente. O motivo é o furo que apareceu no marco zero: o gate
// FUNIL_DESDE segurava o lead_criado de conversas antigas mesmo quando a pessoa
// clicava num anúncio HOJE — 13 de 221 contratos ficaram presos, e a plataforma
// nunca soube. O código do gate já foi corrigido, mas um vazamento assim só se
// enxerga cruzando os DOIS lados, e ninguém vai rodar um script duas vezes por
// dia para sempre.
//
// COMO FUNCIONA
//   1. lê TODO contrato funil_adx_ (uma linha por conversa que clicou num
//      anúncio; quando há mais de um, vale o clique MAIS ANTIGO — mesma regra
//      do placar-rastreio);
//   2. pergunta à plataforma, numa chamada só, quais dessas identidades já têm
//      lead COM ad_id (POST /api/rastreio/conferir — a rota devolve só
//      existe/temAdId, nenhum dado de cliente);
//   3. para cada contrato sem atribuição do outro lado, REPARA: reenvia o
//      lead_criado com identidade + contrato completo, exatamente como o webhook
//      mandaria. A plataforma faz merge fill-if-empty — nunca sobrescreve, nunca
//      duplica, não mexe em estágio.
//
// O QUE NÃO É VAZAMENTO: clique sem NENHUMA mensagem do cliente. A pessoa tocou
// no anúncio e não escreveu nada — isso não é lead, e criar um seria inventar
// cliente. Esses saem contados à parte, nunca como furo.
//
// Idempotente por construção: rodar de novo com tudo conciliado repara zero.
import { supabaseAdmin } from "@/lib/supabase";
import { enviarEventoFunil } from "@/lib/plataforma";
import { canalDe, extrairTelefone, persistirAnuncioDaConversa, type ContratoAnuncio, type ReferralIG } from "@/lib/funil";

const PREFIXO = "funil_adx_";
// MARCA DE "JA CONCILIADO" (28/08/2026). O contrato cujo lead ja tem anuncio E
// telefone esta resolvido para sempre (o merge do outro lado e fill-if-empty e
// idempotente) — mas a rodada continuava perguntando por ele a cada 8 horas.
// Com 2.708 contratos isso era: 28 consultas de conversa + 4 chamadas de
// conferencia + a leitura da caixa-preta, toda rodada, para achar ~17 furos.
// O custo crescia com o HISTORICO e ja tinha estourado o timeout de 120s da
// auditoria. A marca faz o custo crescer com os FUROS.
// prefixo escolhido para NAO colidir: em SQL LIKE o "_" e curinga de 1 char,
// entao um "funil_adxok_" seria devolvido tambem pelo paginar("funil_adx_%")
// que le os contratos. "funil_conc_" nao casa com nenhum padrao existente.
const MARCA_OK = "funil_conc_";
// A marca nunca vira ponto cego: uma fatia dela e re-conferida em toda rodada
// (o lead pode ser fundido/apagado depois). 1/8 por dia => todo contrato
// marcado volta a ser conferido a cada 8 dias, e o resumo DIZ quantos foram.
const DIVISOR_REVERIFICACAO = 8;
const TETO_REPAROS = 60; // por rodada; o resto fica para a próxima (2x/dia)
const TETO_RESGATES = 25; // contratos reconstruídos da caixa-preta por rodada

export type FuroConciliacao = {
  conversa: string;
  igsid: string;
  canal: "instagram" | "facebook" | "whatsapp";
  adId: string | null;
  clicadoEm: string | null;
  reparado: boolean;
  motivo: string;
};

// RITMO DA CAPTURA por faixa horária (31/07/2026). Um teto fixo de silêncio
// serve mal aos 3 canais: o Instagram faz ~8 webhooks/hora e 4h calado já é
// estranho, enquanto no WhatsApp uma madrugada inteira sem nada é rotina. Quem
// sabe o ritmo de cada canal é este banco — então ele manda a estatística junto,
// e a plataforma calcula o teto de cada um.
//
// ATENÇÃO à escolha da estatística: a MEDIANA do intervalo entre capturas é de
// ~0,3 min nos 3 canais, porque uma única conversa dispara uma RAJADA de
// webhooks (mensagem + echo + recibo de leitura). Teto baseado em mediana
// alarmaria a cada 3 minutos. O que descreve "silêncio normal" é a cauda: p99 e
// o MAIOR silêncio realmente observado na faixa.
export type RitmoFaixa = {
  n: number; // quantos intervalos entraram na conta
  medianaMin: number | null; // documentada, mas NÃO serve de base (ver acima)
  p99Min: number | null;
  maiorMin: number | null; // maior silêncio real observado na faixa
};

export type CapturaCanal = {
  canal: "ig" | "fb" | "wa";
  ultimaEm: string | null;
  horasAtras: number | null;
  total: number; // webhooks na janela da caixa-preta (7 dias)
  ritmo: { diurno: RitmoFaixa; noturno: RitmoFaixa };
};

export type ResumoConciliacao = {
  ok: boolean;
  quando: string;
  dry: boolean;
  contratos: number;
  comAtribuicao: number;
  telefonesCosturados: number; // lead tinha o anúncio e não o telefone da conversa
  cliquesSemMensagem: number;
  furos: number; // contratos sem lead atribuído E com mensagem do cliente
  reparados: number;
  naoReparados: number;
  // referral encontrado na CAIXA-PRETA sem contrato funil_adx_ correspondente,
  // reconstruído nesta rodada (10/08/2026 — antes a prova ficava lá 7 dias e
  // nenhuma rotina a usava: gravação de contrato que falhasse num blip do
  // banco era perda permanente)
  resgatadosDaCaixaPreta?: number;
  // contratos pulados por ja estarem conciliados numa rodada anterior, e
  // quantos deles foram re-conferidos mesmo assim nesta (28/08/2026)
  jaConciliados?: number;
  reverificados?: number;
  // onde a rodada gastou o tempo, em segundos (28/08/2026). Sem isto a
  // degradacao de 120s ficou invisivel ate abortar por timeout.
  tempos?: Record<string, number>;
  // contrato SEM ad_id (clique via shortlink/m.me): a plataforma nunca terá
  // `temAdId` para ele — com lead existindo, dá-se por resolvido em vez de
  // "furo eterno" reparado em vão toda rodada consumindo o teto (10/08/2026)
  semAdIdResolvidos?: number;
  detalhes: FuroConciliacao[];
  capturaRaw: CapturaCanal[];
  gcHorasAtras: number | null;
  erro?: string;
};

// Paginação com ordem estável: sem ela o range corta e a conciliação mente
// (mesma armadilha que matou o GC da caixa-preta em 31/07).
async function paginar(like: string): Promise<string[]> {
  const chaves: string[] = [];
  for (let pagina = 0; pagina < 60; pagina++) {
    const { data, error } = await supabaseAdmin
      .from("platform_settings")
      .select("platform")
      .like("platform", like)
      .order("platform", { ascending: true })
      .range(pagina * 1000, pagina * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) chaves.push(r.platform as string);
    if ((data ?? []).length < 1000) break;
  }
  return chaves;
}

type ConvRow = { id: string; igsid: string; name: string | null; username: string | null; created_at: string | null };

// A rota da plataforma corta em 1000 identidades por chamada — e em 10/08/2026
// já eram 959 contratos numa chamada só. O corte era SILENCIOSO: o excedente
// voltava sem resultado, `conferido.get(id)` dava undefined e cada contrato
// acima da linha viraria "furo" reparado em vão para sempre. Daí os lotes de
// 800 (folga sobre o limite) e a exigência de TODOS os lotes responderem:
// conferência pela metade repararia leads que já estão certos.
const LOTE_CONFERENCIA = 800;

async function conferirNaPlataforma(
  identidades: Array<{ chave: string; ig_id?: string; telefone?: string }>
): Promise<Map<string, { existe: boolean; temAdId: boolean; temTelefone: boolean }> | null> {
  const base = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
  const token = process.env.PLATAFORMA_WEBHOOK_TOKEN;
  if (!token) return null;
  const mapa = new Map<string, { existe: boolean; temAdId: boolean; temTelefone: boolean }>();
  for (let i = 0; i < identidades.length; i += LOTE_CONFERENCIA) {
    const lote = identidades.slice(i, i + LOTE_CONFERENCIA);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45_000);
      const res = await fetch(`${base}/api/rastreio/conferir`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-token": token },
        body: JSON.stringify({ identidades: lote }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[CONCILIA] /api/rastreio/conferir -> HTTP ${res.status} (lote ${i / LOTE_CONFERENCIA + 1})`);
        return null;
      }
      const json = (await res.json()) as {
        truncado?: boolean;
        resultados?: Array<{ chave: string; existe: boolean; temAdId: boolean; temTelefone?: boolean }>;
      };
      if (json.truncado) {
        // não deveria acontecer com lotes de 800 — se aconteceu, o contrato do
        // outro lado mudou e continuar seria conciliar com dado pela metade
        console.warn("[CONCILIA] plataforma truncou um lote de 800 — abortando por segurança");
        return null;
      }
      for (const r of json.resultados ?? []) {
        // plataforma antiga não manda temTelefone: assumir que TEM evita
        // reparo em massa desnecessário no dia de um deploy defasado
        mapa.set(r.chave, { existe: r.existe, temAdId: r.temAdId, temTelefone: r.temTelefone !== false });
      }
    } catch (err) {
      console.warn("[CONCILIA] conferência falhou:", String(err).slice(0, 150));
      return null;
    }
  }
  return mapa;
}

// Faixa horária na Flórida. O corte 8h-22h é a janela comercial do próprio
// sistema (8h-20h59 para mensagem em massa) mais a cauda de quem responde à
// noite; fora dela o silêncio é esperado em qualquer canal.
const DIURNO_INICIO = 8;
const DIURNO_FIM = 22;
const faixaDe = (ms: number): "diurno" | "noturno" => {
  const h = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(ms))
  );
  return h >= DIURNO_INICIO && h < DIURNO_FIM ? "diurno" : "noturno";
};

const percentil = (arr: number[], p: number): number | null => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mediana = (arr: number[]): number | null => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const meio = Math.floor(s.length / 2);
  return s.length % 2 ? s[meio] : (s[meio - 1] + s[meio]) / 2;
};

// Última captura raw por canal, RITMO por faixa horária e idade da marca do GC:
// a prova de que a caixa-preta está viva e a base para o teto de silêncio de
// cada canal. Vai no retorno porque quem vigia (a plataforma) não tem acesso a
// este banco.
// `chavesJaLidas` (28/08/2026): a caixa-preta tem ~9,7 MB e era paginada DUAS
// vezes por chamada — uma aqui e outra no resgate — porque o corpo do webhook
// mora dentro da propria chave. Quem ja leu passa a lista adiante.
async function saudeDaCaptura(chavesJaLidas?: string[]): Promise<Pick<ResumoConciliacao, "capturaRaw" | "gcHorasAtras">> {
  const ultimas: Record<"ig" | "fb" | "wa", number> = { ig: 0, fb: 0, wa: 0 };
  const eventos: Record<"ig" | "fb" | "wa", number[]> = { ig: [], fb: [], wa: [] };
  const vistos = new Set<string>();
  try {
    for (const chave of chavesJaLidas ?? (await paginar("funil_raw_%"))) {
      // um POST = um grupo de chunks (canal, epoch, rand): contar chunk seria
      // contar o mesmo webhook várias vezes e encurtar os intervalos
      const m = chave.match(/^funil_raw_(ig|fb|wa)_(\d{10,})_([a-z0-9]{4})_/);
      if (!m) continue;
      const id = `${m[1]}_${m[2]}_${m[3]}`;
      if (vistos.has(id)) continue;
      vistos.add(id);
      const canal = m[1] as "ig" | "fb" | "wa";
      const epoch = Number(m[2]);
      eventos[canal].push(epoch);
      if (epoch > ultimas[canal]) ultimas[canal] = epoch;
    }
  } catch {
    /* sem leitura: a auditoria trata null como "não sei" e não alarma falso */
  }

  const ritmoDe = (canal: "ig" | "fb" | "wa") => {
    const ev = eventos[canal].sort((a, b) => a - b);
    const gaps: Record<"diurno" | "noturno", number[]> = { diurno: [], noturno: [] };
    for (let i = 1; i < ev.length; i++) {
      // o intervalo pertence à faixa em que ele COMEÇOU — é ela que diz se
      // aquele silêncio era esperado
      gaps[faixaDe(ev[i - 1])].push((ev[i] - ev[i - 1]) / 60000);
    }
    const monta = (g: number[]): RitmoFaixa => ({
      n: g.length,
      medianaMin: mediana(g),
      p99Min: percentil(g, 99),
      maiorMin: g.length ? Math.max(...g) : null,
    });
    return { diurno: monta(gaps.diurno), noturno: monta(gaps.noturno) };
  };
  let gcHoras: number | null = null;
  try {
    const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", "funil_rawgc_%");
    const marcas = (data ?? []).map((r) => Number((r.platform as string).replace("funil_rawgc_", ""))).filter(Number.isFinite);
    if (marcas.length) gcHoras = Math.round(((Date.now() - Math.max(...marcas)) / 3600_000) * 10) / 10;
  } catch {
    /* idem */
  }
  return {
    capturaRaw: (["ig", "fb", "wa"] as const).map((canal) => ({
      canal,
      ultimaEm: ultimas[canal] ? new Date(ultimas[canal]).toISOString() : null,
      horasAtras: ultimas[canal] ? Math.round(((Date.now() - ultimas[canal]) / 3600_000) * 10) / 10 : null,
      total: eventos[canal].length,
      ritmo: ritmoDe(canal),
    })),
    gcHorasAtras: gcHoras,
  };
}

// MODO SAÚDE (10/08/2026): responde só o estado da caixa-preta (última captura
// por canal, ritmo e idade do GC) + a contagem de contratos, sem conciliar
// nada. É o que o vigia da plataforma chama no começo do cron da madrugada —
// a conciliação completa custa minutos com ~1000 contratos e lá esse tempo é
// exatamente o que matava a rotina por timeout.
export async function saudeDoFunil(): Promise<ResumoConciliacao> {
  const out: ResumoConciliacao = {
    ok: false,
    quando: new Date().toISOString(),
    dry: true,
    contratos: 0,
    comAtribuicao: 0,
    telefonesCosturados: 0,
    cliquesSemMensagem: 0,
    furos: 0,
    reparados: 0,
    naoReparados: 0,
    detalhes: [],
    capturaRaw: [],
    gcHorasAtras: null,
  };
  try {
    const convs = new Set<string>();
    for (const chave of await paginar(`${PREFIXO}%`)) {
      const m = chave.match(/^funil_adx_([0-9a-f-]{36})::/);
      if (m) convs.add(m[1]);
    }
    out.contratos = convs.size;
    Object.assign(out, await saudeDaCaptura());
    out.ok = true;
  } catch (err) {
    out.erro = String(err instanceof Error ? err.message : err).slice(0, 300);
  }
  return out;
}

// ─── RESGATE DA CAIXA-PRETA (10/08/2026) ─────────────────────────────────────
// A caixa-preta guarda TODO webhook por 7 dias — inclusive o clique de anúncio
// cuja gravação de contrato falhou num blip do banco (o webhook já respondeu
// 200 e a Meta não reentrega; o erro era engolido). A prova ficava lá e
// NENHUMA rotina a usava. Este passo roda ANTES da conciliação: acha referral
// no raw sem funil_adx_ correspondente, reconstrói o contrato pela MESMA
// função do webhook (persistirAnuncioDaConversa) e deixa o loop normal da
// rodada reparar o lead em seguida. Nunca inventa: só usa o que a Meta mandou.

type RefExtraido = { referral: NonNullable<ReferralIG>; igsid: string };

function extrairReferralDeRaw(canal: "ig" | "fb" | "wa", corpo: string, epoch: number): RefExtraido | null {
  const clickedAt = new Date(epoch).toISOString();
  try {
    const j = JSON.parse(corpo) as Record<string, unknown>;
    if (canal === "wa") {
      const phone = typeof j.phone === "string" ? j.phone.replace(/\D/g, "") : "";
      const ear = j.externalAdReply as { sourceType?: string; sourceId?: string; ctwaClid?: string; title?: string; thumbnailUrl?: string } | undefined;
      if (!phone || !ear) return null;
      // mesma regra do webhook: link comum só vira atribuição com prova de anúncio
      if (!(ear.sourceType === "ad" || ear.sourceId || ear.ctwaClid)) return null;
      return {
        igsid: `wa_${phone}`,
        referral: {
          ad_id: ear.sourceId,
          ctwa_clid: ear.ctwaClid,
          source: ear.sourceType,
          clicked_at: clickedAt,
          ads_context_data: { ad_title: ear.title, photo_url: ear.thumbnailUrl },
        },
      };
    }
    // IG/FB: entry[].messaging[] — referral standalone, na mensagem ou no postback
    const entries = Array.isArray(j.entry) ? (j.entry as Array<Record<string, unknown>>) : [];
    for (const e of entries) {
      const messagings = Array.isArray(e.messaging) ? (e.messaging as Array<Record<string, unknown>>) : [];
      for (const m of messagings) {
        const msg = m.message as Record<string, unknown> | undefined;
        const postback = m.postback as Record<string, unknown> | undefined;
        const ref = ((msg?.referral ?? m.referral ?? postback?.referral) ?? null) as {
          ad_id?: string; ref?: string; source?: string; type?: string;
          ads_context_data?: { ad_title?: string; photo_url?: string; video_url?: string; post_id?: string };
        } | null;
        if (!ref || !(ref.ad_id || ref.ads_context_data?.ad_title || ref.ref || ref.source)) continue;
        const sender = (m.sender as { id?: string } | undefined)?.id;
        if (!sender) continue;
        return {
          igsid: canal === "fb" ? `fb_${sender}` : sender,
          referral: { ...ref, clicked_at: clickedAt },
        };
      }
    }
    return null;
  } catch {
    return null; // body truncado/não-JSON: sem prova utilizável
  }
}

async function resgatarDaCaixaPreta(
  contratos: Map<string, ContratoAnuncio>,
  dry: boolean,
  chavesRaw: string[]
): Promise<{ candidatos: number; resgatados: number }> {
  // 1. reconstrói as capturas (agrupa os chunks pela chave)
  const grupos = new Map<string, { canal: "ig" | "fb" | "wa"; epoch: number; partes: Array<{ i: number; chunk: string }> }>();
  for (const chave of chavesRaw) {
    const m = chave.match(/^funil_raw_(ig|fb|wa)_(\d{10,})_([a-z0-9]{4})_(\d+)of(\d+)(?:_s0)?(?:_trunc)?::([\s\S]*)$/);
    if (!m) continue;
    const id = `${m[1]}_${m[2]}_${m[3]}`;
    const g = grupos.get(id) ?? { canal: m[1] as "ig" | "fb" | "wa", epoch: Number(m[2]), partes: [] };
    g.partes.push({ i: Number(m[4]), chunk: m[6] });
    grupos.set(id, g);
  }

  // 2. capturas com referral
  const achados: RefExtraido[] = [];
  for (const [, g] of grupos) {
    const enc = g.partes.sort((a, b) => a.i - b.i).map((p) => p.chunk).join("");
    let corpo = enc;
    try {
      corpo = decodeURIComponent(enc);
    } catch {
      continue; // truncado no meio de um %xx — sem JSON íntegro não há prova
    }
    if (!/referral|externalAdReply/.test(corpo)) continue;
    const r = extrairReferralDeRaw(g.canal, corpo, g.epoch);
    if (r) achados.push(r);
  }
  if (achados.length === 0) return { candidatos: 0, resgatados: 0 };

  // 3. conversas dessas identidades (a captura não guarda o conv.id)
  const igsids = [...new Set(achados.map((a) => a.igsid))];
  const convPorIgsid = new Map<string, string>();
  for (let i = 0; i < igsids.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid")
      .in("igsid", igsids.slice(i, i + 100));
    for (const c of data ?? []) convPorIgsid.set(c.igsid as string, c.id as string);
  }

  // 4. referral cuja conversa existe e NÃO tem contrato → reconstrói
  let candidatos = 0;
  let resgatados = 0;
  const jaResgatadas = new Set<string>();
  for (const a of achados) {
    const convId = convPorIgsid.get(a.igsid);
    if (!convId || contratos.has(convId) || jaResgatadas.has(convId)) continue;
    candidatos++;
    if (dry || resgatados >= TETO_RESGATES) continue;
    try {
      await persistirAnuncioDaConversa(convId, a.referral);
      const lido = await supabaseAdmin
        .from("platform_settings")
        .select("platform")
        .like("platform", `funil_adx_${convId}::%`)
        .limit(1);
      const key = lido.data?.[0]?.platform as string | undefined;
      if (key) {
        const ct = JSON.parse(decodeURIComponent(key.slice(`funil_adx_${convId}::`.length))) as ContratoAnuncio;
        contratos.set(convId, ct); // entra na MESMA rodada de conciliação
        jaResgatadas.add(convId);
        resgatados++;
        console.log(`[CONCILIA] contrato resgatado da caixa-preta: conv=${convId} igsid=${a.igsid} ad=${ct.ad_id ?? "?"}`);
      }
    } catch (err) {
      console.warn("[CONCILIA] resgate falhou:", String(err).slice(0, 120));
    }
  }
  return { candidatos, resgatados };
}

export async function conciliarContratos(opcoes?: { dry?: boolean; teto?: number }): Promise<ResumoConciliacao> {
  const dry = opcoes?.dry === true;
  const out: ResumoConciliacao = {
    ok: false,
    quando: new Date().toISOString(),
    dry,
    contratos: 0,
    comAtribuicao: 0,
    telefonesCosturados: 0,
    cliquesSemMensagem: 0,
    furos: 0,
    reparados: 0,
    naoReparados: 0,
    detalhes: [],
    capturaRaw: [],
    gcHorasAtras: null,
  };

  const t0 = Date.now();
  const tempos: Record<string, number> = {};
  let marco = Date.now();
  const marcar = (passo: string) => {
    tempos[passo] = Math.round((Date.now() - marco) / 100) / 10;
    marco = Date.now();
  };

  try {
    // 1) contratos (o clique mais ANTIGO vence, como no placar)
    const contratos = new Map<string, ContratoAnuncio>();
    for (const chave of await paginar(`${PREFIXO}%`)) {
      const m = chave.match(/^funil_adx_([0-9a-f-]{36})::([\s\S]*)$/);
      if (!m) continue;
      try {
        const ct = JSON.parse(decodeURIComponent(m[2])) as ContratoAnuncio;
        const atual = contratos.get(m[1]);
        if (!atual || (ct.ad_clicked_at ?? "") < (atual.ad_clicked_at ?? "")) contratos.set(m[1], ct);
      } catch {
        /* chave ilegível: nada a conciliar */
      }
    }
    marcar("contratos");

    // A caixa-preta é lida UMA vez e servida aos dois passos que precisam dela
    // (resgate e saúde). Antes eram duas paginações de ~9,7 MB por chamada.
    let chavesRaw: string[] = [];
    try {
      chavesRaw = await paginar("funil_raw_%");
    } catch (err) {
      console.warn("[CONCILIA] leitura da caixa-preta falhou:", String(err).slice(0, 120));
    }
    marcar("caixa_preta");

    // 1b) RESGATE DA CAIXA-PRETA: referral gravado no raw sem contrato — o
    // clique cuja persistência falhou (blip do banco, canal pausado, return
    // sem persistir de versão antiga) volta à vida aqui, e o loop abaixo já o
    // concilia nesta mesma rodada. Em dry só conta.
    try {
      const resgate = await resgatarDaCaixaPreta(contratos, dry, chavesRaw);
      out.resgatadosDaCaixaPreta = dry ? resgate.candidatos : resgate.resgatados;
    } catch (err) {
      console.warn("[CONCILIA] resgate da caixa-preta falhou:", String(err).slice(0, 120));
    }
    marcar("resgate");

    out.contratos = contratos.size;
    if (contratos.size === 0) {
      Object.assign(out, await saudeDaCaptura(chavesRaw));
      out.ok = true;
      out.tempos = { ...tempos, total: Math.round((Date.now() - t0) / 100) / 10 };
      return out;
    }

    // 1c) O QUE JÁ ESTÁ CONCILIADO NÃO SE PERGUNTA DE NOVO (28/08/2026).
    // Contrato marcado = a plataforma já respondeu "tem anúncio E tem
    // telefone" numa rodada anterior; do outro lado o merge é fill-if-empty,
    // então isso não se desfaz sozinho. O que PODE desfazer (fusão de leads,
    // exclusão) é coberto pela re-conferência de 1/8 por dia — nunca por fé.
    const marcados = new Set<string>();
    try {
      for (const chave of await paginar(`${MARCA_OK}%`)) marcados.add(chave.slice(MARCA_OK.length));
    } catch (err) {
      console.warn("[CONCILIA] leitura das marcas falhou:", String(err).slice(0, 120));
    }
    const diaDoAno = Math.floor(Date.now() / 864e5);
    const somaSimples = (t: string) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 100000;
      return h;
    };
    const reverificar = (id: string) => somaSimples(id) % DIVISOR_REVERIFICACAO === diaDoAno % DIVISOR_REVERIFICACAO;

    const todosIds = [...contratos.keys()];
    const ids = todosIds.filter((id) => !marcados.has(id) || reverificar(id));
    out.jaConciliados = todosIds.length - ids.length;
    out.reverificados = ids.filter((id) => marcados.has(id)).length;
    out.comAtribuicao = out.jaConciliados; // pulado por marca = atribuído
    if (ids.length === 0) {
      Object.assign(out, await saudeDaCaptura(chavesRaw));
      out.ok = true;
      out.tempos = { ...tempos, total: Math.round((Date.now() - t0) / 100) / 10 };
      return out;
    }

    // 2) conversas
    const convs = new Map<string, ConvRow>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await supabaseAdmin
        .from("instagram_conversations")
        .select("id, igsid, name, username, created_at")
        .in("id", ids.slice(i, i + 100));
      for (const c of (data ?? []) as ConvRow[]) convs.set(c.id, c);
    }

    // 3) uma pergunta só à plataforma
    const identidades = ids.map((id) => {
      const conv = convs.get(id);
      const igsid = conv?.igsid ?? "";
      const canal = canalDe(igsid);
      return {
        chave: id,
        ig_id: canal === "whatsapp" ? undefined : canal === "facebook" ? igsid.slice(3) : igsid,
        telefone: canal === "whatsapp" ? `+${igsid.slice(3).replace(/\D/g, "")}` : undefined,
      };
    });
    marcar("conversas");
    const conferido = await conferirNaPlataforma(identidades);
    marcar("conferencia");
    if (!conferido) {
      Object.assign(out, await saudeDaCaptura(chavesRaw));
      out.erro = "plataforma não respondeu a conferência — nada foi reparado";
      out.tempos = { ...tempos, total: Math.round((Date.now() - t0) / 100) / 10 };
      return out;
    }

    // 4) reparo do que ficou para trás
    let reparosFeitos = 0;
    let consultasMensagens = 0; // contratos que precisaram ler a conversa
    const marcasNovas: string[] = []; // contratos que passam a ser pulados
    const marcasCaidas: string[] = []; // re-conferidos que voltaram a ter furo
    const teto = opcoes?.teto ?? TETO_REPAROS;
    for (const id of ids) {
      const estado = conferido.get(id);
      const conv = convs.get(id);
      const igsid = conv?.igsid ?? "";
      const canal = canalDe(igsid);
      const ct = contratos.get(id) as ContratoAnuncio;

      // ATALHO DO JA RESOLVIDO (28/08/2026) — o passo que quebrou o auto-curador.
      // A varredura fazia UMA consulta de mensagens POR CONTRATO *antes* de
      // decidir se havia algo a reparar. Com 2.705 contratos, 2.687 deles ja
      // atribuidos e com telefone, a rodada gastava 2.687 idas ao banco para
      // achar ~18 furos: medido em 120,1s — exatamente o timeout que a auditoria
      // da plataforma usa. A chamada ABORTAVA em toda rodada da manha e da
      // tarde, o reparo numero 1 do rastreio (contrato -> lead) nao rodava, e
      // ainda queimava 120s do orcamento de 210s da auditoria, o que deixava o
      // detetive de IA sem folga para investigar um caso novo sequer.
      // Contrato ja atribuido E com telefone no lead nao tem nada a costurar:
      // decide-se aqui, sem tocar no banco. O custo da rodada passa a ser
      // proporcional aos FUROS, e nao ao historico inteiro.
      if (estado?.temAdId === true && estado?.temTelefone === true) {
        out.comAtribuicao++;
        if (!marcados.has(id)) marcasNovas.push(id);
        continue;
      }

      // So quem ainda pode gerar reparo paga a consulta. E `role=user` foi para
      // o filtro do BANCO: assim o limite de 400 vale para as mensagens do
      // CLIENTE (antes, 400 linhas de qualquer papel podiam nao conter nenhuma
      // dele, e o telefone digitado na conversa ficava fora do corte).
      consultasMensagens++;
      const { data: msgs } = await supabaseAdmin
        .from("instagram_messages")
        .select("role, content, created_at")
        .eq("conversation_id", id)
        .eq("role", "user")
        .order("created_at", { ascending: true })
        .limit(400);
      const doCliente = msgs ?? [];
      if (doCliente.length === 0) {
        // clique sem conversa não é lead — criar um seria inventar cliente
        out.cliquesSemMensagem++;
        continue;
      }

      // O TELEFONE QUE O CLIENTE DIGITOU NA CONVERSA (01/08/2026).
      // O lead da conversa nasce SEM telefone (a Meta não dá o número) e o
      // `temAdId` dava a conversa por resolvida ali. Só que a VISITA entra por
      // outro caminho: quando é o vendedor quem marca no calendário, nasce um
      // segundo lead — com telefone e sem anúncio — e nada une os dois. A
      // agenda mostra a visita sem criativo mesmo com o clique rastreado.
      // Caso real: Rolando Perez (786-367-3787), clique em "New Engagement
      // Ad10" registrado, visita marcada pelo vendedor em 05/08.
      // O elo existe e é prova, não palpite: o próprio cliente escreveu o
      // número no chat. Mandar esse telefone junto fecha a costura.
      let telefone: string | undefined;
      if (canal === "whatsapp") telefone = `+${igsid.slice(3).replace(/\D/g, "")}`;
      else
        for (const m of doCliente) {
          const t = extrairTelefone(m.content as string);
          if (t) {
            telefone = t;
            break;
          }
        }

      const faltaTelefone = Boolean(telefone) && estado?.temAdId === true && estado?.temTelefone === false;
      if (estado?.temAdId && !faltaTelefone) {
        out.comAtribuicao++;
        continue;
      }
      if (faltaTelefone) out.telefonesCosturados++;

      // CONTRATO SEM ad_id (clique via shortlink/m.me — só ref/source/título):
      // a plataforma NUNCA responderá temAdId para ele, então tratá-lo como
      // furo criava um zumbi reparado em vão TODA rodada, consumindo o teto de
      // 60 e empurrando furo real para "fica para a próxima" (10/08/2026).
      // Com o lead EXISTINDO, o que havia para entregar (título/ref) já foi:
      // dá-se por resolvido, contado à parte. Sem lead, o reparo abaixo roda
      // uma vez e cria o lead — na rodada seguinte cai neste ramo.
      if (!ct?.ad_id && !faltaTelefone && estado?.existe) {
        out.semAdIdResolvidos = (out.semAdIdResolvidos ?? 0) + 1;
        continue;
      }

      // re-conferido que VOLTOU a ter furo (lead fundido/apagado depois da
      // marca): a marca cai agora, senão o furo ficaria escondido por 8 dias
      if (marcados.has(id)) marcasCaidas.push(id);

      if (!faltaTelefone) out.furos++;
      const furo: FuroConciliacao = {
        conversa: id,
        igsid,
        canal,
        adId: ct?.ad_id ?? null,
        clicadoEm: ct?.ad_clicked_at ?? null,
        reparado: false,
        motivo: "",
      };

      if (reparosFeitos >= teto) {
        furo.motivo = `teto de ${teto} reparos por rodada atingido — fica para a próxima`;
        out.naoReparados++;
        out.detalhes.push(furo);
        continue;
      }

      if (dry) {
        furo.motivo = "simulação (nada enviado)";
        out.detalhes.push(furo);
        reparosFeitos++;
        continue;
      }

      const envio = await enviarEventoFunil("lead_criado", {
        ig_id: canal === "whatsapp" ? undefined : canal === "facebook" ? igsid.slice(3) : igsid,
        ig_username: canal === "instagram" ? conv?.username ?? undefined : undefined,
        telefone,
        nome: conv?.name ?? conv?.username ?? undefined,
        canal,
        ...ct,
        ad_name: ct?.ad_title ?? undefined,
      });
      reparosFeitos++;
      furo.reparado = envio.ok;
      furo.motivo = envio.ok
        ? faltaTelefone
          ? "telefone da conversa costurado ao lead (visita do calendário passa a ter criativo)"
          : "lead_criado reenviado com identidade + contrato"
        : `HTTP ${envio.status} ${(envio.body ?? "").slice(0, 80)}`;
      if (envio.ok) out.reparados++;
      else out.naoReparados++;
      out.detalhes.push(furo);
    }

    marcar("reparos");

    // grava as marcas SÓ agora (nunca em dry): o contrato marcado é o que a
    // plataforma acabou de confirmar resolvido nesta rodada.
    if (!dry) {
      try {
        for (let i = 0; i < marcasNovas.length; i += 500) {
          await supabaseAdmin
            .from("platform_settings")
            .upsert(
              marcasNovas.slice(i, i + 500).map((id) => ({ platform: `${MARCA_OK}${id}`, paused: false })),
              { onConflict: "platform", ignoreDuplicates: true }
            );
        }
        for (const id of marcasCaidas) {
          await supabaseAdmin.from("platform_settings").delete().eq("platform", `${MARCA_OK}${id}`);
        }
      } catch (err) {
        console.warn("[CONCILIA] gravação das marcas falhou:", String(err).slice(0, 120));
      }
    }
    marcar("marcas");

    Object.assign(out, await saudeDaCaptura(chavesRaw));
    out.ok = true;
    marcar("saude");
    out.tempos = { ...tempos, total: Math.round((Date.now() - t0) / 100) / 10 };
    console.log(
      `[CONCILIA] ${out.contratos} contratos · ${out.comAtribuicao} já atribuídos · ${out.cliquesSemMensagem} clique sem mensagem · ` +
        `${out.furos} furo(s) · ${out.reparados} reparado(s) · ${out.naoReparados} não reparado(s) · ` +
        `${out.jaConciliados} pulado(s) por marca (${out.reverificados} re-conferido(s)) · ` +
        `${consultasMensagens} conversa(s) lida(s) de ${ids.length} pendente(s) · ${JSON.stringify(out.tempos)}`
    );
    return out;
  } catch (err) {
    out.erro = String(err instanceof Error ? err.message : err).slice(0, 300);
    out.tempos = { ...tempos, total: Math.round((Date.now() - t0) / 100) / 10 };
    return out;
  }
}
