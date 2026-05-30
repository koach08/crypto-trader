import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import NavBar from "@/components/NavBar";
import KillSwitch from "@/components/KillSwitch";
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
  title: "AI crypto trader scammer (academic experiment)",
  description: "An institutional-grade retail crypto AI auto-trading bot — empirical proof that retail crypto AI day trading is structurally a losing game. Academic experiment / 学術実験.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <header className="sticky top-0 z-50 bg-zinc-900/80 backdrop-blur border-b border-zinc-800">
          <div className="flex items-center justify-between px-4 py-2 max-w-2xl mx-auto">
            <h1 className="text-lg font-bold tracking-tight">AI crypto trader scammer (academic experiment)</h1>
            <KillSwitch />
          </div>
        </header>
        <main className="flex-1 px-4 py-4 max-w-2xl mx-auto w-full">
          {children}
        </main>
        <NavBar />
      </body>
    </html>
  );
}
