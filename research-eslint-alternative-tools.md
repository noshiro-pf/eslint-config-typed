# 高速 TypeScript Linter への移行適性 調査レポート

> 対象: `eslint-config-typed`（主要 ESLint プラグインの設定済み config + 独自カスタムルール実装を提供するライブラリ）
> 目的: ESLint の「flat config の優秀さ」「カスタムルール拡張性」を維持したまま高速化できる**完全上位互換**ツールへの移行可能性の評価
> 作成日: 2026-07-15

---

## 0. 結論（エグゼクティブサマリー）

**2026 年 7 月時点で「完全上位互換」と呼べる単一ツールは存在しない。** 決定打は本ライブラリの構成にある。

- 本ライブラリは 8 個の独自プラグイン・約 40 個のカスタムルールを持つが、**そのうち 22 ルールが型情報を使う type-aware ルール**（`getTypeChecker()` / `getParserServices()` を使用）。しかもこの type-aware 群こそがライブラリの核心的価値（`total-functions/*` の安全性ルール、`ts-data-forge/*` の推論ベース推奨ルール、`ts-restrictions/*`）である。
- **oxlint（＝Vite+ の linter）** は最有力候補で、ESLint 互換 JS プラグイン API・flat config 移行ツール・50〜100倍の速度を備え、**syntactic なカスタムルールは移植可能**。しかし **カスタム type-aware ルールは 2026-07 現在も未サポート**（明示された既知の制約）。→ 22 個の type-aware カスタムルールが今は移植不能。
- **rslint / tsslint / tsl** はカスタム type-aware ルールを書けるが、**既存 ESLint プラグインエコシステムをそのまま動かせない**（＝上位互換ではない）か、実験的段階。
- **VSCode DX を加味すると**: 22 個の type-aware カスタムルールは oxlint ではエディタでもフィードバックが出ない。逆に **tsl / tsslint は tsserver 内で動くため、その領域でむしろ現状 ESLint より優れたリアルタイム体験**を出せる。→ ハイブリッドの型担当は「tsl/tsslint 移植」が DX 上位（ただし移植工数は大）。詳細は §5。
- **TypeScript v7（tsgo）を見据えると結論が動く**: TS7 は tsserver プラグイン API（Strada）を引き継がないため **tsslint は TS7 で非互換（行き止まり）**、tsl も現状 JS の TS API 依存で tsgo 対応は未定。一方 **oxlint（type-aware = tsgolint）と rslint は typescript-go ネイティブ**。→ 型担当の将来の受け皿は「tsslint/tsl 移植」より **native-tsgo 側（oxlint の corsa / rslint）**が本命。詳細は §6。

### 推奨方針

**「oxlint を主軸に据えた段階的ハイブリッド移行」** が現実解。

1. **今すぐ**: 大多数の rule（native 650+ ルール、非 type-aware なプラグイン、syntactic なカスタムルール）を oxlint に寄せて日常の lint を高速化。
2. **当面**: type-aware なカスタムルール（22個）と type-aware な typescript-eslint 系は、oxlint の組み込み type-aware（tsgolint）でカバーできる範囲は oxlint に任せ、**カバーできない独自 type-aware ルールだけ ESLint（または tsl）を CI/pre-commit で併走**させる。
3. **将来（要ウォッチ）**: oxlint のカスタム type-aware ルール API（`corsa-oxlint`、現在 early WIP）が実用化した時点で ESLint を完全撤去。ここが「完全上位互換」達成のトリガー。

> ⚠️ 見落としやすい点: 本ライブラリのもう一つの価値は **「flat config を型付きで書ける」config オーサリング層**（`defineConfig` / `RulesOptions` 型など）。oxlint の設定は `.oxlintrc.json`（JSON）であり、この型付き config 資産はそのままは移行しない。ライブラリのリブランド／再設計が必要になる。

---

## 1. 現状分析 — 本ライブラリが移行先に要求するもの

`src/` の実装から抽出した要件:

