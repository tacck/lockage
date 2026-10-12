# lockage の PR 化運用（publishing — `lockage-publish`）

> English: [publishing.md](publishing.md)

このドキュメントは、`ticket_ready` を拾って統合ブランチを push し PR 化する別 bin `lockage-publish` の運用詳細をまとめたものです。利用者向けの概要は [`../README.md`](../README_ja.md)、lockage 自体を開発・ビルド・テストする方法は [`./development.md`](./development_ja.md) を参照してください。

## 概要

`ticket_ready`（チケット配下の全タスクが統合ブランチに集約済み）を受けて、統合ブランチをリモートに push し PR を作成する 1-shot コマンドです。マージ済み PR の統合ブランチ掃除（`reconcile`）も担います。**「コアは publish しない」**ため本体（`lockage` MCP サーバ）とは別 bin で、認証は `gh`/`glab` の既存ログインに委ねます（lockage はトークンを持ちません）。

## コマンド例

```bash
# 未処理の ticket_ready を publish し、マージ済み PR を掃除する(全件 sweep=保険経路の起動)
lockage-publish --repo-path /abs/path/to/repo

# publish だけ / reconcile だけ / 特定チケットだけ
lockage-publish --repo-path /abs/repo --mode publish
lockage-publish --repo-path /abs/repo --mode reconcile
lockage-publish --repo-path /abs/repo --ticket 01H...
```

## `--mode` の説明（both / publish / reconcile）

- `--mode both`（既定）= publish → reconcile を順に実行。`--ticket` 限定で叩く主経路でも、既定の `both` なら
  reconcile まで走るので、マージ済み PR の掃除・チケットの close が同じ 1 回で行われる。`reconcile` が担うのは
  **①リモート/ローカル統合ブランチ削除 → ②`clear_integration_branch`（`integration_branch` の NULL 戻し）→
  ③`close_ticket_on_merge` でチケットを `closed` にする（マージ済みの仕事を `list_tickets(status:"open")` に残さない。
  `clear_integration_branch` と同じく version を上げない system 操作なので、人間の並行編集と version を争わない）→
  ④`pr_merged` の投稿 → ⑤チケット配下の done タスク worktree 解放（`release_ticket_worktrees`）**（冪等の真実源）。
  `--base`（省略時 `main`/`master`/`develop` を実在から推定）、`--provider github|gitlab`
  （origin host から自動判定）。未 done タスクが残るチケットは `skipped_unmerged_tasks` としてブランチも worktree も守り、worktree 解放は行いません。未コミット変更が残る worktree は解放されず active で残ります。

## 冪等

board の `pr_opened`／`pr_merged` を真実源に、二重 PR を作らず、掃除も 1 回だけ。`gh pr create` が「既に PR あり」で落ちても既存 PR に畳み、「差分なし」は skip、想定外エラーは当該チケットだけ `failed` にしてバッチは継続します。

## 前提

publisher は worker と同一ホスト・同一 repo パス（統合ブランチがローカルに実在）。ローカルに無い統合ブランチは push せず skip します。

## 駆動

`lockage-publish --repo-path <abs>` は常駐せず 1-shot です。エージェント（または調整役）が、タスクを done にした後やセッション終了時に `publisher_status` を見て起動します（下記「エージェントが lockage-publish を叩くタイミング」）。1 回走るたびに未処理の ticket_ready を PR 化し、マージ済みを掃除します。チケット単位の `failed` があれば exit code 1。

### 同時起動の安全性

複数のエージェントが同時に起動しても、publisher はチケット単位の advisory lock で直列化します。他プロセスが処理中のチケットは `skipped`（`reason:"locked"`）としてスキップされ、別チケットはブロックされません。二重 PR は board の `pr_opened`/`pr_merged` を真実源にした冪等でも防がれます。

### PATH 通し（`lockage-publish` のインストール）

`lockage-publish` を PATH から直接叩けるようにするには、次のいずれかを使います。

```bash
# このリポジトリをクローンしたディレクトリで（開発中・ローカル運用向け）
npm run build
npm link            # lockage-publish を PATH に通す

# もしくはグローバルインストール
npm install -g .
```

PATH を汚したくない場合は、ビルド済みエントリを絶対パスで直叩きしても構いません。

```bash
node /abs/path/to/lockage/dist/launcher/publish-cli.js --repo-path /abs/repo
```

### エージェントが `lockage-publish` を叩くタイミング

publisher は 1-shot コマンドで常駐しません。cron による定期起動は不要で、代わりに**エージェント（または調整役）が次の二段構えで起動**します。

