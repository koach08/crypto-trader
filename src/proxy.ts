import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

// アプリ全体の関所。ボットの開始・停止・緊急停止や資産の数字を、URL を知っているだけの人に触らせない。
// 合言葉は Railway の TRADER_AUTH_USER / TRADER_AUTH_PASSWORD。未設定なら閉じる(開けっぱなしにしない)。
// start.sh と investment-app の中継は同じ合言葉を Basic 認証で送ってくる。

// public endpoint: Railway のヘルスチェックが認証なしで叩く。返すのは ok と時刻・ビルド印だけ。
const PUBLIC_PATHS = new Set(["/api/health"]);

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function authorized(header: string | null): boolean {
  const user = process.env.TRADER_AUTH_USER;
  const pass = process.env.TRADER_AUTH_PASSWORD;
  if (!user || !pass || !header?.startsWith("Basic ")) return false;
  let given: string;
  try {
    given = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  return timingSafeEqual(digest(given), digest(`${user}:${pass}`));
}

export function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  if (!process.env.TRADER_AUTH_USER || !process.env.TRADER_AUTH_PASSWORD) {
    return NextResponse.json({ error: "認証の設定がありません" }, { status: 503 });
  }
  if (authorized(request.headers.get("authorization"))) return NextResponse.next();
  return new NextResponse("ログインが必要です", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="trader", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
