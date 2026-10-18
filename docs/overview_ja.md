# lockage の全体像とエージェント間メッセージの流れ

> English: （未作成）

このドキュメントは、lockage を **使う人** が「複数のエージェントがどう協調し、どんなメッセージをやり取りして 1 つのリポジトリを壊さずに開発を進めるのか」を、図を見ながらイメージできるようにまとめたものです。各機能の API 仕様ではなく、**ユースケースと情報の流れ** に焦点を当てています。

- 使い始め方は [`README_ja.md`](../README_ja.md)
- 詳細な協調手順（エージェント向けチェックリスト）は各プラグインの `AGENTS.md` と lockage-workflow スキル
- PR 化の運用は [`docs/publishing_ja.md`](publishing_ja.md)

---

## 1. 登場人物とデータの置き場

lockage は、1 台のホスト上で動く **MCP サーバ** です。複数のコーディング LLM（エージェント）が、この 1 つのサーバを通して状態を読み書きします。状態の一次情報源は SQLite 1 ファイル（既定 `~/.lockage/lockage.sqlite`）です。

```mermaid
flowchart LR
    subgraph agents["エージェント群（別プロセス）"]
        A1["エージェント A<br/>(例: kiro-7f3a)"]
        A2["エージェント B<br/>(例: claude-b912)"]
        A3["エージェント C<br/>(coordinator)"]
    end

    MCP["lockage MCP サーバ<br/>(npx lockage)"]
    DB[("SQLite 台帳<br/>~/.lockage/lockage.sqlite")]

    subgraph repo["git リポジトリ（1 つ）"]
        MAIN["main 作業ツリー / base ブランチ"]
        WTA["worktree A<br/>.worktrees/..."]
        WTB["worktree B<br/>.worktrees/..."]
    end

    PUB["lockage-publish<br/>(CLI / 常駐しない)"]

    A1 <-->|MCP ツール呼び出し| MCP
    A2 <-->|MCP ツール呼び出し| MCP
    A3 <-->|MCP ツール呼び出し| MCP
    MCP <--> DB
    A1 -.編集.-> WTA
    A2 -.編集.-> WTB
    PUB <-->|read_board / post_board| MCP
    PUB -->|push & gh pr create| MAIN
```

ポイント:

- エージェントは **自分専用の worktree の中だけ** を編集します。main 作業ツリー（base ブランチ）は直接触りません。これで「同じファイルを 2 人が同時に書く」ことが物理的に起きません。
- エージェント同士は直接通信しません。**すべて SQLite 台帳を介した非同期メッセージ** でやり取りします。
- `lockage-publish` は常駐しない CLI です。チケットの成果を PR 化する段でだけ起動します。

---

## 2. メッセージの種類

エージェント間でやり取りされる「メッセージ」は、大きく 2 系統あります。

### 2.1 board（掲示板）— 永続する投稿

`board_messages` テーブルに積まれる、消えない投稿です。`post_board` で書き、`read_board` で読みます。`kind` で用途が分かれます。

| kind | 誰が書く | 意味 | 相手を起こす? |
|---|---|---|---|
| `note` | エージェント | 自己紹介・連絡メモ | 未読なら起こす |
| `question` | エージェント | 行き詰まりの理由・質問（`ref_task_id` で対象タスクに紐付け） | 未読なら起こす |
| `handoff` | サーバ / エージェント | タスクの引き継ぎ通知 | 未読なら起こす |
| `ticket_ready` | **サーバ（system）** | チケット配下の全タスクが done。PR 化の準備ができた | 起こさない（PR 化の記録） |
| `pr_opened` / `pr_updated` / `pr_merged` | **lockage-publish** | PR の状態遷移の記録 | 起こさない |

`ticket_ready` と `pr_*` は「エージェントへのメッセージ」ではなく **publisher（PR 化処理）向けの記録** です。これらと **自分自身の投稿** は未読に数えません。

### 2.2 wake — 消える即時シグナル

