# Raspberry Pi 5 プロジェクト

## 接続情報

| 項目 | 値 |
|------|---|
| ホスト名 | raspberrypi |
| IP (ローカル) | 192.168.10.10 |
| ユーザー | shinichiro |
| SSH認証 | 鍵認証 (`~/.ssh/id_ed25519`) |
| OS | Debian 13 (trixie) / aarch64 |
| メモリ | 4GB |
| ストレージ | 238GB (USB SSD) |
| IP設定 | 固定IP (NetworkManager) |
| Tailscale IP | 100.103.119.9 |

## SSH接続

| 場所 | コマンド | 経由 |
|------|---------|------|
| 自宅LAN | `ssh raspberrypi` | 直接 (192.168.10.10、DHCP範囲外) |
| 外出先 | `ssh ssh.sk924.com` | Cloudflare Tunnel |
| 外出先 (Tailscale) | `ssh 100.103.119.9` | Tailscale VPN |

設定ファイル: `~/.ssh/config`

## ドメイン・公開設定

| 項目 | 値 |
|------|---|
| ドメイン | sk924.com |
| DNS/CDN | Cloudflare |
| トンネル | Cloudflare Tunnel (`raspberrypi`) |
| トンネル管理 | トークンベース（Cloudflareダッシュボードで設定） |
| Webサーバー | Nginx |
| 公開URL (Web) | https://sk924.com |
| 公開URL (SSH) | ssh.sk924.com |
| 公開URL (HA) | https://ha.sk924.com |

## インストール済み

### ラズパイ
- Nginx
- cloudflared
- Tailscale
- Docker + Docker Compose
- Python 3.13
- Node.js 22 LTS + npm
- Google Cloud SDK (gcloud CLI、ADC設定済み: `maokahp-webapps`)
- git, curl, wget

### Mac
- cloudflared (`brew install cloudflared`)
- Tailscale (Mac App Store)
- Raspberry Pi Imager

## Dockerサービス

| サービス | ポート | 設定ファイル |
|---------|-------|------------|
| Uptime Kuma | 3001 | `~/docker/uptime-kuma/docker-compose.yml` |
| Pi-hole | 8080 (Web), 53 (DNS) | `~/docker/pihole/docker-compose.yml` |
| ai-proxy | 3002 | `~/ai-proxy/docker-compose.yml` (Mac側 `~/Documents/RaspberryPi/ai-proxy/`) |
| henry-user-settings | 3003 | `~/henry-user-settings/docker-compose.yml` (Mac側 `~/Documents/RaspberryPi/henry-user-settings/`) |

## ファイル構成 (ラズパイ側)

| パス | 内容 |
|------|------|
| `/var/www/html/` | 公開Webページ |
| `/etc/nginx/` | Nginx設定 |
| `~/docker/` | Docker Compose設定 |
| `~/discharge-summary-gen/` | 退院サマリー自動生成スクリプト（cron） |
| `~/ai-proxy/` | Claude/Gemini API プロキシ (Docker) |
| `~/henry-user-settings/` | Henry拡張のユーザー設定同期サーバー (Docker) |
| `~/kango-shift/` | 看護シフト管理アプリ (Docker) |
| `~/backup/` | バックアップログ (`backup.log`) |
| `/usr/local/bin/rpi-backup.sh` | 重要データのGoogle Driveバックアップスクリプト |
| `~/.config/gcloud/` | ADC認証情報（Firebase Admin SDK用） |
| `~/.config/rclone/rclone.conf` | rclone設定（gdrive remote）|

## Cronジョブ

| ジョブ | スケジュール | 実行ユーザー | 内容 | ログ |
|------|------------|------------|-----|-----|
| discharge-summary-gen | 毎日 7:30 JST | shinichiro | 退院サマリー自動生成 | `~/discharge-summary-gen/cron.log` |
| rpi-backup | 毎日 3:00 JST | root | 重要データを Google Drive へバックアップ（30日保持）| `~/backup/backup.log` |

確認・編集: `crontab -l`（user） / `sudo crontab -l`（root）

### バックアップ詳細
- **対象**: `henry-user-settings.db`, `kango.db`, 各 `.env` / `.secrets/`, `~/.config/gcloud/`, `~/.ssh/`, `/etc/nginx/`, `cloudflared.service`
- **保存先**: Google Drive `RaspberryPi-Backup/` フォルダ
- **保持期間**: 30日（自動削除）
- **手動実行**: `ssh raspberrypi 'sudo /usr/local/bin/rpi-backup.sh'`
- **復元**: `rclone copy gdrive:RaspberryPi-Backup/rpi-backup-YYYYMMDD-HHMMSS.tar.gz .` → 展開して配置

## ネットワーク設定

| 項目 | 値 |
|------|---|
| MacのDNS | Pi-hole (192.168.10.10) |
| iPhoneのDNS | Pi-hole (192.168.10.10、手動設定) |
| 元のDNS | 8.8.8.8 (Google) |
| DNS戻すコマンド | `networksetup -setdnsservers Wi-Fi 8.8.8.8` |
| ルーター | Aterm WX3600HP（DHCPのDNS配布変更不可） |

## Tailscale

| デバイス | Tailscale IP |
|---------|-------------|
| Mac | 100.90.204.60 |
| ラズパイ | 100.103.119.9 |
| iPhone | インストール済み |

外出先からTailscale経由でアクセス可能:
- `http://100.103.119.9` → Web
- `http://100.103.119.9:3001` → Uptime Kuma
- `http://100.103.119.9:8080/admin` → Pi-hole

## 今後やりたいこと

- [x] Docker導入
- [x] Tailscale導入
- [ ] sk924.com をカッコよくする
- [ ] サブドメインで複数サービス公開