| 要件                                    | 実体                                                                                                                                                                                                     | 移行先での必須度           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 主要 ESLint プラグインの設定済み config | typescript-eslint, import, unicorn, react, react-hooks, jsx-a11y, promise, functional, security, n, jest/vitest, playwright/cypress, testing-library, stylistic 等 30+ の rule 集約（`src/rules/*.mts`） | ★★★                        |
| **syntactic カスタムルール**            | 約 18 ルール（`react-coding-style/*`, `tree-shakable/import-star`, `strict-dependencies`, `immer-coding-style`, `no-enums` 等）                                                                          | ★★★                        |
| **type-aware カスタムルール**           | **22 ルール**（下表）                                                                                                                                                                                    | ★★★（核心）                |
| flat config の表現力                    | glob 単位の override、config 合成                                                                                                                                                                        | ★★★                        |
| 型付き config オーサリング              | `defineConfig`, `defineKnownRules`, `RulesOptions` 型                                                                                                                                                    | ★★（ライブラリ固有の価値） |
| auto-fix / suggestion                   | 多くのカスタムルールが fixer 実装あり                                                                                                                                                                    | ★★                         |
| IDE 統合                                | VS Code                                                                                                                                                                                                  | ★★                         |

### 型情報に依存するカスタムルール（22個 = 移行の関門）

`total-functions`（10）: `no-hidden-type-assertions`, `no-nested-fp-ts-effects`, `no-partial-array-reduce`, `no-partial-division`, `no-partial-string-normalize`, `no-partial-url-constructor`, `no-premature-fp-ts-effects`, `no-unsafe-type-assertion`, `require-strict-mode`, `unsafe-assignment-rule`

`ts-data-forge`（8）: `no-unnecessary-type-guard`, `prefer-arr-is-array-at-least-length`, `prefer-arr-is-array-of-length`, `prefer-arr-is-non-empty`, `prefer-arr-sum`, `prefer-canonical-array-slicing`, `prefer-num-safe-parse-float`, `prefer-num-safe-parse-int`

`ts-restrictions`（4）: `check-destructuring-completeness`, `no-unnecessary-array-from`, `no-unnecessary-coalesce-undefined`, `prefer-non-mutating-array-method`

**この 22 ルールを移植できるかどうかが、各ツールの合否を分ける最重要基準。**

---

## 2. 評価軸

1. **ESLint プラグイン互換**（既存 config 群がそのまま動くか）
2. **syntactic カスタムルール**の記述可否
3. **type-aware カスタムルール**の記述可否 ← 最重要
4. **flat config 相当の設定表現力**
5. **速度**
6. **成熟度・後ろ盾・エコシステム**
7. 型付き config オーサリングの引き継ぎ
8. **VSCode 拡張の開発体験（DX）** — リアルタイム診断 / エディタでの type-aware / カスタムルール開発の反復ループ ← ルールライブラリでは特に重要
9. **TypeScript v7（tsgo / typescript-go）前方互換性** — 型情報エンジンが TS7 ネイティブか／将来動くか ← 型 lint の将来性に直結（詳細は §6）

---

## 3. 各ツール評価

### 3.1 oxlint（VoidZero / Oxc）＝ Vite+ の `vp check` / `vite lint` ── 最有力

**位置づけ**: Rust 製。650+ の native ルールを内蔵し、ESLint の 50〜100 倍高速。VoidZero（Evan You 率いる Vite の会社）が開発し、統合ツールチェーン **Vite+ に同梱**（`vp check` サブコマンド）。Framer / Linear / Atlassian / Shopify / Cloudflare 等が採用実績。

> Vite+ は当初（2025-10）有償ライセンスを予定していたが、**2026-03 の alpha で方針転換し MIT で完全 OSS 化**。収益源はデプロイ基盤「Void」に移した。したがって **oxlint / Vite+ にライセンス費用の懸念はない**。

| 軸                            | 評価      | 備考                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ESLint プラグイン互換         | ◎         | **JS Plugins Alpha（2026-03）**。ESLint プラグイン API をほぼ全面実装（ESLint 本体の 33,006 テスト 100% pass）。既存プラグインは「ほぼ無改造で動く」。React hooks / Stylistic / Testing Library / SonarJS 等で検証済み。**「ESLint ユーザーの約 80% はそのまま乗り換え可能」**と公称 |
| syntactic カスタムルール      | ◎         | JS/TS でカスタムルールを記述可。AST traversal・scope・code path・fixer/suggestion・IDE 診断まで対応。ESLint とほぼ同一 API                                                                                                                                                           |
| **type-aware カスタムルール** | ✗（重大） | **未サポート**。ただし typescript-eslint の type-aware ルールは native 実装で内蔵（tsgolint 経由、61 中 59 ルール対応）。実験的な `corsa-oxlint` で独自 type-aware プラグインを書く道はあるが **early WIP**                                                                          |
| flat config 表現力            | ○         | 設定は `.oxlintrc.json`。glob override 可。ただし **JS の flat config ではなく JSON**。`@oxlint/migrate` で eslint.config.js から自動移行                                                                                                                                            |
| 速度                          | ◎         | ESLint 比 50〜100倍。type-aware も tsgolint（typescript-go 上）で「従来 1分 → 10秒未満」。カスタム JS ルールを 1 個入れると overhead が乗るが、それでも ESLint 比 7倍前後を維持                                                                                                      |
| 成熟度・後ろ盾                | ◎         | VoidZero が本体。Midjourney / Preact / PostHog で JS plugin が本番投入済み                                                                                                                                                                                                           |
| 型付き config 引き継ぎ        | △         | JSON 設定のため、本ライブラリの型付き `defineConfig` 資産は直接は活きない                                                                                                                                                                                                            |