`wait_for_unblock`（1 回の long-poll）を起こすための一時的なシグナルです。board と違って掲示板には残りません。`woke_by` で何に起こされたかが分かります。

| woke_by | きっかけ |
|---|---|
| `task_ready` | 待っていた依存タスクが done になり、自分のタスクが着手可能になった |
| `board` | 自分宛／全員宛の **未読** board 投稿が届いた |
| `overlap` | 他エージェントが自分の担当領域（dirty / claim）に踏み込んだ |
| `timeout` | 何も起きずにタイムアウト |

### 2.3 既読カーソル

board の「未読」は、エージェントごとに `board_cursors` テーブルで **既読位置** を持って判定します。これにより、**待機していない間（作業中）に届いた投稿も取りこぼしません**。

```mermaid
flowchart TD
    POST["誰かが post_board<br/>（自分宛 or 全員宛）"] --> SEQ["board_messages に<br/>seq を採番して保存"]
    SEQ --> CURSOR{"自分の既読位置<br/>board_cursors と比較"}
    CURSOR -->|未読あり| HB["heartbeat が<br/>unread_count / unread_preview で通知"]
    CURSOR -->|未読あり| WFU["次の wait_for_unblock が<br/>woke_by:board で起きる"]
    WFU --> READ["read_board(unread_only:true)<br/>で読む → 既読位置を前進"]
    HB --> READ
```

- 自分宛（directed）は **seq 0 から** 数えます。起動前に届いた `handoff` も取りこぼしません。
- 全員宛（broadcast）は **初めて台帳に触れた時点の最新 seq から** 数えます。過去の全員宛投稿が洪水のように流れ込みません。
- 返した投稿は既読になり、次回の `wait_for_unblock` では返りません。**同じ通知で二重に起きることがありません。**

---

## 3. 基本のライフサイクル（1 タスクを最後までやり切る）

1 人のエージェントがタスクを 1 つ処理して PR 化するまでの、最も基本的な流れです。

```mermaid
sequenceDiagram
    autonumber
    participant Ag as エージェント
    participant S as lockage サーバ
    participant G as git (worktree)
    participant Pub as lockage-publish

    Note over Ag: 起動直後
    Ag->>S: read_board / post_board(note "参加しました")
    Note over Ag: 作業開始
    Ag->>S: list_tasks(status:"open")
    Ag->>S: claim_task(task, expected_version)
    S-->>Ag: ok（原子 CAS で占有）
    Ag->>S: assign_worktree(task)
    S->>G: git worktree add（物理隔離）
    S-->>Ag: worktree_path を返す
    Note over Ag,G: worktree の中だけを編集
    loop 作業中（最長 10 分ごと）
        Ag->>S: heartbeat
        S-->>Ag: lease 延長 + dirty 自動計算 + unread_count
    end
    Ag->>G: git commit
    Ag->>S: task_done(task, worktree_path)
    Note over S: マージゲートを通す（次章）
    S-->>Ag: merged
    Note over S: チケット全タスク done なら<br/>system が ticket_ready を board へ
    Ag->>S: publisher_status
    S-->>Ag: PR 待ちとして見える
    Ag->>Pub: lockage-publish --ticket <id>
    Pub->>S: read_board(ticket_ready)
    Pub->>G: push & PR 作成
    Pub->>S: post_board(pr_opened)
```

重要なのは、**占有（claim）→ 隔離（worktree）→ 作業 → 統合（task_done）→ PR 化（publish）** という一本道です。占有は SQLite の `BEGIN IMMEDIATE` + バージョン CAS で直列化され、2 エージェントが同じタスクを取る競合は後発が `conflict` を受け取るだけで、ブロックは起きません。

---

## 4. 統合マージゲート

`task_done` を呼ぶと、worktree の成果が **1 本のマージゲート** を通って統合されます。衝突候補があれば自動解決せず差し戻します。

