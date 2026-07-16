import { NextRequest, NextResponse } from "next/server";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { isDashboardAuthorized } from "@/lib/admin-auth";

export const maxDuration = 30;

const ZAPI_BASE = "https://api.z-api.io";

// GET /api/wa-diag?secret=... — reports the LIVE Z-API connection state using
// the PRODUCTION credentials (the ones that actually send). This is the only way
// to see, from outside, whether WhatsApp sends are failing because the instance
// is disconnected / out of subscription / wrong token. Optional &send=<phone>
// (or &send=1 for the owner number) performs a real test send and returns the
// raw Z-API result so the exact send error is visible. Admin-secret protected.
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

  return NextResponse.json(out, { status: 200 });
}
