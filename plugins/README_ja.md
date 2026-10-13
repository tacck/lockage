# lockage プラグイン（plugins/）

> English: [README.md](README.md)

lockage の協調ルール（`AGENTS.md`）と lockage-workflow スキルを、各 AI クライアントのプラグインとして配る。
Claude Code・Antigravity はプラグインで入れると、導入先リポジトリには何も置かずに lockage を使える。
Kiro は Power の登録に加えて、導入先の `.kiro/hooks/` への hook の雛形の配置が要る（下の「Kiro（Power）」）。
Claude Code・Antigravity のプラグインは lockage MCP サーバの定義（`.mcp.json` / `mcp_config.json`）も同梱しているので、プラグインを入れればサーバも登録される。
Kiro では、lockage MCP サーバの登録が別に要る。

## 構成

| ディレクトリ | 役割 |
|---|---|
| `shared/` | **正本。** `AGENTS.md`・`skills/lockage-workflow/SKILL.md`。どのクライアントからも直接は読ませない。フックの判定ロジックは `src/hook/` の TypeScript 実装に移植済みで、各クライアントは `npx -y lockage hook ...` で起動する。 |
| `claude/` | **Claude Code プラグインのルート。** `.claude-plugin/plugin.json`・`.mcp.json`（MCP サーバの定義）・`hooks/hooks.json`・`agents/lockage-worker.md`。マーケットプレイスはリポジトリ直下の `.claude-plugin/marketplace.json`。 |
| `antigravity/` | **Antigravity プラグインのルート。** `plugin.json`・`mcp_config.json`（MCP サーバの定義）・`hooks.json`。 |
| `kiro/` | **Kiro Power のルート**（`POWER.md` 形式）。`POWER.md`・`mcp.json` の雛形・`steering/`（`AGENTS.md` と lockage-workflow スキルのコピーを含む）・`hooks/`（`.kiro/hooks/` へ置く雛形）。 |

各クライアントはインストール時にプラグインのディレクトリだけをコピーして読むので、プラグインの外（`../shared` など）は参照できない。
そのため `claude/`・`antigravity/`・`kiro/` は、それぞれに要るものを自分のディレクトリの中に持たせている。
hook の判定ロジックは `src/hook/` の TypeScript 実装に移植済みで、どのクライアントも hook 入口を
`npx -y lockage hook <session|guard> --client <name> ...` に揃えている（各プラグインが持つのは hook 定義ファイルだけ。下の各クライアントの節）。

### 正本とコピー

用語: **正本**は `shared/` の中のファイル（`AGENTS.md`・`skills/lockage-workflow/SKILL.md`）。**コピー**は、正本を各プラグインに配ったもの。
**本体**は、導入先リポジトリに置いた `AGENTS.md`（置いてあれば、そのリポジトリでは同梱のコピーより優先する）。

`shared/` の正本は、各プラグインへコピーして配る。どこへ何を配るかは
[`../scripts/sync-plugins.ts`](../scripts/sync-plugins.ts) の `COPIES` にある。

- **コピーを直接直さない。** `shared/` の正本を直し、`npm run sync:plugins` でコピーを揃える。
- コピーが正本とずれていると `npm test`（`test/plugins.test.ts`）が失敗する。`npm run sync:plugins -- --check` でも確かめられる。
- 配ったコピーの一覧は `plugins/.sync-manifest` に残る。`COPIES` から外したり名前を変えたりすると、次の `npm run sync:plugins` が前回配った残骸を消す。
- 各プラグインに残るのは、クライアントごとの入出力の違いだけである。フックの応答の形はクライアントごとに違う
  （Claude Code は `permissionDecision: "ask"`、Antigravity は `force_ask` / `ask`、Kiro は exit 2 での拒否）ので、共通化しない。

### version

