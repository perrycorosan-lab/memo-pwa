# メモ（PWA）

シンプルなメモ／ノート Progressive Web App です。  
日本語 UI・モバイルファースト・オフライン対応・インストール可能。

## 機能

- メモ一覧（タイトル・プレビュー・更新日時）
- 作成・編集・削除（削除は確認ダイアログあり）
- 空のときの案内（エンプティステート）
- **IndexedDB** に永続保存（リロード・再起動後も残ります）
- インストール可能な PWA（マニフェスト＋サービスワーカー）
- Android Chrome 向けの大きなタップ領域・セーフエリア対応

## データ構造

各メモは次のフィールドを持ちます。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | string | 一意 ID（UUID など） |
| `title` | string | タイトル |
| `content` | string | 本文 |
| `updatedAt` | number | 更新時刻（UNIX ms） |

ブラウザの IndexedDB（データベース名: `memo-pwa-db`）に保存されます。サーバーには送信しません。

## ファイル構成

```
memo-pwa/
├── index.html              # エントリ（SPA）
├── styles.css              # スタイル
├── app.js                  # UI + IndexedDB
├── sw.js                   # サービスワーカー（オフラインシェル）
├── manifest.webmanifest    # PWA マニフェスト
├── icons/                  # アプリアイコン
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── icon-maskable-192.png
│   ├── icon-maskable-512.png
│   └── icon.svg
└── README.md
```

ビルド不要です。静的ファイルをそのまま配信できます。

## ローカルでの試し方

任意の静的サーバーでルートを配信してください（`file://` では IndexedDB / Service Worker が制限されることがあります）。

```bash
# 例: Python
cd memo-pwa
python3 -m http.server 8080

# 例: npx
npx --yes serve -l 8080 .
```

ブラウザで `http://localhost:8080/` を開きます。

## GitHub Pages への配置

1. このフォルダ一式をリポジトリに配置します（ルートでも `docs/` でも、サブディレクトリでも可）。
2. GitHub Pages を有効化します。
3. パスは相対パス（`./`）になっているため、サブパス配下でも動作します。

例: `https://<user>.github.io/<repo>/` や `https://<user>.github.io/<repo>/memo-pwa/`

## インストール（Android Chrome）

1. HTTPS（または localhost）で開く
2. メニュー →「アプリをインストール」／ホーム画面に追加

アプリアイコン名・ショートネームは「メモ」、テーマカラーは柔らかい黄色（`#FFECB3`）です。

## 注意事項・制限

- **オフライン**: アプリ本体（HTML/CSS/JS/アイコン）はキャッシュされます。メモデータは端末の IndexedDB にあります。
- **データ移行**: ブラウザ／端末を変えるとデータは引き継がれません（エクスポート機能は未実装）。
- **プライベートブラウズ**: 一部環境では IndexedDB が制限されることがあります。
- **HTTPS**: 本番の PWA（インストール・Service Worker）には HTTPS が必要です。
- サービスワーカーのキャッシュ名を変えると次回訪問で古いキャッシュが破棄されます（`sw.js` の `CACHE_NAME`）。

## ライセンス

個人利用・改変自由です。
