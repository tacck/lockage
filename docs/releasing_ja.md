# lockage の npm リリース

> English: [releasing.md](releasing.md)

このドキュメントは、`lockage` npm パッケージをどうリリースするか —— 誰が実行するか、事前に何を確かめるか、いつ version を上げるか —— をまとめたものです。[`./publishing.md`](./publishing_ja.md)（lockage のチケットを GitHub/GitLab の PR 化する `lockage-publish` の文書）とは別で、両者は「publish」という語が共通なだけの無関係な操作です。lockage 自体の開発・ビルド・テストは [`./development.md`](./development_ja.md)、パッケージとプラグインをまたぐ version 一致の規則は [`../plugins/README.md`](../plugins/README_ja.md#version) の「version」節を参照してください。

## 誰が・いつリリースするか

メンテナが**ローカルのチェックアウトから手動で**リリースします（現状、CI による publish はありません）。トリガーは **version を上げた PR をマージしたとき**（下の「いつ version を上げるか」を参照）。そうした PR がデフォルトブランチに入ったら、その version を npm に publish します。

## 前提

- `lockage` パッケージの npm オーナーで、ログイン済み（`npm whoami` に自分のアカウントが出る）。
- チェックアウトがデフォルトブランチにあり、マージ済み PR に追従していて、クリーン（`git status` が空）。
- Node.js `>= 22.5`（パッケージの `engines` 要件）。

## 手順

1. **publish する version を確認する。** マージ済み PR で `package.json` の version が上がっているはず（リリースでは上げません）。3 つの version が一致していることを確認します（`test/plugins.test.ts` でも強制されます）。

   ```bash
   node -p "require('./package.json').version"
   node -p "require('./plugins/claude/.claude-plugin/plugin.json').version"
   node -p "require('./plugins/antigravity/plugin.json').version"
   ```

2. **クリーンなツリーでビルド・テストする。**

   ```bash
   npm ci
   npm test
   ```

   `npm test` は `pretest` 経由で `npm run build` を走らせるので、型エラーやビルドの破綻はここで落ちます。

3. **publish する。** `prepublishOnly`（`rm -rf dist && npm run build`）が `dist/` をまっさらから作り直すので、公開物は常に現在のソースと一致します。

   ```bash
   npm publish
   ```

   ファイル一覧を確かめたいときは先に dry run を: `npm publish --dry-run`。

4. **リリースにタグを打つ**（publish した version を git 履歴で特定できるように。既存のタグ形式に合わせる。例 `v0.9.3`）。

   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push --tags
   ```

5. **確認する。** `npm view lockage version` に、いま publish した version が出ます。プラグインは版を固定しない `npx -y lockage` でサーバを起動するので、npx を新規に走らせれば（lockage リポジトリの外で。中だと作業ツリーの `dist/` が使われます）、キャッシュが更新され次第、新しい版が解決されます。

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