`plugins/claude/` か `plugins/antigravity/` の中身が変わる PR（`shared/` の正本を直してコピーが変わる場合を含む）では、
`claude/.claude-plugin/plugin.json` と `antigravity/plugin.json` の `version` を**同じ値に**上げ、`package.json`（と `package-lock.json`）も同じ値にする。
プラグインは npm パッケージを版を固定しない `npx -y lockage` で起動するので、プラグインと npm パッケージで 1 つの version 番号を使えば、
報告された version から両方を特定できる。PR をマージしたら、その version を npm に publish する。
`plugins/README.md` や `plugins/kiro/` だけの変更では上げなくてよい。Claude Code は version ごとにキャッシュを作るので、
上げ忘れると `plugin update` が更新なしと判断して利用者に届かないおそれがある（`plugin update` が何を見て
更新の有無を判断するかは未確認）。テストが確かめるのはこれらの version が揃っていることだけで、上げ忘れは検出しない。
Kiro の `POWER.md` 形式には version が無い（以前置いていた `.claude-plugin/plugin.json` は Kiro に読まれていなかったので消した）。

### テスト

lockage のリポジトリのルートで実行する。hook のロジックは `test/hook-logic.test.ts`・`test/hook-cli.test.ts` が、
配布物の整合は `test/plugins.test.ts` が検証する（いずれも `npm test` に含まれる）。

```bash
npm test
```

## Claude Code

```bash
claude plugin marketplace add <lockage のリポジトリのパス>
claude plugin install lockage@lockage
```

リポジトリを GitHub で公開すれば、パスの代わりに `claude plugin marketplace add tacck/lockage` で登録できる
（マーケットプレイスの `source` はリポジトリ内の相対パス `./plugins/claude` なので、GitHub から登録しても同じプラグインを指す）。
非公開のうちは、git で clone できる認証がある人だけが登録できる。

- インストール時に `plugins/claude/` の中身がキャッシュ（`~/.claude/plugins/cache/lockage/lockage/<version>/`）へ
  **コピーされ、そのコピーが読み込まれる**（2026-10 に実機で確認。`~/.claude/plugins/installed_plugins.json` の
  `installPath` がこのパスを指す）。そのため、lockage のリポジトリを更新しても、インストール済みのプラグインには自動では反映されない。
- **更新を取り込む**: `marketplace add` で登録したパス（`~/.claude/plugins/known_marketplaces.json` の `lockage` の
  `source.path` で確かめられる）で main を最新にしてから、次を実行し、新しいセッションを始める。
  登録したパスで別のブランチを開いていると、そのブランチの中身が入るので、先に main に切り替える。
  GitHub から登録した場合は、`git` の 2 行は要らない。

  ```bash
  git -C <登録したパス> switch main
  git -C <登録したパス> pull
  claude plugin marketplace update lockage
  claude plugin update lockage@lockage
  ```

  取り込めたかは、`~/.claude/plugins/installed_plugins.json` の `lockage@lockage` の `version` と、`installPath` の
  末尾（`.../<version>`）が、`plugins/claude/.claude-plugin/plugin.json` の `version` と一致することで確かめる。
  古い version のままなら、次を疑う。
  - lockage 側で `version` が上がっていない（上げ忘れ）
  - 登録したパスが最新の main になっていない
  - `claude plugin marketplace update` を実行していない、またはどちらかのコマンドがエラーで終わっている
  - 新しいセッションを始めていない
- 開発中に手元の変更を試すときは、インストールせずに `claude --plugin-dir <lockage のリポジトリのパス>/plugins/claude` で
  起動すると、その場の `plugins/claude/` が読み込まれる（version を上げる必要はない）。`shared/` を直したら、先に
  `npm run sync:plugins` を実行する。インストール済みのプラグインと同時に読み込むと同じものが 2 つ並ぶおそれがある（未確認）ので、
  試す間は止めておき、終わったら必ず戻す。止めたままにすると、以後のセッションでフック（本流ツリー編集の確認など）が黙って無効になる。

  ```bash
  claude plugin disable lockage@lockage   # 試す前
  claude plugin enable lockage@lockage    # 試し終えたら
  ```
