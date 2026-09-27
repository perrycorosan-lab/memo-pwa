# メモ（PWA）

シンプルなメモ／ノート Progressive Web App です。  
日本語 UI・モバイルファースト・オフライン対応・インストール可能。  
**Google サインイン（Firebase Auth）＋ Firestore** で端末間同期もできます。

## 機能

- メモ一覧（タイトル・プレビュー・更新日時）
- **プロジェクト**でメモをグループ化（チップで絞り込み／管理モーダル）
- 作成・編集・削除（削除は確認ダイアログあり／ソフトデリートで同期）
- 空のときの案内（エンプティステート）
- **IndexedDB** をオフラインキャッシュとして永続保存
- **Firebase**: Google サインイン時にクラウドへリアルタイム同期（メモ＋プロジェクト）
- サインアウト時は従来どおりローカルのみで動作
- インストール可能な PWA（マニフェスト＋サービスワーカー）
- Android Chrome 向けの大きなタップ領域・セーフエリア対応

## データ構造

### メモ（notes）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | string | 一意 ID（UUID など） |
| `title` | string | タイトル |
| `content` | string | 本文 |
| `projectId` | string \| null | 所属プロジェクト。`null` / 未設定 = 未分類 |
| `updatedAt` | number | 更新時刻（UNIX ms） |
| `deletedAt` | number（任意） | ソフトデリート時刻。一覧には出ない |

### プロジェクト（projects）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | string | 一意 ID |
| `name` | string | 表示名 |
| `updatedAt` | number | 更新時刻（UNIX ms） |
| `deletedAt` | number（任意） | ソフトデリート。紐づくメモは `projectId: null` に更新 |

- **ローカル**: ブラウザの IndexedDB（`memo-pwa-db`、ストア `notes` / `projects`）
- **クラウド**（サインイン時）: Firestore `users/{uid}/notes/{noteId}` と `users/{uid}/projects/{projectId}`
- 競合時は **新しい `updatedAt` を優先** してマージします
- プロジェクト削除時、メモ本体は削除せず未分類へ移します

## ファイル構成

```
memo-pwa/
├── index.html                   # エントリ（SPA）
├── styles.css                   # スタイル
├── app.js                       # UI + IndexedDB
├── sync.js                      # Firebase Auth / Firestore 同期
├── firebase-config.js           # 設定ローダー
├── firebase-config.example.js   # 設定ひな形（コミット用）
├── firebase-config.local.js     # 実際の設定（gitignore・自分で作成）
├── sw.js                        # サービスワーカー（Firebase CDN は非キャッシュ）
├── manifest.webmanifest
├── icons/
├── .gitignore
└── README.md
```

ビルド不要です。Firebase JS SDK v10（modular）を gstatic CDN から読み込みます。

---

## Firebase セットアップ手順（コンソール操作）

### 1. プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com/) を開く
2. **プロジェクトを追加** → 名前を入力（例: `memo-pwa`）
3. Google アナリティクスは任意（オフでも可）→ 作成完了を待つ

### 2. Google 認証を有効化

1. 左メニュー **ビルド** → **Authentication**
2. **始める**（初回）
3. **Sign-in method** タブ → **Google** を選択
4. **有効にする** をオン
5. プロジェクトのサポートメールを選択 → **保存**

### 3. Firestore データベースを作成

1. 左メニュー **ビルド** → **Firestore Database**
2. **データベースの作成**
3. ロケーション（リージョン）を選択（例: `asia-northeast1`）
4. 最初は **テストモード** で開始してよい（後でルールを必ず変更）
5. 作成完了を待つ

### 4. セキュリティルール（自分のノートのみ）

