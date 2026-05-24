"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Bot, BarChart3, History, Wallet, Settings, Gauge } from "lucide-react";
import clsx from "clsx";

const links = [
  { href: "/summary", icon: Gauge, label: "サマリ" },
  { href: "/", icon: LayoutDashboard, label: "ダッシュ" },
  { href: "/trade", icon: Bot, label: "Bot" },
  { href: "/positions", icon: BarChart3, label: "ポジション" },
  { href: "/history", icon: History, label: "履歴" },
  { href: "/wallet", icon: Wallet, label: "ウォレット" },
  { href: "/settings", icon: Settings, label: "設定" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-zinc-900 border-t border-zinc-800 z-50">
      <div className="flex justify-around items-center h-16 max-w-2xl mx-auto">
        {links.map(({ href, icon: Icon, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex flex-col items-center gap-0.5 px-2 py-1 text-xs transition-colors",
                active ? "text-blue-400" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              <Icon size={20} />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
