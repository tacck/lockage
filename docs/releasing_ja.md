# lockage の npm リリース

> English: [releasing.md](releasing.md)

このドキュメントは、`lockage` npm パッケージをどうリリースするか —— 誰が実行するか、事前に何を確かめるか、いつ version を上げるか —— をまとめたものです。[`./publishing.md`](./publishing_ja.md)（lockage のチケットを GitHub/GitLab の PR 化する `lockage-publish` の文書）とは別で、両者は「publish」という語が共通なだけの無関係な操作です。全体のブランチモデルは [`./branch-strategy.md`](./branch-strategy.md)、lockage 自体の開発・ビルド・テストは [`./development.md`](./development_ja.md)、パッケージとプラグインをまたぐ version 一致の規則は [`../plugins/README.md`](../plugins/README_ja.md#version) の「version」節を参照してください。

## 誰が・いつリリースするか

リリースは **CI で自動化**されています。GitHub Actions の publish ワークフロー（[`.github/workflows/publish.yml`](../.github/workflows/publish.yml)）が `main` への push ごとに走り、`package.json` の version がまだ publish されていなければ npm へ publish します。したがってトリガーは **version を上げたうえで `dev` -> `main` の PR をマージしたとき**（下の「いつ version を上げるか」を参照）。ローカルのチェックアウトから手動で publish する人はいません。

publish の認証は、保存した `NPM_TOKEN` ではなく **npm の Trusted Publishing（OIDC）** を使います。GitHub Actions が短命の OIDC トークンを発行し、npm がそれを使い捨ての publish 資格情報に交換します。来歴（provenance）も自動で付きます。publish ジョブは `permissions: id-token: write` を設定し、`NODE_AUTH_TOKEN` を付けずに `npm publish` を実行します。

## 前提

一度きりのセットアップ —— `dev` の作成、デフォルトブランチの切り替え、npmjs.com でのパッケージの **Trusted Publisher 設定**（GitHub Actions、リポジトリ `tacck/lockage`、ワークフロー `publish.yml`）—— は [`./branch-strategy.md`](./branch-strategy.md#one-time-setup-manual-done-by-a-human) に記載しています。それが済んでいれば、リリースごとに人が確かめる前提はありません。CI は Node `22.14` 上で npm を Trusted Publishing の下限（`>= 11.5.1`）へ更新し、OIDC で自動的に認証します。シークレットの保存は不要です。

## 手順

1. **version を上げる**（`dev` 上で既に上がっている場合は不要）。Actions タブから **version-bump** ワークフロー（[`.github/workflows/version-bump.yml`](../.github/workflows/version-bump.yml)）を実行し、上げたいセマンティックバージョンの箇所（`patch` / `minor` / `major`）を選びます。`package.json` を上げ、2 つの `plugin.json` と `package-lock.json` を同期し、`dev` を対象にした PR を開きます。その PR を `dev` にマージします。

   3 つの version は一致していなければなりません（`test/plugins.test.ts` でも強制され、publish ワークフローも publish 前に再チェックします）。

   - `package.json`
   - `plugins/claude/.claude-plugin/plugin.json`
   - `plugins/antigravity/plugin.json`

2. **`dev` -> `main` の PR を開いてマージする。** これで `dev` に溜まった変更をまとめて 1 リリースにします。`main` への push で publish ワークフローが始まります。

3. **CI に publish させる。** publish ワークフローは次を行います。

   - 3 つの version ファイルが一致しているか検証する（ずれていれば即座に失敗）。
   - npm を確認する —— `package.json` の version が既に publish 済みなら成功扱いの no-op で終わるので、version を上げずにマージしても失敗しません。
   - そうでなければ `npm ci`、`npm test`、`npm publish`（Trusted Publishing / OIDC 経由。トークン不要。`prepublishOnly` が `dist/` を作り直すので公開物はソースと一致し、provenance も自動で付く）を実行し、`vX.Y.Z` タグ（既存のタグ形式に合わせる。既にあれば失敗せずスキップ）を作成して push します。

4. **確認する。** `npm view lockage version` に、CI がいま publish した version が出ます。プラグインは版を固定しない `npx -y lockage` でサーバを起動するので、npx を新規に走らせれば（lockage リポジトリの外で。中だと作業ツリーの `dist/` が使われます）、キャッシュが更新され次第、新しい版が解決されます。

   ```bash
   npx -y lockage </dev/null
   # stderr に: [lockage] ready (version=<publish した版>, db=..., toolsets=...)
   ```

## いつ version を上げるか

version は等しく保つべき 3 ファイル —— `package.json`、`plugins/claude/.claude-plugin/plugin.json`、`plugins/antigravity/plugin.json` —— にあり、ずれると `test/plugins.test.ts` が落ちます。プラグインは版を固定しない `npx -y lockage` で npm パッケージを起動するので、プラグインの変更は npm に新しい版を publish して初めて利用者に届きます。したがって version を上げる規則は、変更の種類によって「リリースが要るか」で決まります。

| 変更 | 3 つの version を上げる？ | npm に publish する？ |
|---|---|---|
| `src/`（サーバ / `lockage-publish`） | はい | はい |
| `plugins/claude/` または `plugins/antigravity/`（正本 `plugins/shared/` の変更がコピーに波及する場合を含む） | はい | はい |
| `plugins/README.md` または `plugins/kiro/` のみ | いいえ | いいえ |
| ドキュメントのみ（`docs/`、トップの `README*.md`） | いいえ | いいえ |

`plugins/kiro/` や `plugins/README.md` のみの変更で上げなくてよいのは、Kiro の `POWER.md` 形式には version が無く、`plugins/README.md` は npm パッケージに含まれないためです。プラグインキャッシュまわりの理由（Claude Code は版ごとにキャッシュを作るので、上げ忘れると利用者に届かないことがある）は [`../plugins/README.md`](../plugins/README_ja.md#version) の「version」節を参照してください。