Firestore → **ルール** タブに以下を貼り付けて **公開** します。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/notes/{noteId} {
      allow read, write: if request.auth != null
                         && request.auth.uid == userId;
    }
    match /users/{userId}/projects/{projectId} {
      allow read, write: if request.auth != null
                         && request.auth.uid == userId;
    }
  }
}
```

これで **サインインしたユーザー本人の `users/{uid}/notes/**` と `users/{uid}/projects/**` 以外は読み書きできません**。

### 5. Web アプリを登録して設定値を取得

1. プロジェクト概要（歯車の左の **</>** または「アプリを追加」）→ **Web**（`</>`）
2. アプリのニックネーム（例: `memo-pwa-web`）を入力
3. 「Firebase Hosting も設定する」は不要ならオフ
4. **アプリを登録**
5. 表示される `firebaseConfig` オブジェクトをコピー

例:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
```

### 6. このアプリに設定を入れる

**方法 A（推奨）: ローカルファイル**

```bash
cd memo-pwa
cp firebase-config.example.js firebase-config.local.js
# firebase-config.local.js を編集し、コンソールの値を貼る
```

`firebase-config.local.js` は `.gitignore` 済みです。**本物のキーをリポジトリにコミットしないでください**。

**方法 B: インライン注入**

`index.html` のコメント例どおり、`app.js` より前に:

```html
<script>
  window.__FIREBASE_CONFIG__ = { /* コンソールの値 */ };
</script>
```

優先順位: `window.__FIREBASE_CONFIG__` → `firebase-config.local.js`

### 7. 承認済みドメイン（本番 URL）

Authentication → **Settings** → **Authorized domains** に、デプロイ先ドメインを追加します。

- ローカル: `localhost` は通常すでに登録済み
- GitHub Pages 例: `yourname.github.io`

### 8. 動作確認

1. 静的サーバーでアプリを開く（下記）
2. ヘッダー下の **「Googleでサインイン」** を押す
3. 同期ステータスが「同期済み」になること
4. 別ブラウザ／スマホでも同じ Google アカウントでサインインし、メモが揃うこと
5. サインアウト後もローカルメモは残り、新規作成もローカルで可能

---

## ローカルでの試し方

任意の静的サーバーでルートを配信してください（`file://` では IndexedDB / Service Worker / ES modules が制限されます）。

```bash
cd memo-pwa
cp firebase-config.example.js firebase-config.local.js
# 上記を編集してから:

python3 -m http.server 8080
# または: npx --yes serve -l 8080 .
```

ブラウザで `http://localhost:8080/` を開きます。

Firebase 未設定でも **ローカルメモは使えます**（ステータス「未設定」、サインインボタンは無効）。

## GitHub Pages への配置

1. このフォルダ一式をリポジトリに配置（**`firebase-config.local.js` は含めない**）
2. 本番では次のいずれかで設定を渡す:
   - CI／デプロイ時に `firebase-config.local.js` を生成する
   - または `index.html` に `window.__FIREBASE_CONFIG__` を埋め込む（公開リポジトリでは API キーが見える点に注意。Firestore ルールで保護するのが前提）
3. GitHub Pages を有効化
4. Firebase の承認済みドメインに Pages のホストを追加

パスは相対（`./`）のためサブパス配下でも動作します。

## インストール（Android Chrome）

1. HTTPS（または localhost）で開く
2. メニュー →「アプリをインストール」／ホーム画面に追加

## 同期の動き（概要）

| 状態 | 動作 |
|------|------|
| 未サインイン | IndexedDB のみ。従来どおりオフライン動作 |
| サインイン直後 | ローカルとクラウドを `updatedAt` でマージ（新しい方優先）し、不足分を双方向反映 |
| サインイン中 | Firestore `onSnapshot` でリアルタイム反映。保存・削除時は即プッシュ |
| 削除 | `deletedAt` 付きソフトデリートを同期（他端末の一覧からも消える） |
| プロジェクト | 作成・改名・削除を同様に同期。削除時は紐づくメモの `projectId` を `null` に更新してプッシュ |

## サービスワーカーと Firebase

- アプリ本体はキャッシュしてオフライン起動可能
- `gstatic` / `googleapis` など Firebase CDN・API は **キャッシュせずネットワークへ透過**
- `firebase-config.local.js` もキャッシュしません
- キャッシュ名: `memo-pwa-v7`（変更時は次回訪問で旧キャッシュ破棄）

## 注意事項・制限

- Firebase の **API キー自体はクライアント公開が前提**です。必ず Firestore ルールでユーザー単位に制限してください
- テストモードのまま本番公開しないでください
- プライベートブラウズでは IndexedDB / 認証が制限されることがあります
- ポップアップがブロックされる環境ではリダイレクトサインインにフォールバックします

## ライセンス

個人利用・改変自由です。
