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
| Nextcloud | 8888 | `~/docker/nextcloud/docker-compose.yml` |
| Home Assistant | 8123 | `~/docker/homeassistant/docker-compose.yml` |
| Whisper (STT) | 10300 | `~/docker/whisper/docker-compose.yml` |

## ファイル構成 (ラズパイ側)

| パス | 内容 |
|------|------|
| `/var/www/html/` | 公開Webページ |
| `/etc/nginx/` | Nginx設定 |
| `~/docker/` | Docker Compose設定 |
| `~/ward-board-sync/` | 病棟ボード同期スクリプト（cron） |
| `~/.config/gcloud/` | ADC認証情報（Firebase Admin SDK用） |

## Cronジョブ

| ジョブ | スケジュール | 内容 | ログ |
|------|------------|-----|-----|
| ward-board-sync | 毎日 7:00 / 18:00 JST | Henry入院患者リストをFirestore (`maokahp-webapps`) の `wardPatients` コレクションに同期 | `~/ward-board-sync/sync.log` |

`crontab -l` で確認・編集。

### ward-board-sync 詳細
- **Macソース**: `~/Documents/RaspberryPi/ward-board-sync/`
- **認証**: ADC（Firestore） + Firebase refresh token（Henry GraphQL）
- **シークレット**: `.env` と `.secrets/token-cache.json`（gitignore済）
- **手動実行**: `ssh raspberrypi 'cd ~/ward-board-sync && npm run sync'`
- **再デプロイ**: `rsync -av --exclude='node_modules' ~/Documents/RaspberryPi/ward-board-sync/ raspberrypi:~/ward-board-sync/`

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
- [x] Nextcloud導入
- [x] Home Assistant導入（Philips Hue連携、Android TV Remote、Gemini音声アシスタント）
- [ ] sk924.com をカッコよくする
- [ ] サブドメインで複数サービス公開
- [ ] Nextcloud（自分専用クラウドストレージ）
- [ ] Home Assistant（スマートホーム）
