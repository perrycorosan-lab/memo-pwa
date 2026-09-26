/**
 * メモ PWA — IndexedDB（オフラインキャッシュ）+ Firebase 同期 UI
 */
import { createSync } from './sync.js';

const DB_NAME = 'memo-pwa-db';
const DB_VERSION = 1;
const STORE = 'notes';

/** @type {IDBDatabase|null} */
let db = null;
/** @type {string|null} */
let editingId = null;
/** @type {string|null} */
let pendingDeleteId = null;
/** @type {Awaited<ReturnType<typeof createSync>>|null} */
let syncApi = null;

const $ = (sel, root = document) => root.querySelector(sel);

const listScreen = $('#list-screen');
const editorScreen = $('#editor-screen');
const noteList = $('#note-list');
const emptyState = $('#empty-state');
const titleInput = $('#note-title');
const contentInput = $('#note-content');
const editorHeading = $('#editor-heading');
const deleteModal = $('#delete-modal');
const toastEl = $('#toast');
const syncStatusEl = $('#sync-status');
const authBar = $('#auth-bar');
const btnSignIn = $('#btn-sign-in');
const btnSignOut = $('#btn-sign-out');
const authUserEl = $('#auth-user');

// —— IndexedDB ——
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(mode = 'readonly') {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** ソフトデリート含む全件（同期マージ用） */
function getAllNotesIncludingDeleted() {
  return new Promise((resolve, reject) => {
    const req = tx().getAll();
    req.onsuccess = () => {
      const notes = req.result || [];
      notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(notes);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 一覧表示用（削除済みを除外） */
async function getAllNotes() {
  const notes = await getAllNotesIncludingDeleted();
  return notes.filter((n) => !n.deletedAt);
}

function getNote(id) {
  return new Promise((resolve, reject) => {
    const req = tx().get(id);
    req.onsuccess = () => {
      const note = req.result || null;
      if (note && note.deletedAt) {
        resolve(null);
        return;
      }
      resolve(note);
    };
    req.onerror = () => reject(req.error);
  });
}

function putNote(note) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').put(note);
    req.onsuccess = () => resolve(note);
    req.onerror = () => reject(req.error);
  });
}

/**
 * ソフトデリート（クラウド同期用）。deletedAt / updatedAt をセットして残す。
 */
async function softDeleteNote(id) {
  return new Promise((resolve, reject) => {
    const store = tx('readwrite');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const now = Date.now();
      const note = {
        id,
        title: existing ? existing.title || '' : '',
        content: existing ? existing.content || '' : '',
        updatedAt: now,
        deletedAt: now
      };
      const putReq = store.put(note);
      putReq.onsuccess = () => resolve(note);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// —— Formatting ——
function formatUpdatedAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `今日 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYday) return `昨日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function previewText(content) {
  const t = (content || '').replace(/\s+/g, ' ').trim();
  return t || '（本文なし）';
}

function displayTitle(note) {
  const t = (note.title || '').trim();
  if (t) return t;
  const first = (note.content || '').split(/\n/)[0].trim();
  return first || '無題のメモ';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// —— UI ——
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('is-visible'), 2200);
}

function setSyncStatus(text) {
  if (!syncStatusEl) return;
  syncStatusEl.textContent = text;
  syncStatusEl.dataset.status = text;
}

function updateAuthUi(user) {
  if (!authBar) return;
  if (!syncApi || !syncApi.configured) {
    authBar.hidden = false;
    if (btnSignIn) {
      btnSignIn.hidden = false;
      btnSignIn.disabled = true;
      btnSignIn.title = 'Firebase 設定が必要です';
    }
    if (btnSignOut) btnSignOut.hidden = true;
    if (authUserEl) {
      authUserEl.hidden = true;
      authUserEl.textContent = '';
    }
    return;
  }

  authBar.hidden = false;
  if (user) {
    if (btnSignIn) btnSignIn.hidden = true;
    if (btnSignOut) btnSignOut.hidden = false;
    if (authUserEl) {
      authUserEl.hidden = false;
      const label = user.displayName || user.email || 'サインイン中';
      authUserEl.textContent = label;
      authUserEl.title = user.email || label;
    }
  } else {
    if (btnSignIn) {
      btnSignIn.hidden = false;
      btnSignIn.disabled = false;
      btnSignIn.title = '';
    }
    if (btnSignOut) btnSignOut.hidden = true;
    if (authUserEl) {
      authUserEl.hidden = true;
      authUserEl.textContent = '';
    }
  }
}

function showList() {
  editingId = null;
  editorScreen.classList.remove('is-active');
  listScreen.classList.add('is-active');
  listScreen.setAttribute('aria-hidden', 'false');
  editorScreen.setAttribute('aria-hidden', 'true');
}

function showEditor(isNew) {
  listScreen.classList.remove('is-active');
  editorScreen.classList.add('is-active');
  listScreen.setAttribute('aria-hidden', 'true');
  editorScreen.setAttribute('aria-hidden', 'false');
  editorHeading.textContent = isNew ? '新しいメモ' : 'メモを編集';
  requestAnimationFrame(() => titleInput.focus());
}

async function renderList() {
  const notes = await getAllNotes();
  noteList.innerHTML = '';
  if (!notes.length) {
    emptyState.hidden = false;
    noteList.hidden = true;
    return;
  }
  emptyState.hidden = true;
  noteList.hidden = false;
  const frag = document.createDocumentFragment();
  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'note-item';
    li.innerHTML = `
      <button type="button" class="note-item-btn" data-id="${escapeHtml(note.id)}" aria-label="${escapeHtml(displayTitle(note))} を開く">
        <p class="note-title">${escapeHtml(displayTitle(note))}</p>
        <p class="note-preview">${escapeHtml(previewText(note.content))}</p>
        <time class="note-meta" datetime="${new Date(note.updatedAt).toISOString()}">${escapeHtml(formatUpdatedAt(note.updatedAt))}</time>
      </button>`;
    frag.appendChild(li);
  }
  noteList.appendChild(frag);
}

async function openCreate() {
  editingId = null;
  titleInput.value = '';
  contentInput.value = '';
  $('#btn-delete-in-editor').hidden = true;
  showEditor(true);
}

async function openEdit(id) {
  const note = await getNote(id);
  if (!note) {
    showToast('メモが見つかりません');
    await renderList();
    return;
  }
  editingId = id;
  titleInput.value = note.title || '';
  contentInput.value = note.content || '';
  $('#btn-delete-in-editor').hidden = false;
  showEditor(false);
}

async function saveNote() {
  const title = titleInput.value.trim();
  const content = contentInput.value;
  if (!title && !content.trim()) {
    showToast('タイトルか本文を入力してください');
    return;
  }
  const now = Date.now();
  const note = {
    id: editingId || uid(),
    title,
    content,
    updatedAt: now
  };
  // 復活時に deletedAt が残らないよう明示的に外す
  await putNote(note);
  if (syncApi && syncApi.configured) {
    try {
      await syncApi.pushNote(note);
    } catch {
      showToast('保存しました（クラウド同期に失敗）');
      showList();
      await renderList();
      return;
    }
  }
  showToast(editingId ? '保存しました' : '作成しました');
  showList();
  await renderList();
}

function openDeleteModal(id) {
  pendingDeleteId = id;
  deleteModal.classList.add('is-open');
  deleteModal.setAttribute('aria-hidden', 'false');
  $('#btn-confirm-delete').focus();
}

function closeDeleteModal() {
  pendingDeleteId = null;
  deleteModal.classList.remove('is-open');
  deleteModal.setAttribute('aria-hidden', 'true');
}

async function confirmDelete() {
  const id = pendingDeleteId;
  if (!id) return;
  const note = await softDeleteNote(id);
  if (syncApi && syncApi.configured) {
    try {
      await syncApi.pushNote(note);
    } catch (e) {
      console.error(e);
      // ローカル削除は完了済み
    }
  }
  closeDeleteModal();
  showToast('削除しました');
  if (editingId === id) {
    showList();
  }
  await renderList();
}

// —— Events ——
function bindEvents() {
  $('#btn-new').addEventListener('click', openCreate);
  $('#btn-empty-new').addEventListener('click', openCreate);
  $('#btn-back').addEventListener('click', async () => {
    showList();
    await renderList();
  });
  $('#btn-save').addEventListener('click', () => {
    saveNote().catch((e) => {
      console.error(e);
      showToast('保存に失敗しました');
    });
  });
  $('#btn-delete-in-editor').addEventListener('click', () => {
    if (editingId) openDeleteModal(editingId);
  });
  noteList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-id]');
    if (btn) openEdit(btn.getAttribute('data-id'));
  });
  $('#btn-cancel-delete').addEventListener('click', closeDeleteModal);
  $('#btn-confirm-delete').addEventListener('click', () => {
    confirmDelete().catch((e) => {
      console.error(e);
      showToast('削除に失敗しました');
    });
  });
  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) closeDeleteModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && deleteModal.classList.contains('is-open')) {
      closeDeleteModal();
    }
  });

  if (btnSignIn) {
    btnSignIn.addEventListener('click', () => {
      if (!syncApi || !syncApi.configured) {
        showToast('Firebase 設定が必要です（README 参照）');
        return;
      }
      syncApi.signIn().catch((err) => {
        console.error(err);
        const code = err && err.code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
          showToast('サインインがキャンセルされました');
          return;
        }
        showToast('サインインに失敗しました');
      });
    });
  }
  if (btnSignOut) {
    btnSignOut.addEventListener('click', () => {
      if (!syncApi) return;
      syncApi.signOutUser().then(() => {
        showToast('サインアウトしました');
      }).catch((err) => {
        console.error(err);
        showToast('サインアウトに失敗しました');
      });
    });
  }
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
}

async function init() {
  bindEvents();
  setSyncStatus('ローカルのみ');
  updateAuthUi(null);

  try {
    await openDb();
    await renderList();
    showList();
  } catch (err) {
    console.error(err);
    showToast('データの読み込みに失敗しました');
  }

  let authReady = false;
  let lastUid = null;
  try {
    syncApi = await createSync({
      getAllNotesIncludingDeleted,
      putNote,
      onRemoteChange: () => {
        renderList().catch((e) => console.error(e));
      },
      onAuthChange: (user) => {
        updateAuthUi(user);
        const uid = user ? user.uid : null;
        if (authReady && uid && uid !== lastUid) {
          showToast('サインインしました');
        }
        lastUid = uid;
        authReady = true;
      },
      onSyncStatus: setSyncStatus
    });
    updateAuthUi(syncApi.getUser());
    if (!syncApi.configured) {
      setSyncStatus('未設定');
    }
    await syncApi.start();
  } catch (err) {
    console.error('sync init failed', err);
    setSyncStatus('ローカルのみ');
  }

  registerSW();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
