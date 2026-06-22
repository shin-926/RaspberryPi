# Raspberry Pi ノート

## 作業ログ

### 2026-02-09 (Day 1) - 初期セットアップ

1. **ラズパイ発見**: ローカルネットワークをポートスキャン (`nc`) して 192.168.10.10 を特定
2. **SSH鍵認証設定**: Mac側で `ssh-keygen -t ed25519` で鍵生成 → ラズパイの `~/.ssh/authorized_keys` に登録
3. **Nginx インストール**: `sudo apt install nginx` → `http://192.168.10.10` でデフォルトページ確認
4. **オリジナルページ作成**: `/var/www/html/index.html` を差し替え
5. **ドメイン取得**: Cloudflare Registrar で `sk924.com` を購入 ($10.46/年)
6. **Cloudflare Tunnel 設定**:
   - `cloudflared` をラズパイにインストール
   - Cloudflare Zero Trust (Free) に登録
   - トンネル `raspberrypi` を作成・接続
   - `sk924.com` → `HTTP://localhost:80` にルーティング
7. **外部公開成功**: iPhoneからモバイル回線 (Wi-Fiオフ) で https://sk924.com にアクセス確認

### 2026-02-10 (Day 2) - Cloudflare Tunnel経由SSH設定

1. **Cloudflareダッシュボードで設定追加**: Published application routes に `ssh.sk924.com → ssh://localhost:22` を追加
2. **Mac側にcloudflaredインストール**: `brew install cloudflared`
3. **SSH config作成** (`~/.ssh/config`):
   - `ssh raspberrypi` → ローカル接続 (192.168.10.10)
   - `ssh ssh.sk924.com` → Cloudflare Tunnel経由（外出先用）
4. **接続テスト成功**: Tunnel経由でホスト鍵を登録し接続確認

**補足**:
- cloudflaredはトークンベースで稼働（config.ymlではなくダッシュボードで管理）
- Tunnel経由SSHは `ProxyCommand cloudflared access ssh --hostname %h` を使用

### 2026-02-11 (Day 3) - SSDブート化 & 固定IP設定

1. **USB SSD準備**: M.2 NVMe SSD (256GB) を既存ケース (RSH-329) に装着
2. **OS書き込み**: Raspberry Pi Imager v2.0.6 で SSD に Raspberry Pi OS (64-bit) を書き込み
   - Hostname: raspberrypi、SSH鍵認証、ユーザー shinichiro を設定
3. **SSDブート成功**: microSD を抜き、USB 3.0（青）ポートから SSD ブート
4. **固定IP設定**: NetworkManager (`nmcli`) で 192.168.10.10 に固定
   - DHCPではなくNetworkManagerが有効だった（dhcpcd.confは効かない）
