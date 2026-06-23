# ⚠️ このリポジトリは開発凍結（DEV FROZEN）

**RaspberryPi インフラの開発・デプロイは monorepo に移行しました（#132 Phase C-3, 2026-06-23）。**

## 今後の開発場所

```
~/dev/maoka-platform/services/{ai-proxy,henry-telemetry,henry-user-settings}   # Python Docker サービス
~/dev/maoka-platform/packages/discharge-summary-gen                            # 退院サマリー生成 cron
```

- コード編集・デプロイは **すべて上記 monorepo 側** で行う。
- このフォルダ（`~/Projects/RaspberryPi`）は **旧アーカイブ**。新規コミット・編集をしないこと。

## デプロイ（Pi / sk924.com）

- Pi 上に `~/maoka-platform`（GitHub の read-only **deploy key** で clone）を配置。更新は **`cd ~/maoka-platform && git pull`**（旧 scp/rsync は廃止）。
- 3 Python サービス: `~/maoka-platform/services/<svc>` で `docker compose up -d --build`。
  - SQLite DB は新 `./data` を旧 `~/docker/<svc>/data`（henry-user-settings は `~/henry-user-settings/data`）へ **symlink** して現位置維持。
  - 旧 `~/docker/<svc>`・`~/henry-user-settings` は **停止・ロールバック用に残置**（C-4 で撤去予定）。
- 退院サマリー cron: `~/maoka-platform/packages/discharge-summary-gen` から `node_modules/.bin/tsx src/index.ts --confirm`（毎日 7:30）。
  - `.env`/`.secrets` は旧 `~/discharge-summary-gen/` へ symlink（生トークンキャッシュは現位置維持）。
  - pnpm は corepack で `~/.local/bin` に導入。`pnpm install --filter discharge-summary-gen...` で `@maoka/contracts`(workspace) を解決。

## ステータス

- **C-3（RaspberryPi）完了**: Python 3サービス + 退院サマリー cron を monorepo（clone+pull）にカットオーバー、全サービス稼働確認（reboot 永続: restart=unless-stopped）。退院 cron の初回本番実行は翌朝 7:30。
- C-4（旧repo正式 archive + 旧ディレクトリ撤去）は別途。
- 詳細は GitHub Issue `shin-926/maoka-platform#1` を参照。

> このリポジトリの GitHub 上での正式 archive は C-4 でまとめて行う。
> Mac 側の壊れ symlink（`discharge-summary-gen/.env`・`.secrets` が削除済み ward-board-sync を指す dangling）は C-4 整理時に削除。
