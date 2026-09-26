/**
 * Firebase 設定ローダー
 * 優先順位:
 * 1. window.__FIREBASE_CONFIG__（インライン注入）
 * 2. ./firebase-config.local.js（gitignore されたローカルファイル）
 * 見つからない／プレースホルダのままなら null を返す
 */
function isPlaceholder(config) {
  if (!config || typeof config !== 'object') return true;
  const key = String(config.apiKey || '');
  const projectId = String(config.projectId || '');
  if (!key || !projectId) return true;
  if (key.includes('YOUR_') || projectId.includes('YOUR_')) return true;
  return false;
}

export async function loadFirebaseConfig() {
  if (typeof window !== 'undefined' && window.__FIREBASE_CONFIG__) {
    const cfg = window.__FIREBASE_CONFIG__;
    if (!isPlaceholder(cfg)) return { ...cfg };
  }

  for (const path of ['./firebase-config.local.js', './firebase-config.runtime.js']) {
    try {
      const mod = await import(path);
      const cfg = mod.firebaseConfig || mod.default;
      if (!isPlaceholder(cfg)) return { ...cfg };
    } catch {
      // 未作成は想定内
    }
  }

  return null;
}