- マニフェストの検証: `claude plugin validate plugins/claude` と `claude plugin validate .`（マーケットプレイス）。
- 導入先リポジトリの `AGENTS.md` に lockage の節がある場合は、それがそのリポジトリの本体になり、同梱版より優先する。
  Kiro など他のクライアントのために置いているなら**消さずに残し**、正本の `plugins/shared/AGENTS.md` が更新されたら同じ内容に保つ
  （古いままだと、プラグインを入れた Claude Code も古い手順で動く）。
  Claude Code だけで使うリポジトリなら、置かずに同梱版に任せるほうが更新の手間が無い。
- フックは `npx -y lockage hook <session|guard> --client claude ...` で起動する。
  `npx` が npm 公開物を取得して起動するので、clone も `npm run build` も要らない（初回は取得に時間がかかることがある）。
  要件は Node.js `>= 22.5` と git 2.31 以上。git が 2.31 未満だと、リポジトリの判定を諦めて何もせずに通る。
- 本流ツリー編集の確認（PreToolUse）は、lockage 運用中のリポジトリでだけ出す。「運用中」は、本体リポジトリに
  `lockage/` 配下のブランチ・`.lockage-worktrees/` 配下の worktree・`.lockage/` のいずれかがあることで判定するので、
  一度 task_done したリポジトリは、本体の `.lockage/` に記録が残り（reconcile でも消えない）、以後ずっと運用中と判定される。
  運用中でも確認はセッションごとに許可するまでの 1 回なので、lockage を使わないリポジトリで確認を止めたいときは
  `LOCKAGE_GUARD_DISABLE=1` を使う。
  Edit / Write / MultiEdit / NotebookEdit だけを見ており、Bash 経由の書き込み（`sed -i` やリダイレクト）は確認しない。
- 確認は**許可されるまで**出す。許可して編集が実際に行われると（PostToolUse で記録）、そのセッションでは
  同じリポジトリについて以降は聞かない。拒否した場合は、次の本流ツリーの編集でも改めて聞く。
  一時的に止めるには環境変数 `LOCKAGE_GUARD_DISABLE=1` を設定する。
- `claude -p` などの非対話実行では、確認に答える人がいないため編集は拒否として扱われうる。
  拒否された編集は記録されないので、その場合は本流ツリーの編集が毎回止まる
  （非対話実行で確認がどう扱われるかは Claude Code の権限設定に依存するので、ヘッドレスのワーカーで使う前に確かめること）。
- プラグインは lockage MCP サーバの定義を `plugins/claude/.mcp.json` に同梱しており、npm 公開物を `npx -y lockage` で起動する
  （フックと同じ）。プラグインを入れればサーバも登録されるので、別途 `claude mcp add` する必要はない。
  バージョンは固定していない。動くのは起動時に npx が解決した lockage の公開物（npx のキャッシュにある版のこともあり、最新とは限らない）で、
  プラグインの `version` とは連動しない。
  `/mcp` には `plugin:lockage:lockage` として出て、ツール名は `mcp__plugin_lockage_lockage__*` になる（手で登録したサーバでは `mcp__lockage__*`）。
  自分の `permissions.allow` やフックの `matcher` に lockage のツールを `mcp__lockage__...` で書いているなら、移行時に `mcp__plugin_lockage_lockage__...` へ書き換える
  （同梱の AGENTS.md とスキルは `claim_task` のような素のツール名で書いているので、直す必要はない）。
- **以前に手でサーバを登録していた場合**（`claude mcp add lockage ...`）は、`claude mcp remove lockage -s user` で外す
  （プロジェクトごとに登録していたなら、そこで `-s local` / `-s project`）。
  その登録に `env`（特に `LOCKAGE_DB`）を書いていたなら、外す前に `claude mcp get lockage` で確かめ、設定ファイルの `env` に移しておく。
  移さずに外すと台帳が黙って既定に戻り、このクライアントだけほかのエージェントのタスクが見えなくなる。
  移す先は登録のスコープに合わせる。`-s user` なら `~/.claude/settings.json`、
  `-s local` ならそのプロジェクトの `.claude/settings.local.json`、`-s project` ならそのプロジェクトの `.claude/settings.json`
  （`-s project` の登録はチームで共有する `.mcp.json` にあるので、外すとチーム全員に効く。同じコミットで共有の `.claude/settings.json` に
  値を移さないと、ほかのメンバーが黙って既定の台帳に戻る）。
  迷ったら `~/.claude/settings.json` にする。全エージェントで 1 つの台帳を共有するので、ユーザー全体で 1 つの値にするのが普通の使い方である。
  Claude Code はコマンドが同じ MCP サーバを 1 つにまとめる。
  手で登録したものが同じコマンド（`npx -y lockage`）なら、名前や `env` が違っても手で登録したほうだけが残る。
  コマンドが違う（`node <clone>/dist/index.js` など）と両方が登録され、lockage サーバが 2 つ並ぶ。
