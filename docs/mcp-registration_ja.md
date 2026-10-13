# lockage MCP サーバの登録

> English: [mcp-registration.md](mcp-registration.md)

このドキュメントは、lockage MCP サーバをクライアントに登録する詳細 —— `npx` によるサーバ定義、台帳の置き場（`LOCKAGE_DB`）、保守用のツール組、以前に手で登録していた場合の後始末 —— をまとめたものです。

**たいていの人はプラグイン / Power がこれを肩代わりします。** Kiro の Power、Claude Code のプラグイン、Antigravity のプラグインはいずれもサーバ定義を同梱しているので、入れればサーバも登録されます —— トップの [`README_ja.md`](../README_ja.md) の「セットアップ」節を参照してください。台帳の場所を変えたいとき、保守用のツールを使うとき、プラグインを使わずにサーバを登録するときに、このドキュメントを読んでください。

---

## サーバ定義

clone も build も要りません。npm 公開物を `npx` で起動する定義を書くだけです。設定ファイルの書式は各クライアントに従ってください。

```json
{
  "mcpServers": {
    "lockage": {
      "command": "npx",
      "args": ["-y", "lockage"],
      "disabled": false
    }
  }
}
```

初回は取得に少し時間がかかることがあります。clone や `npm run build` は要りません。

Kiro では、同梱の `plugins/kiro/mcp.json` をそのまま Kiro の `mcp.json` に反映します（プレースホルダの置換は不要です）。Claude Code・Antigravity では手で登録する必要はまったくありません。プラグインがこの `npx -y lockage` の定義（`plugins/claude/.mcp.json` / `plugins/antigravity/mcp_config.json`）を同梱しているので、プラグインを入れればサーバも登録されます。

---

## 台帳の置き場（`LOCKAGE_DB`）

DB（台帳）の保存先は既定で `~/.lockage/lockage.sqlite` が使われます（親ディレクトリは自動作成されます）。既定のままでよく、場所を変えたい人だけ `LOCKAGE_DB` に絶対パスを設定します。

`LOCKAGE_DB` を設定する場所はクライアントによって異なります。

- **Kiro**: `mcp.json` の `lockage` サーバに `"env": { "LOCKAGE_DB": "/absolute/path/to/lockage.sqlite" }` を足します。
- **Claude Code**: 同梱のサーバは `env` を持たないので、代わりに Claude Code の設定ファイル（通常は `~/.claude/settings.json`）の `env` に `LOCKAGE_DB` を設定します（[`../plugins/README_ja.md`](../plugins/README_ja.md#claude-code) の Claude Code 節を参照）。
- **Antigravity**: 起動するシェルの環境変数に `LOCKAGE_DB` を設定します。サーバがそれを引き継ぎます。

複数のエージェントが協調する場合は、**同じ `LOCKAGE_DB` を指す**ように全員をそろえます。既定のまま使えば全員が同じ既定の台帳を指すので、追加の設定は要りません。これが共有の調整台帳になります。そろっていないと、claim / dirty / board が共有されず、衝突回避が働きません。

`lockage-publish` は別コマンドで、MCP サーバからではなく、それを走らせた環境から `LOCKAGE_DB` を読みます。台帳を既定以外に置くときは、走らせる場所でも `--db`（またはシェルの環境変数 `LOCKAGE_DB`）で同じ台帳を渡してください。特に MCP クライアントの外のターミナルには設定ファイルの `env` が効きません（同じ台帳を見せないと、チケットが PR 化待ちでも `published: []` になります）。

---

## ツールの組（`LOCKAGE_TOOLSETS`）

エージェントの設定には `LOCKAGE_TOOLSETS` を書きません（既定の `core` だけが見えます）。保守・診断のツールを人間が使うときだけ、その MCP クライアントの `env` に `"LOCKAGE_TOOLSETS": "maintenance"` を足します。

Claude Code のプラグインでは同梱のサーバが `env` を持たないので、人間が使う場所にだけ保守用のサーバを別に登録し、使い終わったら外します。

```bash
claude mcp add lockage-maint -s local -e LOCKAGE_TOOLSETS=maintenance -- npx -y lockage@latest
claude mcp remove lockage-maint -s local
```

コマンドは同梱のもの（`npx -y lockage`）と変えてください（ここでは `lockage@latest`。同梱のサーバが動かしている版より新しくなることがあります）。Claude Code は名前や `env` が違ってもコマンドが同じサーバを 1 つにまとめるので、`npx -y lockage` で登録すると同梱のサーバが置き換わり、そのセッションには保守用のサーバだけが残ります（Claude Code 2.1.285 で確認）。

このサーバは保守用のツールに加えて core のツールも `mcp__lockage-maint__*` として出します（lockage 0.9.2 で 31 個、確認済み）。そのため登録している間は、lockage-worker が 2 つ目の lockage サーバを見つけて「failed」で返します。外すまでワーカーを起動しないでください。`LOCKAGE_DB` は同梱のサーバと同じく Claude Code が MCP サーバに渡す環境から読むので、設定の `env` に置いた台帳を指します（このサーバでは試していません）。

---

## 以前に手でサーバを登録していた場合

Claude Code・Antigravity ではプラグインがサーバ定義を同梱するので、手による登録はもう要りません。以前に手で登録していた場合は、その登録を外してください。

- **Claude Code**: `claude mcp remove lockage -s user`（プロジェクトごとに登録していた場所では `-s local` / `-s project` も）。その登録に `env`（特に `LOCKAGE_DB`）があったなら、外す前に `claude mcp get lockage` で確認し、設定ファイルの `env`（登録のスコープに合わせる）へ移してください。移さないと台帳が黙って既定にフォールバックし、このクライアントが他エージェントのタスクを見られなくなります。Claude Code はコマンドが同じ MCP サーバを 1 つにまとめます。コマンドが同じ（`npx -y lockage`）なら名前や `env` が違っても手で登録したほうだけが残り、コマンドが違えば両方登録されて lockage サーバが 2 つ並びます。詳細は [`../plugins/README_ja.md`](../plugins/README_ja.md#claude-code) の Claude Code 節を参照してください。
- **Antigravity**: `agy mcp remove lockage`。

コマンドが違うと lockage サーバが 2 つ並び、同じだと手で登録したほうだけが残って同梱の定義が使われません。いずれの場合も、登録の `env` にある `LOCKAGE_DB` を設定ファイルや環境変数へ移してから、手による登録を外してください。
