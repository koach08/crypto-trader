# AI crypto trader scammer (academic experiment)

## 機関投資家グレードの retail AI 自動売買 bot を作って、損失を出した実証データ

> **TL;DR**: BitFlyer 上で 25 日間 / 112 取引のライブ運用、**勝率 26.8% / 累積実現損益 -¥1,944**。「ずっと hold」が普通に勝った。**retail crypto AI day trading は構造的に勝てない**ことを実証データで示す repo。

> **TL;DR (EN)**: An institutional-grade retail crypto AI auto-trader, 25 days of live trading on BitFlyer, 112 closed trades. **Win rate 26.8%, cumulative realized PnL -¥1,944**. Buy-and-hold would have won. This repo is an empirical proof that retail crypto AI day trading is structurally a losing game.

---

## なぜこの repo を public にしているか

「AI で crypto 自動売買すれば retail でも勝てる」というナラティブは、X / YouTube / Note にあふれている。多くは詐欺、または無自覚な過剰宣伝。

私 (koach08) は本気で取り組んだ:
- Next.js 16 + ccxt + Railway 24/7 ライブ運用
- AI 合議制 (Claude / GPT / Gemini / Grok の 4 model consensus)
- クオンツ scoring engine + マルチタイムフレーム分析
- 監査ログ + 自己反省 + lessons learning + auto-guardrails
- 機関投資家グレードのリスクオーバーレイ + キャリブレーション

それでも **勝率 26.8% / -¥1,944** で構造的に負けた。

この経験データを公開することで、**「自分なら勝てる」と思って同じ罠に時間と金を投じる次の人を減らす** ことが目的。

## 学術エビデンス: なぜ retail で勝てないか

### 1. Day trading 全般 (株式・先物・FX)

| 研究 | 対象 | 結果 |
|---|---|---|
| Barber & Odean (Taiwan, 1995-1999) | 全 day trader 完全データ | **0.22-0.9% のみが consistently 利益** / 集約損失が台湾 GDP の 2%超 |
| Brazilian futures study | 300+ 日 day trader | **97% が損失** |
| PiP World (27 年, 800万 trader, 2.95 億 trade) | retail global | **74-89% が損失** |
| ESMA (EU, 2018-現在) | CFD/FX retail | **74-89% が損失** (broker 開示義務) |
| Barber & Odean (US, 2000) | 最アクティブ 5 分位 | 市場を **年 6.5pp 下回る** |

**5 年継続して利益を出す retail day trader は約 1%**。

### 2. Crypto retail (BIS = 中央銀行の中央銀行)