- 同梱の定義は `env` を持たないので、台帳は既定の `~/.lockage/lockage.sqlite` になる。別の場所に置くときは、
  Claude Code の設定ファイル（スコープは上の項目を参照）の `env`、または Claude Code を起動するシェルの環境変数に `LOCKAGE_DB` を設定する。サーバはそれを引き継ぐ。
  全エージェントで同じ台帳を指すこと。
- 実機で確認したこと（Claude Code 2.1.285、2026-10-13、`--plugin-dir` でプラグインを読み込んで確認）: 上のサーバ名とツール名。
  コマンドが同じサーバが上のとおり 1 つにまとめられ、手で登録したほうが残ること。シェルの環境変数か、設定の `env`（`--settings` で指定したもの、
  プロジェクトの `.claude/settings.json` と `.claude/settings.local.json`）に置いた `LOCKAGE_DB` が同梱のサーバに届くこと（そのパスに DB ファイルが作られた）。
  `~/.claude/settings.json` そのものは、利用者自身の設定を変えないよう試していない。
- `lockage-publish` は別のコマンドで、`LOCKAGE_DB` を MCP サーバからではなく、実行した環境から読む。
  台帳を既定以外に置いたときは、実行する場所で `--db` を付ける（またはシェルの環境変数 `LOCKAGE_DB` を設定する）。
  特に Claude Code の外の端末には `settings.json` の `env` が無い
  （同じ台帳を見せないと、PR 化待ちのチケットがあっても `published: []` になる）。
- 以前の手順で `~/.claude/skills/lockage-workflow/` に置いたスキルは、プラグインのスキルと重複するので削除する。
- 動作確認: 新しいセッションの最初に「lockage 協調開発（lockage プラグイン）」の文脈が注入されること、
  `/mcp` に `plugin:lockage:lockage` が接続済みで出ることを確かめる。注入が出なければ `npx` が lockage を解決できているか、git リポジトリの外で起動していないかを確かめる。
  `/mcp` で `plugin:lockage:lockage` が `failed` なら、lockage のリポジトリの外のディレクトリで、端末からサーバそのものを 1 回起動する
  （リポジトリの中では、npx が公開物ではなく作業ツリーの `dist/` を起動するため）。設定の `env` に lockage 用の変数（`LOCKAGE_DB`、置いていれば `LOCKAGE_TOOLSETS`）を置いているなら、同じ値を付ける:
  `LOCKAGE_DB=<その値> npx -y lockage </dev/null`。標準エラー出力に `[lockage] ready (db=..., toolsets=...)` が出て、標準入力が閉じたところで
  exit 0 で終われば、npx はサーバを取得・起動できている。`[lockage] fatal: ...` が出るか exit 0 以外で終わったら、それが失敗の理由である
  （ネットワーク、レジストリ、Node.js `>= 22.5`、DB の場所に書き込めない、`LOCKAGE_TOOLSETS` が不正など）。確かめたら新しいセッションを始める。npx のキャッシュが空の状態からの
  初回起動は、実機（2026-10-13）では約 6 秒で接続でき、Claude Code の MCP 起動タイムアウトに収まった。遅い回線では環境変数 `MCP_TIMEOUT`（ミリ秒）で延ばす。

**lockage-worker（サブエージェント）の使い方**: メインセッションが Agent ツールで起動する。
- 渡すもの: `repo_path`、`task_id` か `ticket_id`。中断したタスクを再開させるときは前回の `agent_id` と、
  人間の判断を `instructions` で渡す。調整役がいれば `coordinator`。フックが動かない環境では `agents_md_path`
