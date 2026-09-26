/**
 * Firebase 設定のひな形です。
 *
 * 使い方:
 * 1. このファイルをコピーして firebase-config.local.js を作成する
 *    cp firebase-config.example.js firebase-config.local.js
 * 2. Firebase コンソールで取得した Web アプリ設定値を下に貼り付ける
 * 3. firebase-config.local.js は .gitignore 済み（コミットしないこと）
 *
 * または index.html で window.__FIREBASE_CONFIG__ を先に定義しても動作します。
 */
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID'
};