**判定**: **完全上位互換ではないが、戦略的に最も近い。** 22 個の type-aware カスタムルール以外は今すぐ移行可能。type-aware カスタムルール API が実用化すれば「完全上位互換」に到達する最有力候補。**移行の主軸に据えるべき。**

**Windows 注意**: JS plugins 使用時に OOM 報告あり。WSL 推奨（本環境は WSL2 なので問題になりにくい）。

---

### 3.2 rslint（web-infra-dev / ByteDance、Rstack ファミリー）

**位置づけ**: typescript-go 製の ESLint 互換 linter。tsgolint（@auvred の PoC）の fork を継続開発。

| 軸                            | 評価 | 備考                                                                                                                                                             |
| ----------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint プラグイン互換         | △    | 「best effort ESLint compatible」。typescript-eslint / ESLint の**主要ルールは内蔵**するが、**任意のサードパーティ ESLint プラグインをそのまま動かす保証はなし** |
| syntactic カスタムルール      | ○    | カスタムルール記述を掲げる                                                                                                                                       |
| **type-aware カスタムルール** | ○    | **AST・型情報・グローバル checker をカスタムルールに公開**（クロスモジュール解析可）。type-aware がデフォルト有効                                                |
| flat config                   | △    | 明言なし                                                                                                                                                         |
| 速度                          | ◎    | 公称 ESLint 比 20〜40倍（未検証）                                                                                                                                |
| 成熟度                        | ✗    | **experimental / pre-1.0**（v0.6.x、★400台）。実運用は時期尚早                                                                                                   |

**判定**: **カスタム type-aware ルールを書ける点は本ライブラリと相性が良い**が、既存 ESLint プラグイン群をそのまま動かせない＝上位互換ではない。かつ実験段階。**要ウォッチだが今は非推奨。** oxlint の type-aware カスタム対応と競争関係にあり、動向を追う価値は高い。

---

### 3.3 tsslint（johnsoncodehk / Volar 作者）

**位置づけ**: tsserver プラグインとして動く「最軽量の意味論 linter」。エディタが既に持つ TypeChecker を再利用し、二重型チェックを回避。**組み込みルールはゼロ**（全部自作前提）。

| 軸                        | 評価                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| ESLint プラグイン互換     | ✗（エコシステム非互換。上位互換ではない）                                                        |
| type-aware カスタムルール | ◎（rule = 関数。TS module / Program / SourceFile / report を受け取る。ディスクキャッシュで高速） |
| 速度                      | ◎（型チェックを二重に走らせない設計）                                                            |
| 成熟度                    | ○                                                                                                |

**判定**: **設計思想は本ライブラリの type-aware カスタムルールと極めて相性が良い**が、ESLint プラグイン資産を捨てることになる。単独移行先にはならない。ただし **「type-aware カスタムルールだけを高速に回す補助エンジン」**としては有力。⚠️ **ただし TypeScript v7（tsgo）とは非互換**（tsserver プラグイン方式に依存し、tsgo は Strada プラグイン API を持たない見込み）。TS7 移行を見据える限り、22 ルールの移植先としては将来性がない。詳細は §6。

---

### 3.4 tsl（ArnaudBarre）

**位置づけ**: `tsc` を拡張した type-aware linter。**oxlint / Biome のような「型を扱えず・カスタムルール API も無い高速 linter」と併用する前提**で設計されている（単独/ESLint 併用も可）。tsslint と歴史を共有。