- 並行で起動してよい（claim は CAS なので、同じタスクを 2 体が取ることはない）
- 返り値ごとの対応: blocked なら理由を人間に上げる。「PR を作れなかった」なら呼び出し元で
  `lockage-publish --repo-path <repo_path> --ticket <ticket_id>` を実行する。
  「failed (two lockage MCP servers: ...)」か「failed (no lockage MCP tools)」なら、起動し直さずに人間に伝え、対処を案内する。
  サーバが 2 つなら、上の「以前に手でサーバを登録していた場合」で `plugin:lockage:lockage` だけを残し（`lockage-maint` などの保守用サーバなら、
  リポジトリ直下の `README.md` のとおりに外す）、新しいセッションを始める。ツールが無いなら、上の「動作確認」の `failed` の切り分けを行う
- すべてのワーカーが返ったら、メインセッションで Phase 4（`publisher_status` を見て sweep / reconcile）を行う

## Antigravity

前提: 入れるのに agy（Antigravity CLI。1.3.2 で確認）を使う。フックの要件（Node.js `>= 22.5`・git 2.31 以上）は Claude Code 版と同じ。
Antigravity 2.0・IDE だけを使う場合も、agy で入れる（入れた先は 2.0・IDE と同じ場所である）。

```bash
agy plugin install <lockage のリポジトリのパス>/plugins/antigravity
```

agy は Git の URL からも入れられるとされるが、リポジトリの中のサブディレクトリ（`plugins/antigravity`）を指して入れられるかは
確かめていない。確かめるまでは、clone してからパスで入れる。

- `plugins/antigravity/` の中身が `~/.gemini/config/plugins/lockage/` へ**コピーされ、そのコピーが読み込まれる**
  （agy 1.3.2 で確認。公式ドキュメントの CLI の節は `~/.gemini/antigravity-cli/plugins/` としているが、実際には違った）。
  この場所は Antigravity 2.0・IDE も読む（ドキュメントの「グローバルのプラグイン」の置き場）。どの環境で何を確かめたかは次のとおり。

  | 確かめたこと | CLI（agy 1.3.2） | Antigravity 2.0 | IDE |
  |---|---|---|---|
  | PreInvocation の文面が渡り、エージェントが同梱の `AGENTS.md` を読む | 確認済み（`agy -p`） | 確認済み | 未確認 |
  | 本流ツリーの編集に `force_ask` の確認が出る | 非対話では拒否になることを確認 | 確認済み | 未確認 |
  | 確認を拒否しても「許可された」と記録せず、次の編集でも確認が出る | — | 確認済み | 未確認 |
  | `ask` がフックの無いときと同じ権限確認になる | 確認済み（非対話） | 未確認 | 未確認 |

  現在の構成（hook 入口は `npx -y lockage hook ...`）では実機で確かめていない。Antigravity 2.0 は、会話の記録が
  `~/.gemini/antigravity/` に残るアプリである（IDE は `~/.gemini/antigravity-ide/`）。
  lockage のリポジトリを更新しても自動では反映されないので、main を最新にしてから同じコマンドで入れ直し、新しい会話を始める。
  入れ直すと、コピーは `plugins/antigravity/` と同じ内容に上書きされる（ファイルを消す変更が入ったときに古いファイルが残るかは未確認。
  気になるときは `agy plugin uninstall lockage` してから入れる）。
- `plugin.json` の `version` は Claude Code 版と**同じ値に**上げる（上の「version」）。Antigravity は入れ直すたびに
  version に関わらずコピーし直す（agy 1.3.2 で確認）ので、更新が届くかどうかには効かない。
  揃えるのは、入れたコピーの `plugin.json` を見れば、どの版から入れたかが分かるようにするためである。
