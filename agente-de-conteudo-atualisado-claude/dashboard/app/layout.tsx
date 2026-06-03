import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Camo Intelligence | Relatórios Diários",
  description:
    "Relatórios diários de inteligência sobre melhorias de IA e agentes: vídeos do YouTube, projetos do GitHub e como aplicá-los nos seus projetos.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <body className="min-h-full bg-[#000000] text-[#f5f5f5] antialiased">
        {children}
      </body>
    </html>
  );
}
