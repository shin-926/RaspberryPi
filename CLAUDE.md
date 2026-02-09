# Raspberry Pi 5 プロジェクト

## 接続情報

| 項目 | 値 |
|------|---|
| ホスト名 | raspberrypi |
| IP (ローカル) | 192.168.10.116 |
| ユーザー | shinichiro |
| SSH認証 | 鍵認証 (`~/.ssh/id_ed25519`) |
| OS | Debian 13 (trixie) / aarch64 |
| メモリ | 4GB |
| ストレージ | 58GB (microSD) |

## SSH接続

```bash
ssh shinichiro@192.168.10.116
```

## ドメイン・公開設定

| 項目 | 値 |
|------|---|
| ドメイン | sk924.com |
| DNS/CDN | Cloudflare |
| トンネル | Cloudflare Tunnel (`raspberrypi`) |
| Webサーバー | Nginx |
| 公開URL | https://sk924.com |

## インストール済み

- Nginx
- cloudflared
- Python 3.13
- git, curl, wget

## ファイル構成 (ラズパイ側)

| パス | 内容 |
|------|------|
| `/var/www/html/index.html` | 公開Webページ |
| `/etc/nginx/` | Nginx設定 |

## 今後やりたいこと

- [ ] Docker導入
- [ ] サブドメインで複数サービス公開
- [ ] ページの中身を本格的にする