- フック（`npx -y lockage hook <session|guard> --client antigravity ...` で起動する。
  `npx` が npm 公開物を取得して起動するので、clone も `npm run build` も要らない）:
  - `npx` が lockage を解決できないと、PreInvocation の文面は渡らず、編集の確認も出ない（PreToolUse は常に `ask` になる）。
    作業は止まらないので、無効になったことに気づきにくい。
  - **PreInvocation**: 会話の最初のモデル呼び出しの前に、`repo_path` に渡す値・作業ツリーの種別・同梱 `AGENTS.md` の場所を
    `ephemeralMessage` として渡す。Antigravity には SessionStart が無いための代わりである。渡した文面は会話の記録に残り、
    以後の呼び出しでもモデルに見えるので、会話ごとに 1 回だけ渡す。記録（`transcriptPath`）に、このフックが渡した
    `EPHEMERAL_MESSAGE` のステップが既にあれば渡さない（見出しと同じ文字列が発話やツールの出力にあるだけなら渡す）。
    記録を読むのは `invocationNum` が 0 の呼び出しのときだけである。ワークスペースが複数あれば、リポジトリごとに示す。
    git をリポジトリごとに最大 3 回（各 2 秒まで）呼ぶので、このフックだけ timeout を 30 秒にしている。
    ワークスペースがおよそ 5 つを超えると打ち切られ、その会話では文面が渡らないことがある。
  - **PreToolUse / PostToolUse**（`write_to_file` / `replace_file_content` / `multi_replace_file_content`）: 判定は Claude Code 版の
    本流ツリー編集の確認と同じ（運用中の判定・許可された後はその会話では聞かない・`LOCKAGE_GUARD_DISABLE=1`）。
    確認は `force_ask` で挟む（`ask` は「常に許可」を尊重するので、編集を許可済みの環境では確認が出ない）。
    確認しないときは `ask` を返す。Antigravity は `decision` の無い応答をツールの拒否として扱うので、何も返さないわけにいかない。
    `ask` はフックが無いときと同じ権限確認になる（`allow` は権限確認を飛ばすので使わない）。
    CLI はどの経路でも必ず decision を返すので（pre は `{"decision":"ask"}`、post は `{}`）、何も出さずに編集を止めることはない。
    `run_command` 経由の書き込みは確認しない。
  - フックはプラグインのディレクトリ（`~/.gemini/config/plugins/lockage/`）を作業ディレクトリにして起動される（agy 1.3.2 で確認）。
    プラグインのルートを指す環境変数は無いので、`hooks.json` の session hook は `--agents-md ./AGENTS.md` のように
    ルートからの相対パスで AGENTS.md の場所を渡す（CLI が作業ディレクトリで絶対化する）。
  - 非対話実行（`agy -p`）では確認に答える人がいないため、`force_ask` は拒否になる（`ask` も、許可ルールが無ければ拒否になる。フックが無いときと同じ。agy 1.3.2 で確認）。
- プラグインは lockage MCP サーバの定義を `plugins/antigravity/mcp_config.json` に同梱しており、npm 公開物を `npx -y lockage` で起動する（フックと同じ）。プラグインを入れればサーバも登録されるので、別途 `agy mcp add` する必要はない。
- **以前に手でサーバを登録していた場合**（`agy mcp add lockage ...`）は、`agy mcp remove lockage` で外す。
- 同梱の定義は `env` を持たないので、台帳は既定の `~/.lockage/lockage.sqlite` になる。別の場所に置くときは、Antigravity を起動するシェルの環境変数に `LOCKAGE_DB` を設定する。サーバはそれを引き継ぐ。全エージェントで同じ台帳を指すこと。`lockage-publish` は MCP サーバの環境を受け取らないので、台帳を既定以外に置いたときは、`--db` か シェルの環境変数 `LOCKAGE_DB` で同じ台帳を見せる（見せないと、PR 化待ちのチケットがあっても `published: []` になる）。
- lockage-worker（サブエージェント）は Antigravity 用には用意していない（Antigravity のサブエージェントはプラグインのルートの `agents/` に置ける）。
- 以前の手順で `~/.gemini/config/skills/lockage-workflow/` に置いたスキルと、導入先に置いた `GEMINI.md` は、
  プラグインのスキル・フックと重複するので削除する（導入先の `AGENTS.md` の扱いは Claude Code のプラグインと同じ）。
