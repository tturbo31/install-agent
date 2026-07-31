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
import { canalDe, extrairTelefone, type ContratoAnuncio } from "@/lib/funil";

const PREFIXO = "funil_adx_";
const TETO_REPAROS = 60; // por rodada; o resto fica para a próxima (2x/dia)

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
  cliquesSemMensagem: number;
  furos: number; // contratos sem lead atribuído E com mensagem do cliente
  reparados: number;
  naoReparados: number;
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

async function conferirNaPlataforma(
  identidades: Array<{ chave: string; ig_id?: string; telefone?: string }>
): Promise<Map<string, { existe: boolean; temAdId: boolean }> | null> {
  const base = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
  const token = process.env.PLATAFORMA_WEBHOOK_TOKEN;
  if (!token) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    const res = await fetch(`${base}/api/rastreio/conferir`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-token": token },
      body: JSON.stringify({ identidades }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[CONCILIA] /api/rastreio/conferir -> HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { resultados?: Array<{ chave: string; existe: boolean; temAdId: boolean }> };
    return new Map((json.resultados ?? []).map((r) => [r.chave, { existe: r.existe, temAdId: r.temAdId }]));
  } catch (err) {
    console.warn("[CONCILIA] conferência falhou:", String(err).slice(0, 150));
    return null;
  }
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
async function saudeDaCaptura(): Promise<Pick<ResumoConciliacao, "capturaRaw" | "gcHorasAtras">> {
  const ultimas: Record<"ig" | "fb" | "wa", number> = { ig: 0, fb: 0, wa: 0 };
  const eventos: Record<"ig" | "fb" | "wa", number[]> = { ig: [], fb: [], wa: [] };
  const vistos = new Set<string>();
  try {
    for (const chave of await paginar("funil_raw_%")) {
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

export async function conciliarContratos(opcoes?: { dry?: boolean; teto?: number }): Promise<ResumoConciliacao> {
  const dry = opcoes?.dry === true;
  const out: ResumoConciliacao = {
    ok: false,
    quando: new Date().toISOString(),
    dry,
    contratos: 0,
    comAtribuicao: 0,
    cliquesSemMensagem: 0,
    furos: 0,
    reparados: 0,
    naoReparados: 0,
    detalhes: [],
    capturaRaw: [],
    gcHorasAtras: null,
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
    out.contratos = contratos.size;
    if (contratos.size === 0) {
      Object.assign(out, await saudeDaCaptura());
      out.ok = true;
      return out;
    }

    // 2) conversas
    const ids = [...contratos.keys()];
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
    const conferido = await conferirNaPlataforma(identidades);
    if (!conferido) {
      Object.assign(out, await saudeDaCaptura());
      out.erro = "plataforma não respondeu a conferência — nada foi reparado";
      return out;
    }

    // 4) reparo do que ficou para trás
    let reparosFeitos = 0;
    const teto = opcoes?.teto ?? TETO_REPAROS;
    for (const id of ids) {
      const estado = conferido.get(id);
      if (estado?.temAdId) {
        out.comAtribuicao++;
        continue;
      }
      const conv = convs.get(id);
      const igsid = conv?.igsid ?? "";
      const canal = canalDe(igsid);
      const ct = contratos.get(id) as ContratoAnuncio;

      const { data: msgs } = await supabaseAdmin
        .from("instagram_messages")
        .select("role, content, created_at")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true })
        .limit(400);
      const doCliente = (msgs ?? []).filter((m) => m.role === "user");
      if (doCliente.length === 0) {
        // clique sem conversa não é lead — criar um seria inventar cliente
        out.cliquesSemMensagem++;
        continue;
      }

      out.furos++;
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
      furo.motivo = envio.ok ? "lead_criado reenviado com identidade + contrato" : `HTTP ${envio.status} ${(envio.body ?? "").slice(0, 80)}`;
      if (envio.ok) out.reparados++;
      else out.naoReparados++;
      out.detalhes.push(furo);
    }

    Object.assign(out, await saudeDaCaptura());
    out.ok = true;
    console.log(
      `[CONCILIA] ${out.contratos} contratos · ${out.comAtribuicao} já atribuídos · ${out.cliquesSemMensagem} clique sem mensagem · ` +
        `${out.furos} furo(s) · ${out.reparados} reparado(s) · ${out.naoReparados} não reparado(s)`
    );
    return out;
  } catch (err) {
    out.erro = String(err instanceof Error ? err.message : err).slice(0, 300);
    return out;
  }
}
