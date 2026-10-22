import { NextRequest, NextResponse } from "next/server";
import { fetchWaQueueHealth, sendWhatsAppMessage, notifyOwners, CLIENT_ATTENTION_PHONES } from "@/lib/whatsapp";
import { judgeWaQueue } from "@/lib/wa-queue-policy";
import { isDashboardAuthorized } from "@/lib/admin-auth";

export const maxDuration = 30;

const ZAPI_BASE = "https://api.z-api.io";

// GET /api/wa-diag?secret=... — reports the LIVE Z-API connection state using
// the PRODUCTION credentials (the ones that actually send). This is the only way
// to see, from outside, whether WhatsApp sends are failing because the instance
// is disconnected / out of subscription / wrong token. Optional &send=<phone>
// (or &send=1 for the owner number) performs a real test send and returns the
// raw Z-API result so the exact send error is visible. Admin-secret protected.
// Optional &alertTest=1 fires a REAL client-attention alert through the same
// path the webhooks use (notifyOwners), labelled as a test, and returns the
// per-phone result — proves in production who receives those alerts
// (owners + Ruani since 22/10/2026).
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!isDashboardAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inst = process.env.ZAPI_INSTANCE_ID ?? "";
  const tok = process.env.ZAPI_TOKEN ?? "";
  const clientTok = process.env.ZAPI_CLIENT_TOKEN ?? "";

  const call = async (path: string) => {
    try {
      const res = await fetch(`${ZAPI_BASE}/instances/${inst}/token/${tok}/${path}`, {
        headers: { "Client-Token": clientTok },
      });
      const body = await res.json().catch(() => ({}));
      return { httpStatus: res.status, body };
    } catch (e) {
      return { httpStatus: 0, body: { error: String(e) } };
    }
  };

  const queue = await fetchWaQueueHealth();

  const out: Record<string, unknown> = {
    config: {
      instancePresent: !!inst,
      instanceMasked: inst ? `${inst.slice(0, 4)}…${inst.slice(-3)}` : null,
      tokenPresent: !!tok,
      clientTokenPresent: !!clientTok,
      webhookTokenPresent: !!process.env.ZAPI_WEBHOOK_TOKEN,
    },
    status: await call("status"),
    device: await call("device"),
    // Outbound queue (Olimpia 2026-08-25): send-text says 200 on ENQUEUE, so a
    // hung Z-API worker looks like success everywhere except here.
    queue: queue,
    queueVerdict: judgeWaQueue(queue),
  };

  const send = req.nextUrl.searchParams.get("send");
  if (send) {
    const phone = send === "1" ? "556294554477" : send.replace(/\D/g, "");
    const result = await sendWhatsAppMessage(
      phone,
      "[Teste OzziFloors] Diagnostico de entrega do WhatsApp. Se voce recebeu, o envio esta funcionando. Pode ignorar."
    );
    out.testSend = { phone, result };
  }

  if (req.nextUrl.searchParams.get("alertTest") === "1") {
    const results = await notifyOwners({
      platform: "Teste do sistema",
      clientName: "TESTE DO SISTEMA (pode ignorar)",
      clientId: "teste",
      recentMessages: [{ role: "user", content: "[Teste] Conferindo quem recebe os avisos de cliente que precisa de atencao. Nenhum cliente para atender." }],
      alert: "🧪 TESTE DO SISTEMA — NAO E CLIENTE. Este aviso confere que os avisos de cliente chegam ao Ozzi, ao dono e a Ruani.",
    });
    out.alertTest = { phones: CLIENT_ATTENTION_PHONES, results };
  }

  return NextResponse.json(out, { status: 200 });
}