- 動作確認:
  - lockage のリポジトリのルートで `agy plugin validate plugins/antigravity` が通ること。
  - git リポジトリの中で新しい会話を始め、「lockage プラグインから示された見出しと、協調ルールの正本のパスを、ツールを使わずにそのまま答えて」と
    尋ねると、見出し「lockage 協調開発（lockage プラグイン）」と `~/.gemini/config/plugins/lockage/AGENTS.md` を答えること
    （repo_path だけを尋ねると、ワークスペースのパスから推測しても答えられるので、注入されたかの確かめにならない）。
  - 答えられなければ、次を確かめる。CLI の `/hooks` に lockage の PreInvocation が出ているか。`npx` が lockage を解決できているか。
    ワークスペースが git リポジトリか。新しい会話で試したか（文面は会話の最初の呼び出しでしか渡さない）。
    フックの失敗は stderr に `[lockage-plugin]` で始まる行として出る。

## Kiro（Power）

Claude Code のプラグインに相当する配布形式（`POWER.md` 形式）。`plugins/kiro/` が Power のルートである。

**Kiro がインストール時にコピーするのは `POWER.md`・`mcp.json`・`steering/` だけである**（2026-10-10 の登録で
`~/.kiro/powers/installed/` に残ったもので確認）。そのため協調ルール（`AGENTS.md`）と lockage-workflow スキルは、
コピーを `steering/AGENTS.md`・`steering/lockage-workflow.md` として置いている（`npm run sync:plugins` が配る）。
MCP サーバも hook も npm 公開物を `npx -y lockage` で起動するので、clone も `npm run build` も要らない
（同梱 `mcp.json` はプレースホルダ置換不要でそのまま使える。hook の判定ロジックは `src/hook/` の TypeScript 実装に移植済みで、
`npx -y lockage hook ...` が起動する）。

1. **Power を登録する。** Kiro の Powers パネルの「Add Custom Power」から、次のどちらかで `plugins/kiro` を登録する。
   - **フォルダから**（Import power from a folder）: clone の `plugins/kiro` を選ぶ。
   - **GitHub から**（Import power from GitHub）: `https://github.com/tacck/lockage/tree/main/plugins/kiro` を入れる。
     Kiro は `tree/<ブランチ>/<パス>` の形の URL からサブディレクトリを取り込める（ほかのリポジトリの Power で確認。
     登録は `~/.kiro/powers/registries/user-added.json` に `pathInRepo` として残る）。lockage のリポジトリが公開されるまでは
     使えず、公開後も lockage では確かめていない。GitHub から登録した Power は main の最新を取り込む。
2. **MCP サーバを登録する。** 同梱の `mcp.json`（`command:npx`・`args:["-y","lockage"]`・`disabled:false`）を
   そのまま Kiro の `mcp.json` 設定へ反映する。**プレースホルダの置換は要らない。** `npx` が npm 公開物を取得して
   起動するので、clone や `npm run build` は MCP サーバの起動には要らない（初回は取得に時間がかかることがある）。
   DB（台帳）は既定 `~/.lockage/lockage.sqlite` が使われる。既定のままでよく、場所を変えたい人だけ `lockage` に
   `env.LOCKAGE_DB`（台帳の絶対パス）を足す。
   **協調するすべてのエージェントが同じ `LOCKAGE_DB`（同一の台帳 DB）を指すこと。** 既定のまま使えば全員が
   同じ既定を指すので追加設定は要らない。揃っていないと占有・dirty・board が共有されず、衝突回避が機能しない。
   登録しないと AGENTS.md の「ツールが 1 つも見つからない場合」として lockage を使わずに作業することになる。
   `lockage-publish` に台帳を見せる方法は Claude Code 版と同じ。