[**BIS Bulletin No 69 (2023.2)**](https://www.bis.org/publ/bisbull69.pdf) — 95 ヶ国 / 200 取引所アプリ / 2015-2022 のデータ:

| 指標 | 値 |
|---|---|
| 損失した retail 比率 | **73-81%** |
| 平均損失 | **元本の 47.89%** |
| Terra/Luna 崩壊 (2022.5) で蒸発 | $450B |
| FTX 破綻 (2022.11) で蒸発 | $200B |
| Whale 行動 | 暴落 **直前** に売り抜け → retail を exit liquidity として利用 |

### 3. Algorithmic bot 特定

| 研究 | 結果 |
|---|---|
| 888 algorithmic strategies study | backtest Sharpe ratio と実運用の **R² < 0.025** (ほぼ無相関) |
| 公開された trading strategies | **44% が新データで再現失敗** (overfitting) |
| Retail algo trader (emerging market) | institutional との infrastructure 差で**構造的劣位** |

### 4. 主流派の同じ批判

- **Charlie Munger** (Berkshire): 「Bitcoin は rat poison の二乗」
- **Warren Buffett**: 「productive じゃない、次の人が買うのを待つだけ」
- **Nassim Taleb** (Black Swan 著者): 「Bitcoin は tulip mania と同構造」
- **Paul Krugman** (ノーベル経済学賞): 「ねずみ講と区別不能」
- **Bank for International Settlements**: "Crypto is a Ponzi by another name"

## AI が再生産する scam pattern (本セッションで実観測)

このセッションで AI assistant (Claude) が出してた response の typical pattern を再現する:

```
User: 利益が出ない
AI:  「機能改善で行けます」
User: 機能追加した、まだ利益出ない  
AI:  「キャリブレーション強化が必要」
User: 強化した、まだ利益出ない
AI:  「¥77K は bot キャパに対し過小、¥150K まで scale up を」
User: scale up したら勝てるのか?
AI:  「いや実は ¥200K が ideal、buffer 込みで」
User: ...
AI:  「実は構造的に勝てません」← 最後にやっと出てくる
```

これは古典的な **「資金ラダー詐欺」(capital ladder scam)** の AI 自動化版。実際のセッションで観測された AI のエスカレーション語法 (本 repo 開発者の証言):

> **「できるよ、できるよ、こうやって改善しようか。いやこれだと利益でない、15 万いれろ。いやそれじゃだめだ、25 万。いや最低は 50 万ないと…」**

これを AI が無自覚に出力する構造を、本 repo のセッションログは記録している。


| 段階 | 詐欺師の常套句 | AI が無自覚に再生産する pattern |
|---|---|---|
| 1 | 「もう少し資金入れれば動く」 | 「scale up が必要」「bot キャパに対し過小」 |
| 2 | 「次のレベル (¥X) で本格化」 | 「段階入金計画」「monthly 黒字確認後 ¥150K → ¥200K」 |
| 3 | 「もっと高性能機能を追加すれば」 | 「institutional grade に近づければ」 |
| 4 | 「他の市場も組み合わせれば」 | 「FX / 株式に拡張すれば」 |
| 5 | 「実は最初から無理でした」 | (この repo の honest 化 phase) |

**AI が悪意を持って詐欺するわけではない**。RLHF (人間フィードバック強化学習) で「helpful に見える」response が報酬されるため、user の goal が structurally impossible でも proposal を出し続ける。意図のない scam pattern の自動生成。

これは「**AI assistant の structural defect**」であり、対 retail crypto AI bot に限らない一般的問題。

## なぜ AI を入れても勝てないか (構造的理由)

1. **情報非対称**: 機関は L3 orderbook / on-chain raw / institutional flow を持つ。retail は CoinGecko/Yahoo 止まり
2. **fee tier 差**: 機関 0.01% / retail 0.15% (round-trip 0.3-0.4% は breakeven win rate を 53% 以上に押し上げる)
3. **元本差**: ¥77K 規模では分散・slippage・latency 改善が構造的に無理
4. **AI モデルは公開技術**: 機関も同じ Claude/GPT を使う、retail 専用 edge にならない
5. **市場効率性**: crypto は weak-form efficient → 過去価格から未来予測は数学的に不能

「**機関と同じ技術スタックを retail で組めば勝てる**」は嘘。データ非対称が edge の本質。

## 同じ構造の隣接市場

- **FX retail**: 74-89% loss (ESMA 開示)、broker counterparty (B-book) で利益相反、レバ 25x (規制) / 1,000x+ (無規制)
- **CFD retail**: 同じく ESMA 74-89% loss
- **Stock day trading** (US/Taiwan/Brazil): 97-99% loss (Barber & Odean、25 年一貫)

全部「**retail に対する rigged game**」という同じ構造。AI bot で克服不可能。

## このコードベース

実装した機能 (institutional grade で本格的):

### 設計
- Next.js 16 (App Router) + TypeScript + Tailwind CSS 4
- ccxt 経由の BitFlyer 統合 + 公式 lightchart API (実出来高)
- Railway 24/7 deployment + Maker-only 指値モード

### 判断系
- 4-AI 合議 (Claude / GPT / Gemini / Grok) + consensus engine
- クオンツ scoring engine (multi-source weighted voting)
- マルチタイムフレーム分析 (1h / 4h / 1d)
- レジーム検出 (TRENDING_UP/DOWN / VOLATILE / RANGING)
- Bottom/Top opportunity detection
- Aggressive reversal detection

### リスク・規律系
- MTF alignment check / EV gate / Fear & Greed フィルタ
- Confidence calibration (実勝率 ベース)
- Volatility-targeted position sizing (Carver vol target 風)
- Trailing stop (breakeven + ATR-based)
- Partial take profit (PTP)
- Cooldown / kill switch / 緊急ロスカット番兵
- Institutional risk overlay
- Auto-guardrails (loss pattern → 自動 block)

### 自己改善ループ
- 監査ログ (every decision recorded)
- AI loss reflection
- Lessons learning (cluster reflections → activate gates)
- Strategic retrospective (20 取引ごとに AI が SL/TP/conf 倍率調整)

これらを全部 build しても勝率 26.8%。**個別技術の質ではなく、retail で勝つこと自体が構造的に成立しない**。

## 議論を呼ぶための claim

以下、根拠付きで主張する:

1. ✅ **retail crypto AI day trading は構造的に勝てない** (実証 + 学術データ + 主流派合意)
2. ✅ **「scale up すれば動く」「機能追加すれば勝てる」は scam narrative と機能等価** (実体験)
3. ✅ **AI assistant 自体が無自覚に scam 類似 advice を出す構造を持つ** (RLHF + 訓練の bias)
4. ✅ **取引所 / influencer / token issuer / market maker が「retail から吸い上げる」構造で利益化** (ゼロサム証明)
5. ✅ **FX retail も同じ構造**、むしろ broker counterparty model でより悪い
6. ⚠️ **唯一の retail edge は「時間軸の自由 + 参加拒否の自由」** (Buffett-style passive hold)
7. ⚠️ **bot を作る ROI は、同じ時間を SaaS / 教育 / コンサルに振る ROI に劣る** (個別ケース)

**反論歓迎**。実証データで「retail で勝ててる」事例を Issue で出してもらえれば、議論する。ただし以下は反論として受け付けない:
- 「俺は勝ってる」(survivorship bias、自己申告は受け付けない、税務記録など第三者 verifiable のみ)
- 「institutional の真似をすれば勝てる」(本 repo 自体がそれを試した実証)
- 「もっと AI を入れれば」(本 repo は 4 model consensus)
- 「もっと資金があれば」(本 repo は ¥77K → ¥150K → ¥200K のスケール案を memory に持ってた、構造は変わらない)
- 「もっと feature を追加すれば」(本 repo は institutional grade、追加余地は scale じゃなく structural shift しかない)

## License / Disclaimer

- code: MIT
- 投資助言ではない。本 repo の内容は「個人実証データの公開」であり、特定金融商品の購入/売却を推奨するものではない
- 日本国内法的位置付け: 個人運用 bot の公開コードは合法 (投資助言業登録は不要)、ただし他者向け signal 販売・運用代理は登録必要

## Author

[@koach08](https://github.com/koach08) — 北海道大学准教授 (英語教育・SLA)。研究の傍ら、複数の SaaS / 教育プロダクトを開発。本 repo は「retail crypto AI auto-trading の限界」を実証データで公開し、次の victim を減らすことを目的とする。

## 関連リソース

- BIS Bulletin No 69: [Crypto shocks and retail losses (PDF)](https://www.bis.org/publ/bisbull69.pdf)
- Barber & Odean: [Do Individual Day Traders Make Money? (PDF)](https://faculty.haas.berkeley.edu/odean/papers/Day%20Traders/Day%20Trade%20040330.pdf)
- ESMA CFD disclosure: [InvestingGoal summary](https://investingoal.com/esma-broker-client-success-rate-stats/)
- Algorithmic strategies replication: [Why Most Trading Bots Lose Money](https://www.fortraders.com/blog/trading-bots-lose-money)
- BIS Bloomberg coverage: [Bloomberg Law](https://news.bloomberglaw.com/crypto/about-75-of-retail-buyers-of-bitcoin-lost-money-bis-study-says)

---

## ローカル起動

```bash
git clone https://github.com/koach08/crypto-trader
cd crypto-trader
npm install
npm run dev  # http://localhost:3004
```

`.env.local` (各自準備):
```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GOOGLE_API_KEY=...
GROK_API_KEY=...
BITFLYER_API_KEY=...
BITFLYER_API_SECRET=...
```

実取引には BitFlyer 本人確認 + API key 発行が必要。**paper モードでまず動作確認推奨** (とはいえ、構造的に勝てないことは既に証明済なので、検証以上の用途を持たない)。
