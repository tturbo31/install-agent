"use client";

import { useState } from "react";

const COLLECTIONS = [
  {
    name: "Blue Armor",
    slug: "blue-armor",
    colors: ["forged-brown", "drawbridge-wood", "grey-shield", "petrified-oak", "fortified-wood", "winter-keep", "white-knight"],
  },
  {
    name: "CPF Spirit XL",
    slug: "cpf-spirit-xl",
    colors: ["creme-brulee", "blass-gray", "balanced-oak", "cerise", "slate", "plata-oak", "coffee-cream", "perla", "rouge-oak", "clear-pecan", "cappuccino-oak"],
  },
  {
    name: "Apres",
    slug: "apres",
    colors: ["latte", "galao", "macchiato", "panna", "mocha", "caramel", "irish", "espresso"],
  },
  {
    name: "Whisper Woods Lite",
    slug: "whisper-woods-lite",
    colors: ["coastal-mist", "cenote-hickory", "berlin-loft", "oslo-ash", "loire-valley", "sevilla-oak", "nordic-shadow", "madagascar-oak", "bordeaux-wine"],
  },
  {
    name: "Iris 8mm",
    slug: "iris-8mm",
    colors: ["pacific-dune", "harvest", "palm-coast", "sand-bar", "hill-country", "caramel-coast"],
  },
  {
    name: "Decotile",
    slug: "decotile",
    colors: ["eli", "lia"],
  },
];

export default function UploadFotos() {
  const [status, setStatus] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);

  async function handleUpload(collection: string, color: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    const key = `${collection}/${color}`;
    setUploading(true);

    for (let i = 0; i < Math.min(files.length, 3); i++) {
      const file = files[i];
      const path = `${collection}/${color}/${i + 1}.jpg`;
      const form = new FormData();
      form.append("file", file);
      form.append("path", path);

      const res = await fetch(`/api/admin/upload-product-image?secret=${process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka"}`, {
        method: "POST",
        body: form,
      });

      const data = await res.json();
      if (data.ok) {
        setStatus((prev) => ({ ...prev, [key]: `Uploaded ${i + 1}/${Math.min(files.length, 3)}` }));
      } else {
        setStatus((prev) => ({ ...prev, [key]: `Error: ${data.error}` }));
      }
    }

    setUploading(false);
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <h1 className="text-2xl font-bold mb-2">Upload Fotos dos Pisos</h1>
      <p className="text-gray-400 text-sm mb-8">
        Para cada cor, selecione até 3 fotos. O agente vai enviar essas fotos automaticamente quando o cliente perguntar sobre as opções.
      </p>

      {COLLECTIONS.map((col) => (
        <div key={col.slug} className="mb-10">
          <h2 className="text-lg font-semibold text-yellow-400 mb-4">{col.name}</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {col.colors.map((color) => {
              const key = `${col.slug}/${color}`;
              const label = color.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
              const st = status[key];
              return (
                <div key={color} className="bg-gray-900 rounded-lg p-3 border border-gray-800">
                  <p className="text-sm font-medium mb-2 capitalize">{label}</p>
                  <label className="block">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={uploading}
                      onChange={(e) => handleUpload(col.slug, color, e.target.files)}
                      className="hidden"
                    />
                    <span className="block text-center text-xs bg-indigo-600 hover:bg-indigo-500 cursor-pointer rounded px-3 py-2 transition-colors">
                      Selecionar fotos
                    </span>
                  </label>
                  {st && (
                    <p className={`text-xs mt-1 ${st.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
                      {st}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
