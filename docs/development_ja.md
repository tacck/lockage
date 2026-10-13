# lockage 開発者向けガイド（development）

> English: [development.md](development.md)

このドキュメントは lockage 自体を開発・ビルド・テストする人向けです。利用者向けの導入は [`../README.md`](../README_ja.md)、PR 化（`lockage-publish`）の運用詳細は [`./publishing.md`](./publishing_ja.md) を参照してください。

## セットアップ（clone + build）

lockage 自体を開発する、または公開前のローカル版を使う場合は、リポジトリをクローンしてビルドします。

```bash
git clone <このリポジトリ>
cd lockage
npm install
npm run build      # dist/ に成果物を生成（schema.sql もコピーされる）
```

ビルド済みの `dist/index.js` を `node dist/index.js` で直接起動できます（下の「[起動（開発時）](#起動開発時)」を参照）。

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run build` | TypeScript をコンパイルし `dist/` を生成 |
| `npm run dev` | `tsx` でサーバを直接起動（ビルド不要） |
| `npm test` | 全テストを実行（ユニット + e2e。事前に自動ビルド） |
| `npm run test:unit` | ユニットテストのみ（e2e を除外、ビルド不要） |
| `npm run test:e2e` | 2クライアント e2e のみ（事前に自動ビルド） |
| `npm run typecheck` | 型チェックのみ |

## 起動（開発時）

stdio トランスポートの MCP サーバとして起動します。

```bash
# ビルド済みを起動
node dist/index.js

# または開発中（ビルド不要）
npm run dev
```

- DB の保存先は環境変数 `LOCKAGE_DB` で指定できます（既定 `~/.lockage/lockage.sqlite`）。横断台帳はグローバルに 1 つという前提のホーム絶対パスです。親ディレクトリは自動作成されます。
- 公開するツールの組は環境変数 `LOCKAGE_TOOLSETS` で選べます（既定はエージェント向けの `core` だけ。README の「提供ツール」を参照）。知らない組の名前を書くと起動に失敗します。
- 標準出力は JSON-RPC 専用です。起動ログやエラーは標準エラー出力に出ます。
- **lockage プラグインを入れたまま lockage 自身を開発するとき**（このリポジトリかその worktree で Claude Code のセッションを開いたとき）は、
  プラグインの `npx -y lockage`（MCP サーバとフックの両方）が、npm 公開物ではなくこの作業ツリーの `dist/` に解決されます。
  カレントのプロジェクト自身のパッケージ名が `lockage` だからです（npm 11.19.0 と Claude Code 2.1.285 で確認）。セッションを始める前に、
  その作業ツリーで `npm run build` を済ませてください。`dist/` が無いとサーバは起動せず、古いビルドなら古いコードが動きます。
  動いているサーバは起動時のコードのまま動き続け、フックは呼ばれるたびにその時点の `dist/` を読みます。そのため、セッション中にビルドし直すと
  （`npm test` が `pretest` で行うビルドも含む）、フックは新しいコードで、MCP ツールは古いコードで動きます。セッションを始め直すのは、
  サーバ（MCP ツール）の変更をそのセッションで試したいときだけで足ります。`npm run build` は `dist/` を消しません。消すのは `prepublishOnly`
  （`rm -rf dist`）だけで、それが終わるまではフックが失敗します。

MCP クライアントへの登録手順（利用者向け）は README の [MCP クライアントへの登録](../README_ja.md#mcp-クライアントへの登録) を参照してください。

## テスト

`node:test` を使い、追加の依存なしでテストできます。

```bash
npm test            # ユニット + e2e をまとめて実行（事前に自動ビルド）
npm run test:unit   # ユニットのみ（ビルド不要・高速。協調ロジックを個別検証）
npm run test:e2e    # 2クライアント e2e のみ（事前に自動ビルド）
```

- **ユニット**（`test/*.test.ts` の e2e 以外）: `claim` / `worktree` / `globs` / `files` / `merge` / `board` / サーバ疎通を個別に検証します。worktree・マージゲート系は一時 git リポジトリを作って実際の `git worktree` / マージを走らせます。
- **e2e**（`test/e2e.test.ts`）: ビルド済みの `dist/index.js` を **別プロセスの MCP サーバとして 2 つ起動**し（エージェント A / B）、両者を **同一の `LOCKAGE_DB` ファイル**に向けて、実運用に近い構成で協調動作を検証します。InMemory ではなく実 stdio トランスポート + 実ファイル DB + 実 git worktree を使います。次の 1 本の流れで、本システムの差別化点をそのまま確認します:

  1. A がタスクを作成し、**B（別プロセス）から見える**（＝ DB 共有）
  2. A の claim 成立 → **B の claim は `conflict`**（＝ 二重 claim を CAS で物理拒否）
  3. A が worktree を割り当て（＝ 実 `git worktree` による物理隔離）
  4. A が dirty 公開 → **B が同一ファイルを dirty 公開すると overlap 警告**（＝ warn-never-block）
  5. B が `wait_for_unblock` で待機中に A が `post_board` → **B が `woke_by:"board"` で復帰**（＝ A2A wake）

  `test:e2e` は `dist/index.js` を起動するため、ビルドが前提です（`pretest:e2e` で自動的にビルドされます）。一時ファイルは `KIROCREW_SCRATCH`（未設定時は OS の一時ディレクトリ）に作り、終了時に削除します。

## プロジェクト構成

```
lockage/
├── src/
│   ├── index.ts          MCP サーバ本体（stdio + 全ツール登録）
│   ├── db/
│   │   ├── schema.sql     SQLite スキーマ（テーブル12 + FTS5 1）
│   │   └── index.ts       DB 接続・PRAGMA・スキーマ冪等適用
│   └── lockage/          協調ロジック
│       ├── claim.ts       原子 CAS claim / lease sweep / heartbeat
│       ├── worktree.ts    git worktree 自動割当・解放
│       ├── globs.ts       glob 交差判定（advisory は近似・マージゲートは厳密）
│       ├── files.ts       advisory claim_files / dirty set
│       ├── merge.ts       統合マージゲート（直列化 + 3-way プレチェック）
│       ├── board.ts       共有ボード + A2A wake（long-poll）
│       └── git.ts         git ラッパ / base ブランチ解決
│   └── launcher/         publish ツール(コアを import せず MCP client で叩く)
│       ├── client.ts      Lockage を stdio MCP client で叩く薄い callTool ラッパ
│       ├── publish-adapter.ts  publish 抽象(PublishAdapter / Github / Gitlab stub)
│       ├── publish.ts     publishReadyTickets / reconcileMergedPrs(ticket_ready→PR→掃除)
│       └── publish-cli.ts lockage-publish エントリ
├── plugins/              各クライアントのプラグイン（それぞれが単体で完結したプラグインのルート）
│   ├── shared/            正本（AGENTS.md・lockage-workflow スキル・フックの共通判定）。npm run sync:plugins で各プラグインへコピーする
│   ├── claude/            Claude Code プラグイン（MCP サーバ定義の .mcp.json・フック・lockage-worker エージェント）
│   ├── antigravity/       Antigravity プラグイン（フック）
│   └── kiro/              Kiro Power（POWER.md・steering・mcp.json の雛形・hook の雛形）
├── scripts/sync-plugins.ts  plugins/shared/ の正本を各プラグインへコピーする（--check でずれを検出）
├── .claude-plugin/       Claude Code のマーケットプレイス（plugins/claude を指す）
└── test/                 node:test によるテスト群
```

## 設計補足（blocked 中断ライフサイクル）

blocked 中断は「`block_task`（claim 保持の無期限中断）→ `resume_task`（同一 agent 再開）/ `handoff_task`（別 worker へ worktree 単位の一括移管、人間明示時のみ）/ `release_task(abandoned)`（中止）」の 3 経路。孤児は `list_tasks(status:"blocked")` で可視化（自動回収しない）。handoff 成功時は `post_board(kind:"handoff")` + wake で引き継ぎ先を起こします。