3. **hook を `.kiro/hooks/` に置く。** 主経路は、導入先リポジトリで `npx -y lockage setup kiro` を実行することである。
   これで `.kiro/hooks/lockage-guard.json`（本流ツリー編集ガード）と `lockage-session.json`（`SessionStart` の文脈注入）が
   生成される。各 `action.command` は `npx -y lockage hook <guard|session> --client kiro ...` 形で、**絶対パスの手置換は要らない**
   （session hook の `--agents-md` には導入先の `.kiro/steering/AGENTS.md` の絶対パスが埋まる）。既存の同名ファイルがあると、
   内容が同じなら `unchanged`、違えば `--force` を付けるまで上書きしない。worktree の中で実行しても、hook は本体リポジトリの
   `.kiro/hooks/` に置く。この経路なら hook のために clone する必要はない（`npx` が npm 公開物を取得して起動する）。
   hook が無くても作業はできるが、本流ツリーの編集は止まらない（`main-tree-guard.md` の決まりを自分で守る）。

   **setup を使わない場合の代替**: `npx -y lockage` が使えない（オフライン・社内レジストリ制約など）／生成物を手で
   調整したいときは、clone の `plugins/kiro/hooks/` にある同梱雛形（`lockage-guard.json`・`lockage-session.json`）を
   導入先の `.kiro/hooks/` にコピーする。`lockage-session.json` の `--agents-md "<ABSOLUTE_PATH_TO_STEERING_AGENTS_MD>"` を、
   導入先の `.kiro/steering/AGENTS.md` の絶対パスに置き換える（`lockage-guard.json` は `--agents-md` を使わないので置換不要）。
4. **steering の読み込み。** `POWER.md` の Steering 節が、`AGENTS.md`・`lockage-workflow.md`・`coordination` /
   `main-tree-guard` / `publish-pr` をいつ読むか案内する。steering は inclusion mode「常に読み込む（Always）」を推奨。

- **動作確認**（0.5 系の構成では、lockage では実機で確かめていない）:
  - lockage 運用中のリポジトリで新しいセッションを始め、「lockage Power の hook から示された見出しと、協調ルールの正本のパスを、
    ツールを使わずにそのまま答えて」と尋ねると、見出し「lockage 協調開発（lockage Kiro Power）」と
    導入先の `.kiro/steering/AGENTS.md`（setup kiro が `--agents-md` に埋めた絶対パス）を答えること。答えられなければ、
    `.kiro/hooks/lockage-session.json` が置かれ `command` が `npx -y lockage hook session --client kiro ...` 形になっているかを
    確かめる（hook の失敗は stderr に `[lockage-plugin]` で始まる行として出る）。
  - 同じリポジトリの本流ツリーのファイルを編集させると拒否され、worktree で進めるか `LOCKAGE_GUARD_DISABLE=1` を使うかを
    問い返されること。
  - MCP のツール一覧に lockage のツール（`claim_task` など）が出ること。
- **本流ツリー編集ガードの挙動差（Kiro 固有）**: Kiro の command hook には Claude Code の
  「確認（ask）」に相当する出力が無い。そのため本 Power のガードは、lockage 運用中のリポジトリで
  本流ツリー（worktree ではない本体の作業ツリー）を `fs_write` / `str_replace` で編集しようとすると
  **拒否（exit 2）に倒れる**（Claude 版は確認を挟んでいた）。本流ツリーを直接編集する必要があるときは、
  環境変数 `LOCKAGE_GUARD_DISABLE=1` を設定してガードを無効化する。
  実機では、拒否したうえでスクリプトが示すメッセージ（worktree の中で編集する／`LOCKAGE_GUARD_DISABLE=1` で
  無効化する）がエージェント経由でユーザーに伝わり、「worktree で進めるか／本流直接か」を問い返す形になった
  （2026-10-10 確認）。
  「このセッションで一度許可したら以後は聞かない」というセッション単位の許可記憶は持たない。
  拒否方式では毎回拒否で一貫するため不要という設計判断による（無効化は `LOCKAGE_GUARD_DISABLE=1` で行う）。
- 「運用中」の判定（本体に `lockage/` ブランチ・`.lockage-worktrees/`・`.lockage/` のいずれかがある）と、
  Bash 相当の書き込みは判定しない点は Claude Code 版と同じ（判定は `src/hook/repo.ts` の `mainTreeRoot` を全クライアントで共有している）。
