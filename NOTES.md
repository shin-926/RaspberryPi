# Raspberry Pi ノート

## 作業ログ

### 2026-02-09 (Day 1) - 初期セットアップ

1. **ラズパイ発見**: ローカルネットワークをポートスキャン (`nc`) して 192.168.10.116 を特定
2. **SSH鍵認証設定**: Mac側で `ssh-keygen -t ed25519` で鍵生成 → ラズパイの `~/.ssh/authorized_keys` に登録
3. **Nginx インストール**: `sudo apt install nginx` → `http://192.168.10.116` でデフォルトページ確認
4. **オリジナルページ作成**: `/var/www/html/index.html` を差し替え
5. **ドメイン取得**: Cloudflare Registrar で `sk924.com` を購入 ($10.46/年)
6. **Cloudflare Tunnel 設定**:
   - `cloudflared` をラズパイにインストール
   - Cloudflare Zero Trust (Free) に登録
   - トンネル `raspberrypi` を作成・接続
   - `sk924.com` → `HTTP://localhost:80` にルーティング
7. **外部公開成功**: iPhoneからモバイル回線 (Wi-Fiオフ) で https://sk924.com にアクセス確認