- **主経路（最後の `task_done` 後）**: あるチケットの最後のタスクを `task_done` にしたエージェントが、`publisher_status` を読んでそのチケットが `pending_tickets` に含まれる（`pending_count>=1`）ことを確認し、自チケット限定で起動します。`--mode` は付けず既定の `both` で叩くこと（publish に続けて reconcile まで走る）。

  ```bash
  lockage-publish --repo-path /abs/repo --ticket <ticket_id>   # --mode 省略＝既定 both
  ```

- **保険（セッション終了時）**: 各エージェントがセッションを終える前に `publisher_status` を読む。
  - `pending_count>0`（PR 化待ちが残っている）なら `--ticket` を付けずに 1 回だけ全件 sweep します（既定 `both`）。他エージェントの取りこぼしもまとめて拾えます。

    ```bash
    lockage-publish --repo-path /abs/repo
    ```

  - `awaiting_merge_count>0`（PR は作ったがマージ済みの回収が済んでいない＝掃除待ち）なら `--mode reconcile` で 1 回だけ回収します。マージ済み PR の統合ブランチ掃除とチケットの `close` がまとめて行われます。

    ```bash
    lockage-publish --repo-path /abs/repo --mode reconcile
    ```

> `--mode publish` 単独では叩かないでください。reconcile が走らず、マージ済み PR の後片付け（統合ブランチ掃除・`integration_branch` の NULL 戻し・チケットの `close`・`pr_merged` の投稿）が行われないため、マージ済みのチケットが `open` のまま溜まり続けます（既定の `both` なら主経路でも毎回 reconcile まで走ります）。

これで `ticket_ready` が溜まり次第 PR 化され、マージ済みは掃除され、対応するチケットも `closed` になります。複数エージェントが同時に叩いてもチケット単位の advisory lock で直列化され、処理中のチケットは `skipped`（`reason:"locked"`）としてスキップされるため二重処理されません。

## 運用上の重大注意

> ⚠️ **運用上の重大注意**: `ticket_ready` が board に出ても、誰かが `lockage-publish` を起動しなければ PR は作られません。全タスクが `done` になっても統合ブランチは push されず、PR 化待ちのまま溜まり続けます。エージェント主導の運用では、**各エージェントが「同一チケットの最後のタスクを `task_done` にした直後」と「セッション終了時」に `publisher_status` を見て publisher を駆動する**ことで溜まりを防ぎます（正本 [`../plugins/shared/AGENTS.md`](../plugins/shared/AGENTS.md) の二段構え: 主経路＝`--ticket` 限定、保険＝全件 sweep）。滞留は `publisher_status` ツールで観測でき、未処理件数は `pending_count`／`pending_update_count`、マージ済みの回収待ち（PR は作ったがまだ掃除・close していない）件数は `awaiting_merge_count`、最終の PR 化・マージ痕跡は `last_pr_opened_at`／`last_pr_merged_at` で確認できます。`awaiting_merge_count>0` のときは `lockage-publish --mode reconcile`（または既定 `both`）を叩いてマージ済み PR を回収します（これで対応するチケットも `closed` になります）。

## 解放漏れ worktree（`list_worktrees` stale）

> ⚠️ **dirty で解放されず active に残る worktree（解放漏れ）について**: 未コミットの追跡差分が残る worktree は、`release_worktree`／`release_ticket_worktrees` が `--force` を使わずデータ保護を優先するため、`git worktree remove` が拒否されて解放されず **台帳では `active` のまま残ります**（成果を取り違えて消さないための意図的な設計で、`reason` に `dirty`／`untracked` が返ります）。さらに reconcile は `pr_merged` を投稿済みのチケットを再処理しないので、こうして active 残りした worktree は **自動では回収されません**（孤児化はしないが自動リトライも掛からない非対称）。この解放漏れ候補は `list_worktrees(stale:true)`（done タスクに紐づくのに active で残る worktree を一覧。`ticket_id`／`agent_id` で絞り込み可）で観測できます。回収するには、残っている差分を退避（コミット／`git stash`／破棄）してから `release_worktree` を呼んでください（台帳では `active` のままなので、孤児だけを扱う `reclaim_orphan_worktrees` では回収できません）。

## 認証前提

PR の作成・push は `gh`／`glab` の既存ログイン（`gh auth login` 済み）に委ねます。lockage 自体はトークンを持たないため、publisher を動かすホストで事前に `gh`／`glab` へログインしておいてください。起動するエージェント／調整役の実行ユーザーのログイン状態が使われます。

## 同一ホスト運用の注意

publisher は worker と**同一ホスト・同一 repo パス**で動かしてください。PR 化対象の統合ブランチがローカルに実在する必要があり、別ホストで動かすと統合ブランチが見つからず `branch_not_local` として skip されます。
