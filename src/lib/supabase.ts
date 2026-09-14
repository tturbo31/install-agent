import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { fetchResiliente } from "./fetch-resiliente";

let _supabase: SupabaseClient | null = null;

// Leituras (GET/HEAD) repetem sozinhas em erro transitório do banco (504, 503,
// rede, PGRST303) — ver fetch-resiliente.ts (14/09/2026: a conciliação e a
// recuperação de criativos responderam 500 à plataforma porque UMA leitura de
// platform_settings caiu na fila do banco às 9h; a rodada inteira foi perdida).
// Escritas nunca são repetidas aqui.
export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { global: { fetch: fetchResiliente() } }
    );
  }
  return _supabase;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    return getSupabase()[prop as keyof SupabaseClient];
  },
});

export const supabaseAdmin = supabase;