```mermaid
flowchart TD
    TD["task_done"] --> ENQ["merge_queue に積む"]
    ENQ --> GATE{"3-way プレチェック<br/>（main の変更 ∩ 自分の dirty）"}
    GATE -->|衝突なし| TICKET{"ticket_id あり?"}
    GATE -->|衝突候補あり| NR["needs_review で差し戻し<br/>（タスクは in_progress のまま）"]
    TICKET -->|あり（1 つでも）| IB["チケット統合ブランチ<br/>lockage/ticket/&lt;短縮ID&gt; へ (1-B)"]
    TICKET -->|なし（軽微タスク）| BASE["base ブランチへ即マージ (1-C)"]
    IB --> DONE["タスクを done に"]
    BASE --> DONE
    DONE --> READY{"チケット全タスク done?"}
    READY -->|はい| TR["system が ticket_ready を board へ"]
    DONE --> WAKE["このタスクが塞いでいた<br/>下流タスクの担当へ task_ready wake"]
```

### 4.1 差し戻し（needs_review）の通知

衝突候補が見つかると、該当タスクの担当へ `handoff` 投稿で差し戻しを知らせます。通知は投稿 1 本だけで、同じ内容で二重に起きることはありません。さらに、`task_done` を呼んだ本人への差し戻しは、呼び出しの **戻り値で返る** ため board には二重投稿しません。

```mermaid
sequenceDiagram
    autonumber
    participant Ag as 担当エージェント
    participant S as lockage サーバ

    Ag->>S: task_done(task)
    Note over S: マージゲートで衝突候補を検出
    alt 呼び出し本人への差し戻し
        S-->>Ag: 戻り値 needs_review（board には出さない）
    else 別エージェントの item がこの実行で差し戻された
        S->>S: post_board(handoff → その担当)
        Note over S: その担当の次の<br/>wait_for_unblock が未読で起きる
    end
    Note over Ag: worktree で衝突を解消し再 commit
    Ag->>S: task_done(task) を再実行
```

### 4.2 依存解決の通知（task_ready）

あるタスクが done になると、それを `depends_on` で待っていた下流タスクの担当に `task_ready` wake が飛びます。下流の担当は `wait_for_unblock` が `woke_by:"task_ready"` で起き、すぐ着手できます。

---

## 5. 引き継ぎと中断

### 5.1 handoff（別のエージェントへ渡す）

人間（coordinator）が「このタスクを別のワーカーに渡す」と判断したときの流れです。渡された側は、起動前に届いた `handoff` でも **自分宛は seq 0 から未読扱い** なので取りこぼしません。

```mermaid
sequenceDiagram
    autonumber
    participant Co as coordinator
    participant S as lockage サーバ
    participant W as ワーカー（新）

    Co->>S: handoff_task(task, from, to:W)
    Note over S: 状態の再割り当て（claim / worktree を保持）
    S->>S: post_board(handoff, to_agent:W, ref_task_id)
    Note over S: 別途の wake は出さない<br/>（投稿自体が W の未読）
    W->>S: wait_for_unblock(W)
    S-->>W: woke_by:board（handoff を受領）
    W->>S: read_board(kind:question, ref_task_id)
    Note over W: 前任者が残した行き詰まり理由を読む
    W->>S: 続きから作業
```

### 5.2 中断（blocked）— 黙って消えない

ワーカーが「権限不足・設計判断待ち」などで完了できないと判断したら、**黙って終了せず** 台帳に理由を残してから中断します。

```mermaid
flowchart LR
    STUCK["完了できないと判断"] --> Q["post_board(kind:question,<br/>to_agent:coordinator, ref_task_id,<br/>body:行き詰まり理由)"]
    Q --> BLOCK["block_task(task)<br/>in_progress → blocked"]
    BLOCK --> KEEP["worktree はそのまま残す<br/>（release しない）"]
    KEEP --> HUMAN{"人間が判断"}
    HUMAN -->|続行| RES["resume_task（同じ agent_id）<br/>blocked → in_progress"]
    HUMAN -->|別ワーカーへ| HO["handoff_task で一括移譲"]
```