5. **Nginx再インストール**: `sudo apt install nginx`
6. **cloudflared再インストール**: Cloudflareリポジトリ追加 → `sudo apt install cloudflared` → トークンでサービス登録
7. **全サービス復旧確認**:
   - Web (https://sk924.com) → OK
   - SSH ローカル (`ssh raspberrypi`) → OK
   - SSH Tunnel (`ssh ssh.sk924.com`) → OK
   - Cloudflareダッシュボード → HEALTHY

**補足**:
- ストレージ: 58GB (microSD) → 238GB (USB SSD) に拡大
- ネットワーク管理: NetworkManager (nmcli) を使用。dhcpcd は無効
- SSD入れ替え時はホスト鍵が変わるため `ssh-keygen -R` で古い鍵を削除する必要あり

### 2026-02-11 (Day 3 続き) - Docker導入 & Uptime Kuma

1. **Dockerインストール**: `curl -fsSL https://get.docker.com | sudo sh`
   - Docker v29.2.1 + Docker Compose v5.0.2
   - `sudo usermod -aG docker shinichiro` でsudoなし実行を設定
2. **Uptime Kuma起動**: Docker Composeで監視ダッシュボードを構築
   - 設定ファイル: `~/docker/uptime-kuma/docker-compose.yml`
   - アクセス: `http://192.168.10.10:3001`
   - sk924.com の死活監視を登録

**補足**:
- Dockerコンテナは `docker compose down` で完全に削除可能
- Nginx/cloudflaredは直接インストール、Uptime KumaはDocker上で稼働

### 2026-02-11 (Day 3 続き) - Pi-hole導入

1. **Pi-hole起動**: Docker Composeで広告ブロックDNSサーバーを構築
   - 設定ファイル: `~/docker/pihole/docker-compose.yml`
   - 管理画面: `http://192.168.10.10:8080/admin`
   - パスワード: 1Passwordに保存
2. **リスニングモード変更**: `LOCAL` → `ALL` に変更（Docker経由だとローカルネットワークが認識されないため）
3. **MacのDNSをPi-holeに変更**: `networksetup -setdnsservers Wi-Fi 192.168.10.10`
   - 元のDNS: `8.8.8.8`（Google）
   - 戻すコマンド: `networksetup -setdnsservers Wi-Fi 8.8.8.8`

4. **iPhoneもPi-hole経由に設定**:
   - Wi-Fi設定 → DNSを手動で `192.168.10.10` に変更
   - 「IPアドレスのトラッキング」をオフ（iCloudプライベートリレーが自宅Wi-Fiで無効に）
5. **ルーターのDNS設定**: Aterm WX3600HPはDHCPで配布するDNSを変更できない機種のため、デバイスごとに手動設定が必要

**補足**:
- Pi-holeは広告配信ドメインをDNSレベルでブロックする仕組み
- Pi-holeの上流DNS: 8.8.8.8, 8.8.4.4 (Google DNS)
- iPhoneのiCloudプライベートリレーはDNSを横取りするため、自宅Wi-Fiではオフにする必要あり
- ルーター (Aterm WX3600HP) はDHCPのDNS配布設定不可。デバイスごとに手動設定で対応
- ルーターのWAN側DNS設定（ネームサーバ）をPi-holeに変更しても、LAN内デバイスのDNSには影響しない（WAN側DNSはルーター自身が使うもの）

### 2026-02-11 (Day 3 続き) - 固定IPをDHCP範囲外に変更

1. **ルーターのDHCP範囲確認**: 192.168.10.101 〜 192.168.10.200
2. **ラズパイの固定IPを変更**: 192.168.10.116 → 192.168.10.10（DHCP範囲外）
   - `sudo nmcli connection modify 'netplan-eth0' ipv4.addresses 192.168.10.10/24`
3. **関連設定の更新**: SSH config、Mac/iPhoneのDNS設定

### 2026-02-11 (Day 3 続き) - Tailscale導入

1. **Tailscaleアカウント作成**: Googleアカウントでサインアップ（無料プラン）
2. **Macにインストール**: Mac App Store からインストール、ネットワーク機能拡張を有効化
3. **ラズパイにインストール**: `curl -fsSL https://tailscale.com/install.sh | sh` → `sudo tailscale up` で認証
4. **iPhoneにインストール**: App Store からインストール
5. **接続確認**: 外出先からでもTailscale IP経由で全サービスにアクセス可能に

**Tailscale IP**:
- Mac: 100.90.204.60
- ラズパイ: 100.103.119.9

**補足**:
- TailscaleはデバイスのNAT越えを行い、デバイス同士が直接通信するVPN
- Cloudflare Tunnelはインターネット公開用、Tailscaleはプライベートアクセス用で役割が異なる
- アプリをインストールしたデバイスだけが接続できるため安全

### 2026-02-11 (Day 3 続き) - Nextcloud導入

1. **Nextcloud起動**: Docker Composeで自前クラウドストレージを構築
   - 設定ファイル: `~/docker/nextcloud/docker-compose.yml`
   - コンテナ: nextcloud (本体) + nextcloud-db (MariaDB)
   - アクセス: `http://192.168.10.10:8888`
   - Tailscale経由: `http://100.103.119.9:8888`

**補足**:
- Nextcloudは自前のGoogle Drive / iCloudのようなサービス
- データは全てラズパイのSSDに保存される
- パスワードは1Passwordに保存

### 2026-02-11 (Day 3 続き) - Home Assistant導入

1. **Home Assistant起動**: Docker Composeでスマートホームハブを構築
   - 設定ファイル: `~/docker/homeassistant/docker-compose.yml`
   - アクセス: `http://192.168.10.10:8123`
   - Tailscale経由: `http://100.103.119.9:8123`
   - `network_mode: host` で動作（LAN内デバイス検出のため）
2. **Philips Hue連携**: Hue Bridgeを自動検出 → ブリッジのボタン押しで認証 → 全ライト（10個以上）を認識
3. **動作確認**: ダッシュボードからライトのオン/オフ操作成功

**補足**:
- Home Assistantはスマートホーム機器を一元管理するハブ
- Tailscale経由で外出先からもライト操作可能
- パスワードは1Passwordに保存

### 2026-02-11 (Day 3 続き) - Gemini AI × Home Assistant連携

1. **Gemini API キー取得**: Google AI Studio でプロジェクト作成 → APIキー発行（無料枠）
2. **Home AssistantにGemini統合を追加**: 設定 → デバイスとサービス → Google Gemini を追加
   - Google AI Conversation（会話エージェント）
   - Google AI STT（音声→テキスト変換）
   - Google AI TTS（テキスト→音声変換）
3. **音声アシスタント作成**: 名前「Gemini」、会話エージェント=Google AI Conversation、STT=Google AI STT、TTS=Google AI TTS
4. **TTS無効化**: TTS (gemini-2.5-flash-tts) の無料枠が1日10リクエストと少ないため、一旦TTSをnullに設定しテキストベースで運用
   - 設定ファイル: `~/docker/homeassistant/config/.storage/assist_pipeline.pipelines`
   - バックアップ: `assist_pipeline.pipelines.bak`（TTS復元用）
5. **Hueライト操作成功**: エンティティはデフォルトで会話エージェントに公開されており、「キッチンのライトをつけて」等で操作可能
6. **Android TV Remote統合を追加**: TCL Google TV のリモコン操作（電源オン/オフ含む）が可能に
   - 設定 → デバイスとサービス → Android TV Remote → テレビのIPを入力 → ペアリング
7. **Cast統合を削除**: Cast と Android TV Remote で同名エンティティが重複し `DUPLICATE_NAME` エラーが発生したため、Cast統合をAPI経由で削除
   - `curl -X DELETE .../api/config/config_entries/entry/{entry_id}`
8. **テレビ操作成功**: Gemini から「テレビ消して」「テレビつけて」で電源操作可能に
9. **Gemini API 有料化**: 無料枠の1日20リクエスト制限に達したため、Google Cloud 課金アカウントをリンク
   - Google AI Studio → お支払い → お支払い情報を設定
   - 予算アラート: 月額¥750（50%/90%/100%でメール通知）
   - Home Assistantの長期アクセストークンを発行（1Passwordに保存）

**補足**:
- Gemini API: gemini-2.5-flash モデルを使用。有料化によりレート制限が大幅緩和
- アシストへのアクセス: ダッシュボード右上 ⋮ → アシスト (A)
- APIキー・HAトークンは1Passwordに保存
- 同名エンティティが複数あるとインテントシステムが `DUPLICATE_NAME` エラーを出す。統合削除かリネームで解消

### 2026-02-11 (Day 3 続き) - HTTPS化 & 音声アシスタント完成

1. **Home Assistant HTTPS化**: Cloudflare Tunnelで `ha.sk924.com` → `http://localhost:8123` を追加
   - `configuration.yaml` に trusted_proxies 設定を追加（172.16.0.0/12, 127.0.0.1, ::1）
   - ブラウザからマイクを使うにはHTTPSが必須（HTTPだと `[object Object]` エラー）
2. **Google AI STT 日本語対応**: STTプロンプトを `"Transcribe the attached audio in Japanese. Output the transcription in Japanese."` に変更
   - デフォルトの `"Transcribe the attached audio"` では英語として認識されてしまう
   - 設定ファイル: `~/docker/homeassistant/config/.storage/core.config_entries` の STT subentry
3. **音声アシスタント完成**: 音声入力→Gemini処理→音声出力の全フローが動作
   - STT: Google AI STT（日本語）
   - 会話: Google AI Conversation（gemini-2.5-flash）
   - TTS: Google AI TTS（voice: zephyr）
   - 「テレビ消して」→ テレビが消えて「テレビを消しました。」と音声で返答

**補足**:
- HTTPS経由: `https://ha.sk924.com`（Cloudflare Tunnelが証明書を提供）
- HA設定編集時は `docker stop homeassistant` → 編集 → `docker start homeassistant`（実行中の編集はHAに上書きされる）
- STTプロンプトの変更は `.storage/core.config_entries` ファイルを直接編集（sudoが必要）
- iPhoneからも操作可能: Home Assistant Companion App + Siriショートカット/背面タップ

### 2026-02-11 (Day 3 続き) - iPhone Companion App & スマートスピーカー検討

1. **iPhone Companion App設定**: App Storeから「Home Assistant」をインストール
   - サーバーURL: `https://ha.sk924.com`
   - アシストからマイクで音声操作可能
2. **Siriショートカット作成**: 「Assist In App」（Legacy）でショートカット作成
   - iPhoneの背面タップ（設定 → アクセシビリティ → タッチ → 背面タップ）に割り当て
   - 背面ダブルタップでアシスト起動
3. **スマートスピーカー化の検討**:
   - iPhoneはバックグラウンド常時マイク不可 → ウェイクワード（「アレクサ」的な起動）は無理
   - Google TVの組み込みアシスタントをHA Geminiに置き換えるのも不可
   - ESP32ベースの専用デバイスが必要
4. **M5Stack ATOM EchoS3R を注文**:
   - ESP32-S3搭載（ウェイクワード対応）、高品質マイク/スピーカー（ES8311コーデック）
   - 旧型ATOM Echo（ESP32無印）はウェイクワード非対応なので注意
   - ウェイクワード候補: "Alexa", "Hey Jarvis", "Hey Mycroft", "OK Nabu"
   - 届いたらESPHomeでファームウェア書き込み → Geminiパイプライン接続予定

**補足**:
- Google TVのGoogle Assistantは2026年中にGemini化される予定（Google側の対応。HA連携とは別）
- ATOM EchoS3R ($14.50) vs 旧型ATOM Echo ($13): 価格ほぼ同じだがS3Rの方が圧倒的に高性能
- Home Assistant Voice PE ($59) は日本での入手が困難（海外通販のみ）

### 2026-02-12 (Day 4) - Web技術の基礎学習 & ツール理解

1. **外出先からラズパイ接続確認**: カフェからCloudflare Tunnel経由でSSH接続成功
   - Tailscaleは接続タイムアウト（MacのTailscaleアプリがオフの可能性）
   - ラズパイ健全性確認: CPU温度48.3°C、メモリ1.7GB/4GB、ディスク8%使用
2. **tmux導入**: Mac上でtmuxセッション（study）を作成し、Claude Codeから画面を確認できる環境を構築
   - `tmux capture-pane -t study -p` でセッションの画面内容を取得
3. **書籍「プロになるためのWeb技術入門」学習再開**:
   - サンプルコードリポジトリ: `github.com/little-forest/webtech-fundamentals`
   - Mac に `~/Documents/webtech-fundamentals` としてクローン
   - 6.2.2: ファイルの内容を返すWebアプリケーション（`http.FileServer`）
   - 6.3.1〜6.3.2: 固定ToDoを表示するTiny ToDo（テンプレートエンジン）
   - 6.3.3: ToDo追加機能（POSTリクエスト、フォーム送信）
4. **環境構築**:
   - Mac/ラズパイにGoをインストール（Mac: Go 1.25.7、ラズパイ: Go 1.24.4）
   - VS Codeの `code` コマンドをPATHに追加

**学んだ概念**:
- **Git**: clone（まるごとコピー）vs pull（差分更新）、`.git`フォルダが全ての履歴を管理
- **tmux**: Terminal Multiplexer。セッション維持 + 画面分割。tmuxサーバーが独立プロセスとして動くためSSH切断に耐える
- **TCP接続**: 3ウェイハンドシェイク、keepalive（idle:2時間→interval:75秒×8回）、「管」の正体は両OSが記憶する接続情報
- **SSHセッション**: sshd（門番）が接続ごとに子プロセスを生成。切断時は子プロセスも終了
- **Go**: net/httpパッケージ、多値返却によるエラー処理、テンプレートエンジン、GET vs POSTの違い

### 2026-06-17 - Henry Telemetry サーバー追加

Henry拡張のエラーテレメトリ受信 + 閲覧ダッシュボードをラズパイで運用するためのサービスを追加。

**配置**: `~/Projects/RaspberryPi/henry-telemetry/`（Mac側） → ラズパイへ転送 → Docker で起動

**エンドポイント**:
- `POST /api/henry-telemetry` — 拡張からのエラーイベント受信（バッチ）
- `GET /api/henry-telemetry/events` — クエリAPI（ダッシュボード用）
- `GET /api/henry-telemetry/stats` — 集計API
- `GET /telemetry/` — 閲覧ダッシュボード (HTML)

**ポート**: 3004（3003 は henry-user-settings が使用中）

**ストレージ**: SQLite `/data/henry-telemetry.db`（ボリュームマウント `./data:/data`）

#### デプロイ手順

```bash
# Mac側 → ラズパイへ転送
scp -r ~/Projects/RaspberryPi/henry-telemetry raspberrypi:~/docker/

# ラズパイ側
ssh raspberrypi
cd ~/docker/henry-telemetry
docker compose up -d --build
docker compose logs -f henry-telemetry  # 起動確認

# ヘルスチェック
curl http://localhost:3004/health
```

#### Nginx 設定追加

`/etc/nginx/sites-enabled/default`（または該当ファイル）の `server { ... }` ブロック内に追加:

```nginx
# Henry Telemetry: 拡張からのエラー受信 API
location /api/henry-telemetry {
    proxy_pass http://localhost:3004;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # sendBeacon 経由の POST も拾えるよう Content-Type を緩める
    client_max_body_size 1m;
}

# Henry Telemetry: ダッシュボード閲覧
location /telemetry/ {
    proxy_pass http://localhost:3004/telemetry/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

適用:
```bash
sudo nginx -t   # 構文チェック
sudo systemctl reload nginx
```

#### 動作確認

```bash
# 1. 受信エンドポイント（Mac 等から）
curl -X POST https://sk924.com/api/henry-telemetry \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"timestamp":"2026-06-17T08:00:00Z","scriptName":"test","type":"console-error","message":"test event","context":{"url":"https://example.com","extensionVersion":"2.67.0","userAgent":"curl"}}]}'
# → {"received":1}

# 2. ダッシュボード
open https://sk924.com/telemetry/
```

#### PII 注意

- 患者UUID・医師UUID が SQLite に保存される（拡張側で含めて送信している）
- ダッシュボードは Cloudflare Tunnel 経由で公開されているため、本来はアクセス制限が必要
- 当面: Tailscale 経由のみ閲覧を推奨、ブックマークは `https://100.103.119.9/telemetry/` を使う
- 将来: Cloudflare Access （Zero Trust）で IdP 認証ゲートをかける

#### ログ確認

```bash
docker compose logs --tail 100 henry-telemetry
docker exec -it henry-telemetry sqlite3 /data/henry-telemetry.db \
  "SELECT received_at, script_name, type, substr(message,1,80) FROM events ORDER BY id DESC LIMIT 20"
```

---

### 2026-06-22 - discharge-summary-gen のデプロイ手順（重要・ハマりポイント）

退院サマリー自動生成（夜間 cron）と DPC連絡表生成のバッチ。**Docker ではなく、Pi 上で直接 `npx tsx` 実行**する点が他サービスと異なる。

**⚠️ git 管理外**: Pi の `~/discharge-summary-gen` は **git リポジトリではない**（`.DS_Store` がある＝Mac の Finder/scp 由来）。`git pull` ではデプロイできない。**デプロイ＝Mac→Pi の `src/` ファイルコピー**。

- 正は Mac 側の git repo `~/Projects/RaspberryPi/discharge-summary-gen`（origin: shin-926/RaspberryPi）
- Pi 側はそのデプロイ済みコピー。**ドリフトしうる**（コミットしても Pi にコピーしなければ反映されない）

#### cron（実行されているもの）

```
# Pi の crontab -l
30 7 * * * /bin/bash -lc "cd ~/discharge-summary-gen && npx tsx src/index.ts --confirm >> ~/discharge-summary-gen/cron.log 2>&1"
```
→ 毎日 7:30 に退院サマリー生成（`index.ts`）。DPC連絡表（`renraku.ts` / `generate-renraku-ff1.ts`）は cron 経路外で手動実行。

#### デプロイ手順

```bash
# 1. Mac 側でコミット（origin/main）
cd ~/Projects/RaspberryPi && git add discharge-summary-gen/src/... && git commit && git push

# 2. 変更した src ファイルを Pi へコピー（ssh.sk924.com = Cloudflare Tunnel経由 / raspberrypi = LAN/Tailscale どちらでも可）
cd ~/Projects/RaspberryPi/discharge-summary-gen/src
scp <変更ファイル>.ts ssh.sk924.com:'~/discharge-summary-gen/src/'

# 3. ドリフト確認（全 src のハッシュが Mac と一致するか）
ssh ssh.sk924.com 'cd ~/discharge-summary-gen/src && for f in *.ts; do md5sum "$f"; done' | sort -k2
#   ↑ Mac 側 `md5 -r *.ts` と突き合わせる。差分が出たら未デプロイのコミット漏れ
```

> **デプロイ前に必ずハッシュ比較**すること。過去、コミット済みだが未コピーのファイル（例: `renraku.ts` の `2a6721d`）が Pi に残っていた実績あり。`src/` 全体を毎回 rsync する運用に寄せると事故が減る（ただし Pi 側の `.env` / `.secrets` / `_cache` / `_in` / `_out` / `node_modules` は **コピー対象外**＝Pi 固有なので消さない）。

#### env（Pi 固有・Mac には無い）

`~/discharge-summary-gen/.env`（git 管理外）に `HENRY_FIREBASE_*` / `FIREBASE_PROJECT_ID` / `GOOGLE_*` 等。**AIプロキシ系の env（`AI_PROXY_BASE_URL` / `RENRAKU_LLM_PROVIDER` / `RENRAKU_LLM_MODEL`）は未設定**＝コード既定（gemini / sk924.com/api）で動作。

#### AI プロキシ呼び出し（2026-06-22 集約）

ai-proxy 呼び出しは `src/ai-client.ts`（`callAiProxy` / `parseAiProxyResponse` / `AI_MODELS`）に集約済み。`generate.ts`（退院サマリー, gemini）と `renraku-prompt.ts`（DPC, env で provider 切替）が共有。詳細は Henry Issue #131・`~/Projects/ARCHITECTURE.md §5`。
※ `/api/gemini` は正常。`/api/claude` は 502（claude API 未稼働のため放置）。