**判定**: **oxlint とのハイブリッド構成の「型担当」として設計思想が完全に一致。** oxlint（高速な syntactic + 内蔵 type-aware）＋ tsl（独自 type-aware カスタムルール）という組み合わせは、本件の移行戦略の有力な受け皿。⚠️ **ただし TypeScript v7（tsgo）対応は未確定**。現状は JS の TS API（peer dep TS ≥5.8）に依存し、作者も「language service 統合を IPC でどう実現するか調査中／効率化には主要ルールの Go 移植が必要そう」と述べている。tsslint と違い自前で舵を切れる余地はあるが、tsl 移植を選ぶ場合は **tsl 自身の tsgo 対応がトリガー条件**になる。詳細は §6。

---

### 3.5 Biome（参考 — ユーザー既却下）

カスタムルールは GritQL ベースで、**任意の JS/TS カスタムルール（特に型情報を使うもの）を書けない**ため既に却下済み。v2「Biotype」で独自型推論エンジンを積んだが、**カスタム type-aware ルールを書く用途には応えない**。却下は妥当。

---

### 3.6 その他（対象外）

- **deno lint**: カスタムルール（型なし）は書けるが ESLint プラグイン非互換。上位互換でない。
- **quick-lint-js**: 設定・拡張性なし。対象外。
- **TSLint**: 2019 に非推奨。論外。

---

## 4. 比較表

| ツール             | ESLint プラグイン互換 | syntactic カスタム | **type-aware カスタム** | flat config 相当 | 速度  | 成熟度 |             上位互換？              |
| ------------------ | :-------------------: | :----------------: | :---------------------: | :--------------: | :---: | :----: | :---------------------------------: |
| **oxlint / Vite+** |           ◎           |         ◎          |      **✗（WIP）**       |     ○(JSON)      |   ◎   |   ◎    | **ほぼ（type-aware カスタム除く）** |
| rslint             |           △           |         ○          |            ○            |        △         |   ◎   |   ✗    |                  △                  |
| tsslint            |           ✗           |         ○          |            ◎            |        ✗         |   ◎   |   ○    |                  ✗                  |
| tsl                |       併用前提        |         ✗          |            ◎            |        ─         |   ◎   |   ○    |                補助                 |
| Biome              |           ✗           |      △(Grit)       |            ✗            |        ○         |   ◎   |   ◎    |             ✗（却下済）             |
| ESLint（現状）     |           ◎           |         ◎          |            ◎            |        ◎         | ✗遅い |   ◎    |                基準                 |

---

## 5. VSCode 拡張の開発体験（DX）評価

config/ルールライブラリの価値の中心は、CLI 速度だけでなく **「エディタでのリアルタイムフィードバック」と「カスタムルール開発の反復ループ」** にある。特に本ライブラリは型付き・カスタムルール志向なので、この軸は移行可否に直結する。

### DX 比較表

| ツール             | リアルタイム診断 | エディタでの type-aware（内蔵ルール） | **カスタムルールのエディタ反映** | auto-fix on save |  config 補完/検証   | 拡張の成熟度 |
| ------------------ | :--------------: | :-----------------------------------: | :------------------------------: | :--------------: | :-----------------: | :----------: |
| **oxlint / Vite+** |        ◎         |           △（alpha・bug有）           |  syntactic:◎ / **type-aware:✗**  |        ◎         | ○（oxlint設定のみ） |      ◎       |
| tsslint            |        ◎         |            ◎（tsserver内）            |         ◎（type-aware）          |        ◎         |          ○          |      ○       |
| tsl                |        ◎         |            ◎（tsserver内）            |         ◎（type-aware）          |        ○         |          ○          |      ○       |
| rslint             |        ○         |               ○（公称）               |            ○（公称）             |        ○         |          △          |      ✗       |
| Biome              |        ◎         |                   △                   |                ✗                 |        ◎         |          ◎          |      ◎       |
| ESLint（現状）     |        ◎         |        **✗ 遅い**（移行動機）         |        ◎（RuleTester等）         |  △ 大規模で重い  |          ◎          |      ◎       |

### 各ツールのエディタ DX 詳細

**oxlint（Oxc VSCode 拡張 `oxc.oxc-vscode`、9.6万+ installs）**