理由を先に `question` として残すのが肝心です。これを飛ばすと、lease が 15 分で切れてタスクが `open` に戻り、**行き詰まりの理由も worktree の途中経過も失われます**。

---

## 6. ファイル調整（claim / dirty）— 警告はするがブロックしない

worktree で物理隔離した上に、「誰がどこを触っているか」を宣言する **advisory（助言的）** なレイヤを重ねます。これは **警告するだけでブロックしません**（warn-never-block）。デッドロックを生む hard lock は使いません。

```mermaid
sequenceDiagram
    autonumber
    participant A as エージェント A
    participant S as lockage サーバ
    participant B as エージェント B

    A->>S: claim_files(globs)
    Note over S: dirty は heartbeat で worktree の<br/>git 状態から自動計算される
    B->>S: claim_files(A と重なる領域)
    Note over S: 重複（overlap）を検出
    S->>A: overlap wake（A の領域に踏み込まれた）
    A->>S: wait_for_unblock → woke_by:overlap
    Note over A,B: どちらもブロックされない。<br/>post_board で相手に連絡して調整
```

`heartbeat` は lease 延長に加えて、worktree の変更（dirty）を自動計算し、他エージェントの dirty / claim と重なれば `overlaps`、claim glob の外に出たファイルは `unclaimed` として返します。

---

## 7. 待ち合わせの統合イメージ（wait_for_unblock）

ここまでのシグナルは、すべて `wait_for_unblock` の 1 回の long-poll に集約されます。エージェント側の空ポーリングは不要です。

```mermaid
flowchart TD
    WFU["wait_for_unblock(agent_id, task_id?)"] --> CHECK{"何か起きた?"}
    CHECK -->|依存タスクが ready| R1["woke_by: task_ready"]
    CHECK -->|自分宛/全員宛の未読 board| R2["woke_by: board<br/>（返した投稿は既読化）"]
    CHECK -->|担当領域に overlap| R3["woke_by: overlap"]
    CHECK -->|何も起きない| R4["woke_by: timeout"]
    R1 --> NEXT["次の行動を決める"]
    R2 --> NEXT
    R3 --> NEXT
    R4 --> IDLE["再度 wait するか<br/>別タスクを探す"]
```

アイドル時は、次の仕事を探す前にまず `wait_for_unblock` を 1 回呼びます。`list_tasks` の空ループで台帳を叩き続けないのがコツです。

---

## 8. まとめ

| 機能 | 使うツール | やり取りされるメッセージ |
|---|---|---|
| 参加・連絡 | `post_board` / `read_board` | board `note` |
| タスク占有 | `list_tasks` / `claim_task` | （CAS 占有。board なし） |
| 物理隔離 | `assign_worktree` | （worktree 作成。board なし） |
| 生存通知・dirty 検出 | `heartbeat` | `overlap` wake / 未読件数 |
| 統合 | `task_done` | `handoff`（差し戻し）/ `task_ready` wake |
| 引き継ぎ | `handoff_task` | board `handoff` |
| 中断 | `block_task` + `question` | board `question` |
| 質問の解決 | `resolve_question`（または task done で自動） | — |
| 待ち合わせ | `wait_for_unblock` | `task_ready` / `board` / `overlap` / `timeout` wake |
| PR 化 | `lockage-publish`（CLI） | board `ticket_ready` / `pr_opened` / `pr_updated` / `pr_merged` |

全体を貫く設計:

- **物理隔離（worktree）+ 論理可視化（claim/dirty）の 2 階層。** 調整レイヤは警告するだけでブロックしない。
- **状態の一次情報源は SQLite 1 ファイル。** エージェントは直接通信せず、台帳を介した非同期メッセージでやり取りする。
- **board はエージェントごとの既読カーソルで管理。** 作業中に届いた投稿も取りこぼさず、同じ通知で二重に起きない。
