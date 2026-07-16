import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isDashboardAuthorized } from "@/lib/admin-auth";

// POST /api/admin/upload-product-image?secret=<ADMIN_SECRET>
// Body: multipart/form-data with field "file" and "path"
// path example: "blue-armor/forged-brown/1.jpg"
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (!isDashboardAuthorized(searchParams.get("secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const path = formData.get("path") as string | null;

  if (!file || !path) {
    return NextResponse.json({ error: "file and path are required" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || "image/jpeg";

  const { error } = await supabaseAdmin.storage
    .from("product-images")
    .upload(path, buffer, { contentType, upsert: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = supabaseAdmin.storage.from("product-images").getPublicUrl(path);

  return NextResponse.json({ ok: true, url: data.publicUrl });
}