- `oxlint --lsp`（`oxc_language_server`）による LSP。リアルタイム診断・quick fix・`source.fixAll.oxc` の保存時 fix・マルチルート workspace 対応。`.oxlintrc.json` の **JSON schema 補完/検証あり**（ただし ESLint config は対象外）。
- エディタでの type-aware（内蔵ルール）: **対応（alpha）**。`oxc.typeAware=true` + `oxlint-tsgolint` 導入で有効化。ただし既知バグに注意 — **他ファイルの型変更が反映されない stale 診断**（Issue #19 / #20376）、monorepo で config 検出に失敗する報告あり。
- ⚠️ **本ライブラリにとって最重要**: カスタム type-aware ルールは非対応 → **22 個のカスタムルールはエディタ上でも一切フィードバックが出ない**。一方 syntactic なカスタム JS plugin ルールは LSP 経由でライブ表示され、反復ループは良好。
- カスタムルール開発 DX: JS plugin は alpha 段階。ESLint 互換 API なので RuleTester 的テストパターンは流用しやすいが、周辺ツールの成熟度は ESLint 未満。
- 公式が「CLI とエディタの診断は別物」と明記。ローカル devDependencies に oxlint が必要。

**tsslint / tsl（tsserver プラグイン方式）**

- **type-aware のエディタ DX は最良**。tsserver 内部に同居し、ネイティブ TS エラーと同じ経路で診断を返す → 二重型チェックなし・別プロセスなし・**stale が原理的に起きにくい**（エディタの Program を共有）。本ライブラリの 22 ルールにとって、これは **現状の ESLint より優れた**エディタ体験。
- `tsslint`: 専用 VSCode 拡張あり。`.vue` / `.mdx` / `.astro` 等も framework adapter 経由で対応。
- `tsl`: 単一の TS compiler plugin 方式（エディタ別拡張を作らない）。ただし VSCode で「TypeScript: Select TypeScript Version → Use Workspace Version」の選択が必要、かつ **エディタ統合には config ファイル（`tsl.config.ts`）が必須**という初期設定の一手間。
- カスタムルールは TS で `defineConfig` ベースに型安全に記述でき、本ライブラリの TS-first 思想と親和。ただし typescript-eslint API（`ESLintUtils` / `TSESTree`）からの**書き換えコストは大きい**（生 TS AST・別の report シグネチャ）。
- ESLint プラグインのエコシステムはエディタに出ない（oxlint 拡張と併用する前提）。

**rslint（web-infra-dev）**: 公式 VSCode 拡張で「リアルタイム診断・code action・保存時 auto-fix」を公称。LSP の明記はなし。ただし experimental / pre-1.0 で安定性リスク大。

**ESLint（基準）**: `vscode-eslint` は最も成熟し、`RuleTester`・AST explorer 等カスタムルール開発の周辺が最良。難点は**まさに移行動機そのもの** — エディタでの type-aware が遅く、大規模で Auto Fix on Save が重い。

### DX 観点での重要な示唆（結論の補強）

1. **22 個の type-aware カスタムルールについて、oxlint はエディタでもフィードバックゼロ。** つまり oxlint 単独では「エディタ DX がむしろ後退する領域」が生じる。
2. 一方 **tsl / tsslint はまさにその領域で現状（ESLint）を上回るエディタ DX** を提供できる。→ ハイブリッドの「型担当」は、ESLint 継続併走よりも **tsl / tsslint への移植**の方が、CLI 速度だけでなくエディタ体験でも上回る。
3. **エディタ内共存のきれいさ**: oxlint（独立 LSP）＋ tsl/tsslint（tsserver 内）は診断経路が分離し競合しない。対して oxlint ＋ ESLint は同一ルールの**二重報告ノイズ**が出やすい。→ DX 面でも「oxlint + tsl/tsslint」構成が「oxlint + ESLint」より優れる。
4. **トレードオフ**: ただし tsl/tsslint への 22 ルール移植は API 書き換え工数が大きい。ESLint 併走は書き換えゼロだがエディタ type-aware は遅いまま。**「エディタ DX を取るか、移行コストを取るか」**の意思決定になる。

---

## 6. TypeScript v7（tsgo / typescript-go）との相性評価

> TS 7 = TypeScript コンパイラの **Go ネイティブ移植（コードネーム Project Corsa）**。`tsgo`（`@typescript/native-preview`）として配布され、tsc 比 **7.5〜10 倍**の型チェック速度・大幅な低メモリ・**LSP 内蔵**（`tsgo --lsp`）。本ライブラリの 22 個の type-aware ルールは「型情報エンジン」に強く依存するため、**各ツールが tsgo の上で動くか／将来動けるか**は移行先選定の決定的な軸になる。

