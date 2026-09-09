"""
入金するかどうかの判断材料。基準は「放置に勝つか」。

放置には2つの意味があるので両方出す:
  A 円のまま置く      … 何もしない
  B 入れた日に3ペア均等で買って持ちっぱなし … 売買はしないが仮想通貨は持つ

アプリがどちらにも負けているなら、増やす理由は成績にはない。

実行: python3 scripts/vs-doing-nothing.py
     (価格は data/backtest-cache/*.json を使うので、先に
      npx vitest run --config vitest.harness.config.ts scripts/gate-cost.harness.ts
      などでキャッシュを更新しておく)
"""
import json, urllib.request, datetime, pathlib

U = "https://imaginative-transformation-production-8b85.up.railway.app"
def get(p):
    return json.load(urllib.request.urlopen(U + p, timeout=60))

perf = get("/api/bot/performance")
nav  = get("/api/bot/nav")

f = perf["funding"]
base_at = f["baselineAt"]; base_jpy = f["baselineJPY"]
flows = f["flows"]
now_nav = f["currentNavJPY"]

PAIRS = ["BTC/JPY", "ETH/JPY", "XRP/JPY"]
cache = pathlib.Path("data/backtest-cache")
bars = {}
for p in PAIRS:
    sym = p.split("/")[0] + "-JPY"
    d = json.loads((cache / f"{sym}-daily.json").read_text())
    bars[p] = [(b["timestamp"], b["close"]) for b in d["bars"]]

def price_on(pair, iso):
    t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
    best = min(bars[pair], key=lambda b: abs(b[0] - t))
    return best[1]

now_price = {p: nav["current"]["positions"][p]["price"] for p in PAIRS}

# 放置A: 全額を円のまま置く
events = [(base_at, base_jpy)] + [(x["at"], x["amountJPY"]) for x in flows]
cash_only = sum(a for _, a in events)

# 放置B: 入れた日に3ペア均等で買って持ちっぱなし
units = {p: 0.0 for p in PAIRS}
for at, amt in events:
    for p in PAIRS:
        units[p] += (amt / 3) / price_on(p, at)
hold_val = sum(units[p] * now_price[p] for p in PAIRS)

print(f"入れた金の合計      ¥{cash_only:>12,.0f}")
for at, amt in events:
    print(f"   {at[:10]}  ¥{amt:>10,.0f}   " + " / ".join(f"{p.split('/')[0]} ¥{price_on(p,at):,.0f}" for p in PAIRS))
print()
print(f"{'現在のアプリ':<20} ¥{now_nav:>12,.0f}   {(now_nav/cash_only-1)*100:+7.2f}%")
print(f"{'放置A 円のまま':<20} ¥{cash_only:>12,.0f}   {0.0:+7.2f}%")
print(f"{'放置B 均等買い持ち':<18} ¥{hold_val:>12,.0f}   {(hold_val/cash_only-1)*100:+7.2f}%")
print()
print(f"アプリ − 円のまま      {(now_nav-cash_only):>+10,.0f}円  ({(now_nav/cash_only-1)*100:+.2f}pt)")
print(f"アプリ − 均等買い持ち  {(now_nav-hold_val):>+10,.0f}円  ({(now_nav/cash_only - hold_val/cash_only)*100:+.2f}pt)")
print()
cr = perf["cryptoReturn"]
print(f"内訳: 確定 ¥{cr['realizedJPY']:+,.0f} / 含み ¥{cr['unrealizedJPY']:+,.0f}")