### tsgo が linter に与える構造的インパクト

- **最重要**: 従来の JS ベース Language Service / **tsserver プラグイン API（コードネーム Strada）は TS7 に引き継がれない**。tsgo 用の新しいプログラム API は設計中で、2026-07 現在も未完成。→ **「tsserver プラグイン方式で既存の TypeChecker を再利用する」設計のツールは TS7 で原理的に動かなくなる。**
- 逆に、**最初から typescript-go を直接叩くネイティブ Go 実装**（tsgolint / rslint）は、TS7 の恩恵（速度・低メモリ）を最も素直に受ける。tsgo は TS7 世代のアーキテクチャそのもの。
- ESLint / typescript-eslint 系は JS の TS API に依存し続けるため、**プロジェクトの `tsc` を tsgo に置き換えても、型 lint だけは当面「遅い JS 版 TS」を引きずる**構造になる。

### tsgo 相性 比較表

| ツール                              | tsgo との関係                                                                                           | TS7 対応状況                                                                                                                                                                |              相性              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------: |
| **oxlint（type-aware = tsgolint）** | type-aware エンジン **tsgolint が typescript-go 上に構築**。Rust の oxlint 本体が Go の tsgolint を呼ぶ | **すでに tsgo ネイティブ**（内蔵 type-aware は tsgo 上で動作。61 中 59 ルール対応）                                                                                         |        ◎ 前方互換の本命        |
| **rslint**                          | **本体が typescript-go 製**（tsgolint の fork、typescript-go を「コア」に据える）                       | **tsgo ネイティブ**。TS7 世代アーキテクチャそのもの                                                                                                                         |      ◎（ただし実験段階）       |
| **tsl**                             | 現状 `tsc`（JS の TS API、peer dep TS ≥5.8）に依存                                                      | **未対応**。作者は「language service 統合を IPC でどう実現するか調査中／効率化には主要ルールの Go 移植が必要そう」と明言                                                    |    △ 要ポーティング・不透明    |
| **tsslint**                         | **tsserver プラグイン方式**で動作                                                                       | **非互換**。tsgo は Strada プラグイン API を（おそらく恒久的に）持たない。作者自身が「tsgo はそのレベルのプラグイン対応をおそらく持たない」と発言                           |       ✗ TS7 で行き止まり       |
| **ESLint + typescript-eslint**      | JS の TS API 経由で型取得                                                                               | 対応作業中（Issue #10940、Project Service で下地）だが **stable は数ヶ月〜1〜2 メジャー先**。ESLint の async parser 非対応・tsgo の WASM async バインディング・直列化が障壁 | △ 近い将来は非ネイティブのまま |
| **Biome**                           | 独自型推論（Biotype）。TS コンパイラを使わない                                                          | tsgo 無関係（そもそも TS の型を使わない）                                                                                                                                   |          ─（却下済）           |

### 本ライブラリにとっての含意（重要 — §5 の結論を修正する）

1. **tsslint は TS7 で行き止まり。** §5 で「型担当の DX 最良」と評価した tsslint の魅力（tsserver 内で TypeChecker を共有）は、**まさにその tsserver プラグイン依存ゆえに TS7 で失われる**。tsgo 移行を見据えるなら、**22 ルールの移植先として tsslint を選ぶのは将来性の観点で不可**。ユーザー観測（tsslint 非互換）と一致する。
2. **tsl も無条件では選べない。** 現状は JS の TS API 依存で、tsgo 対応は作者も「調査中」。oxlint＋tsl ハイブリッドの「型担当」は、TS7 時代には **tsl 側の tsgo 対応が前提条件**になる。tsslint より自前で舵を切れる余地はある（Go 移植を検討中）が、時期は不透明。
3. **oxlint と rslint だけが「TS7 ネイティブ」。** oxlint の type-aware（tsgolint 経由）と rslint は typescript-go を直接使う。→ **TS7 の到来は oxlint 主軸戦略を強化し、type-aware カスタムルールの将来の受け皿を「tsslint/tsl 移植」から「oxlint のカスタム type-aware API（corsa-oxlint）／ rslint」へと傾ける。**
4. **ESLint 併走の隠れコスト。** 22 ルールを ESLint に残す案（§後述 Phase 2 の (a)）は書き換えゼロで安全だが、**プロジェクトが `tsc`→tsgo に移行しても型 lint だけは JS 版 TS を使い続ける**ため、「全体を native 化しても型 lint がボトルネックとして残る」構図になる点に注意。

### 推奨方針への反映

- **tsgo を前提に置くと、type-aware カスタム 22 ルールの受け皿から「tsslint 移植」は外すべき**（TS7 非互換）。
- 現実的な二択は **(a) 当面 ESLint 併走（型 lint は非ネイティブのまま許容）** か **(b) oxlint の corsa-oxlint / rslint の成熟を待って native-tsgo 側へ一気に寄せる**。DX 重視で tsl 移植を狙う場合も、**tsl 自身の tsgo 対応がトリガー条件**になる。
- 結論として、**「oxlint 主軸 ＋ ESLint を型 lint の当面の受け皿にしつつ、native-tsgo なカスタム type-aware（corsa-oxlint / rslint）の実用化を待つ」**のが、TS7 時代まで見据えた最も筋の良い経路。§5 の DX 評価だけなら tsslint/tsl が魅力的だったが、**tsgo 前方互換性を加味すると tsslint は脱落し、tsl は条件付きになる。**

---

## 7. 推奨移行戦略（段階的ハイブリッド）

### Phase 1 — oxlint 導入・共存（今すぐ着手可）

- `@oxlint/migrate` で既存 flat config を `.oxlintrc.json` へ変換。
- native 650+ ルール＋非 type-aware プラグイン＋ **syntactic カスタムルール（約18個）**を oxlint JS plugin として移植。
- typescript-eslint の type-aware ルールは oxlint の `--type-aware`（tsgolint、59/61 対応）に委譲。
- ESLint はまだ残し、**oxlint = 高速な日常 lint / エディタ、ESLint = フルチェック**の二段構え。

### Phase 2 — type-aware カスタムルールの受け皿を決定

- **22個の type-aware カスタムルール**をどう回すか:
    - (a) ESLint を CI/pre-commit で継続併走（**移行コスト最小・最も安全**。ただしエディタでの type-aware は遅いまま）、または
    - (b) **tsl / tsslint に移植**して ESLint を排除（型チェックの二重実行を避け高速化。**かつエディタ DX は現状より向上**。ただし API 書き換え工数が大きい）。
- **DX を重視するなら (b) が本命**: oxlint（独立 LSP）＋ tsl/tsslint（tsserver 内）はエディタ内で競合せず二重報告も出ない。oxlint＋ESLint 併走はエディタで二重報告ノイズが出やすい。
- ⚠️ **ただし TypeScript v7（tsgo）を見据えると (b) の選択肢は絞られる**（§6）: **tsslint は tsgo 非互換のため移植先から除外**。tsl も tsgo 対応が未定のため、tsl 移植は「tsl の tsgo 対応」を待つ条件付き。→ tsgo 前提では **(a) ESLint 併走で当面しのぎつつ、native-tsgo なカスタム type-aware（corsa-oxlint / rslint）の成熟を待つ**のが手堅い。
- oxlint の内蔵 type-aware で代替可能なもの（例: `no-unnecessary-type-guard` 相当）は oxlint 側に寄せて自作ルールを削減。

### Phase 3 — 完全移行（トリガー待ち）

- oxlint のカスタム type-aware ルール API（`corsa-oxlint`）が stable 化 → 22ルールを oxlint に移植 → **ESLint を完全撤去**。ここで初めて「単一ツールでの上位互換」達成。
- 同時に **rslint** の成熟度も再評価（type-aware カスタムを最初からサポートするため、こちらが先に実用化する可能性もある）。

### ライブラリとしての `eslint-config-typed` の扱い

- 本ライブラリの資産は「rule 集約」だけでなく **型付き config オーサリング**（`defineConfig` / `RulesOptions` 型）にもある。oxlint は JSON 設定なので、この層は自動移行しない。
- 移行後は「**oxlint 用 preset（`.oxlintrc` 生成器）＋ カスタム JS plugin パッケージ**」への**リブランド／再設計**が必要。ライブラリの提供形態そのものが変わる点を要意思決定。

---

## 8. まとめ

- **「完全上位互換の単一ツール」は 2026-07 現在まだ無い。** 唯一の関門は本ライブラリの **22 個の type-aware カスタムルール**。
- **oxlint（Vite+）が最有力**。MIT で無償、ESLint プラグインをほぼ無改造で動かせ、syntactic カスタムルールも書け、速度は圧倒的。エディタ拡張も成熟（9.6万+ installs、LSP・保存時 fix・config 補完）。**唯一足りないのがカスタム type-aware ルール**で、これは公式ロードマップ上の WIP（`corsa-oxlint`）。
- **DX を加味すると結論が一段はっきりする**: 22 ルールは oxlint ではエディタ上でもフィードバックが出ない一方、**tsl / tsslint は tsserver 内で動くため、その領域で現状 ESLint を上回るリアルタイム体験**を出せる。よって「純粋な現在の DX」だけならハイブリッドの型担当は「ESLint 併走」より「tsl/tsslint への移植」が上位。
- **ただし TypeScript v7（tsgo）前方互換性を加味すると結論が動く（§6）**: TS7 は tsserver プラグイン API（Strada）を引き継がないため **tsslint は TS7 非互換（行き止まり）**、tsl も現状 JS の TS API 依存で tsgo 対応は未定。一方 **oxlint（type-aware = tsgolint）と rslint は typescript-go ネイティブ**。→ 将来まで見据えた型担当の受け皿は「tsslint/tsl 移植」ではなく **native-tsgo 側（corsa-oxlint / rslint）**が本命。
- 現実解は **oxlint 主軸 ＋ 当面 ESLint を型 lint の受け皿として併走**させて即座に大幅高速化し、**native-tsgo なカスタム type-aware（oxlint の corsa-oxlint / rslint）の実用化をトリガーに完全移行**するのが最善。DX 最優先で tsl 移植を狙う場合も、tsl 側の tsgo 対応が前提。
- **rslint** はカスタム type-aware を最初から狙い、かつ **typescript-go ネイティブ**な点で TS7 時代に本命化する可能性があり、oxlint と並行してウォッチ推奨。

---

## 参考リンク

- oxlint JS Plugins Alpha: <https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha.html>
- oxlint JS Plugins ガイド: <https://oxc.rs/docs/guide/usage/linter/js-plugins>
- oxlint Type-Aware Linting: <https://oxc.rs/docs/guide/usage/linter/type-aware.html>
- tsgolint（type-aware エンジン）: <https://github.com/oxc-project/tsgolint>
- Announcing Oxlint Type-Aware Linting（VoidZero）: <https://voidzero.dev/posts/announcing-oxlint-type-aware-linting>
- Announcing Vite+（VoidZero）: <https://voidzero.dev/posts/announcing-vite-plus>
- Announcing Vite+ Beta（MIT 化）: <https://voidzero.dev/posts/announcing-vite-plus-beta>
- Vite+ リポジトリ: <https://github.com/voidzero-dev/vite-plus>
- rslint: <https://github.com/web-infra-dev/rslint>
- tsslint: <https://github.com/johnsoncodehk/tsslint>
- tsl: <https://github.com/ArnaudBarre/tsl>
- 型付き linting 比較（Biome vs Oxlint）: <https://www.solberg.is/fast-type-aware-linting>
- Oxc VSCode 拡張（リポジトリ）: <https://github.com/oxc-project/oxc-vscode>
- Oxc VSCode 拡張（Marketplace）: <https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode>
- oxlint エディタ設定ガイド: <https://oxc.rs/docs/guide/usage/linter/editors>
- oxlint type-aware 診断の stale バグ（Issue）: <https://github.com/oxc-project/oxc-vscode/issues/19>
- TSSLint VSCode 拡張（Marketplace）: <https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint>
- TypeScript-Go（TS7 ネイティブ移植・Project Corsa）: <https://github.com/microsoft/typescript-go>
- typescript-eslint「tsgo で型情報を使う」Enhancement Issue #10940: <https://github.com/typescript-eslint/typescript-eslint/issues/10940>
- typescript-eslint/tsgolint（tsgo powered PoC）: <https://github.com/typescript-eslint/tsgolint>
- rslint（typescript-go 製の ESLint 互換 linter）: <https://github.com/web-infra-dev/rslint>
- Rslint 紹介記事（Socket）: <https://socket.dev/blog/rspack-introduces-rslint-a-typescript-first-linter-written-in-go>
- TSSLint 3.0（tsserver プラグイン方式・TS7 非互換の背景）: <https://www.infoq.com/news/2026/02/tsslint-3-release-final/>
