/**
 * メモ PWA — IndexedDB（オフラインキャッシュ）+ Firebase 同期 UI
 * プロジェクト（フォルダ）でメモをグループ化
 */
import { createSync } from './sync.js';

const DB_NAME = 'memo-pwa-db';
const DB_VERSION = 2;
const STORE_NOTES = 'notes';
const STORE_PROJECTS = 'projects';

/** フィルタ: 'all' | 'inbox' | <projectId> */
/** @type {string} */
let selectedFilter = 'all';
/** 日付フィルタ (ローカル YYYY-MM-DD) — セッションのみ。null で解除 */
/** @type {string|null} */
let selectedDateKey = null;
/** カレンダー表示中の年月 */
/** @type {{ year: number, month: number }} */
let calendarView = (() => {
  const n = new Date();
  return { year: n.getFullYear(), month: n.getMonth() };
})();
/** @type {IDBDatabase|null} */
let db = null;
/** @type {string|null} */
let editingId = null;
/** @type {string|null} */
let pendingDeleteId = null;
/** @type {'note'|'project'|null} */
let pendingDeleteKind = null;
/** @type {string|null} */
let pendingRenameId = null;
/** @type {Awaited<ReturnType<typeof createSync>>|null} */
let syncApi = null;

const $ = (sel, root = document) => root.querySelector(sel);

const listScreen = $('#list-screen');
const editorScreen = $('#editor-screen');
const noteList = $('#note-list');
const titleInput = $('#note-title');
const contentInput = $('#note-content');
const projectSelect = $('#note-project');
const editorHeading = $('#editor-heading');
const deleteModal = $('#delete-modal');
const deleteModalTitle = $('#delete-modal-title');
const deleteModalDesc = $('#delete-modal-desc');
const projectsModal = $('#projects-modal');
const renameModal = $('#rename-modal');
const projectChips = $('#project-chips');
const projectManageList = $('#project-manage-list');
const projectNameInput = $('#project-name-input');
const renameProjectInput = $('#rename-project-input');
const toastEl = $('#toast');
const syncStatusEl = $('#sync-status');
const settingsModal = $('#settings-modal');
const settingsSyncStatusEl = $('#settings-sync-status');
const settingsAuthUserEl = $('#settings-auth-user');
const btnSettingsSignIn = $('#btn-settings-sign-in');
const btnSettingsSignOut = $('#btn-settings-sign-out');
const calendarModal = $('#calendar-modal');
const calendarGrid = $('#calendar-grid');
const calendarMonthLabel = $('#calendar-month-label');
const dateFilterBar = $('#date-filter-bar');
const dateFilterLabel = $('#date-filter-label');

// —— IndexedDB ——
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE_NOTES)) {
        const store = database.createObjectStore(STORE_NOTES, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_PROJECTS)) {
        const pStore = database.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        pStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      // v1 → v2: notes に projectId は任意フィールド（既存はそのまま）
      void event;
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function notesStore(mode = 'readonly') {
  return db.transaction(STORE_NOTES, mode).objectStore(STORE_NOTES);
}

function projectsStore(mode = 'readonly') {
  return db.transaction(STORE_PROJECTS, mode).objectStore(STORE_PROJECTS);
}

/** ソフトデリート含む全件（同期マージ用） */
function getAllNotesIncludingDeleted() {
  return new Promise((resolve, reject) => {
    const req = notesStore().getAll();
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
    const req = notesStore().get(id);
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
    const req = notesStore('readwrite').put(note);
    req.onsuccess = () => resolve(note);
    req.onerror = () => reject(req.error);
  });
}

/**
 * ソフトデリート（クラウド同期用）。deletedAt / updatedAt をセットして残す。
 */
async function softDeleteNote(id) {
  return new Promise((resolve, reject) => {
    const store = notesStore('readwrite');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const now = Date.now();
      const note = {
        id,
        title: existing ? existing.title || '' : '',
        content: existing ? existing.content || '' : '',
        projectId:
          existing && existing.projectId != null && existing.projectId !== ''
            ? existing.projectId
            : null,
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

function getAllProjectsIncludingDeleted() {
  return new Promise((resolve, reject) => {
    const req = projectsStore().getAll();
    req.onsuccess = () => {
      const projects = req.result || [];
      projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(projects);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 並び順キー（未設定は updatedAt、それも無ければ 0） */
function projectSortKey(p) {
  if (typeof p.sortOrder === 'number' && !Number.isNaN(p.sortOrder)) {
    return p.sortOrder;
  }
  return typeof p.updatedAt === 'number' ? p.updatedAt : 0;
}

function compareProjectsBySortOrder(a, b) {
  const ka = projectSortKey(a);
  const kb = projectSortKey(b);
  if (ka !== kb) return ka - kb;
  const nameCmp = (a.name || '').localeCompare(b.name || '', 'ja');
  if (nameCmp !== 0) return nameCmp;
  return String(a.id).localeCompare(String(b.id));
}

async function getActiveProjects() {
  const all = await getAllProjectsIncludingDeleted();
  return all.filter((p) => !p.deletedAt).sort(compareProjectsBySortOrder);
}

/**
 * sortOrder 未設定のプロジェクトへ連番を付与して安定化する。
 * @returns {Promise<object[]>} 更新したプロジェクト一覧
 */
async function ensureProjectSortOrders() {
  const active = await getActiveProjects();
  const needs = active.some((p) => typeof p.sortOrder !== 'number');
  if (!needs) return [];

  const now = Date.now();
  const updatedList = [];
  for (let i = 0; i < active.length; i++) {
    const p = active[i];
    if (typeof p.sortOrder === 'number' && p.sortOrder === i) continue;
    const updated = { ...p, sortOrder: i, updatedAt: now };
    await putProject(updated);
    updatedList.push(updated);
  }
  if (syncApi && syncApi.configured) {
    for (const project of updatedList) {
      try {
        await syncApi.pushProject(project);
      } catch (e) {
        console.error(e);
      }
    }
  }
  return updatedList;
}

async function nextProjectSortOrder() {
  const active = await getActiveProjects();
  let max = -1;
  for (const p of active) {
    const o = typeof p.sortOrder === 'number' ? p.sortOrder : -1;
    if (o > max) max = o;
  }
  return max + 1;
}

function getProject(id) {
  return new Promise((resolve, reject) => {
    const req = projectsStore().get(id);
    req.onsuccess = () => {
      const p = req.result || null;
      if (p && p.deletedAt) {
        resolve(null);
        return;
      }
      resolve(p);
    };
    req.onerror = () => reject(req.error);
  });
}

function putProject(project) {
  return new Promise((resolve, reject) => {
    const req = projectsStore('readwrite').put(project);
    req.onsuccess = () => resolve(project);
    req.onerror = () => reject(req.error);
  });
}

/**
 * プロジェクトをソフトデリートし、紐づくメモを未分類にする
 * @returns {Promise<{ project: object, notes: object[] }>}
 */
async function softDeleteProjectAndUnassignNotes(projectId) {
  const now = Date.now();
  const existing = await new Promise((resolve, reject) => {
    const req = projectsStore().get(projectId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  const project = {
    id: projectId,
    name: existing ? existing.name || '' : '',
    updatedAt: now,
    deletedAt: now
  };
  if (existing && typeof existing.sortOrder === 'number') {
    project.sortOrder = existing.sortOrder;
  }
  await putProject(project);

  const notes = await getAllNotesIncludingDeleted();
  const updatedNotes = [];
  for (const note of notes) {
    if (note.deletedAt) continue;
    if (note.projectId === projectId) {
      const updated = {
        ...note,
        projectId: null,
        updatedAt: now
      };
      await putNote(updated);
      updatedNotes.push(updated);
    }
  }
  return { project, notes: updatedNotes };
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function projectUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeProjectId(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function noteProjectId(note) {
  return normalizeProjectId(note && note.projectId);
}

function defaultProjectIdForNewNote() {
  if (selectedFilter === 'all' || selectedFilter === 'inbox') return null;
  return selectedFilter;
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

function toDateKey(tsOrDate) {
  const d = tsOrDate instanceof Date ? tsOrDate : new Date(tsOrDate);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateKey(key) {
  if (!key || typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(y, mo, day);
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
  return d;
}

function formatDateKeyJa(key) {
  const d = parseDateKey(key);
  if (!d) return '';
  const week = ['日', '月', '火', '水', '木', '金', '土'];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${week[d.getDay()]}）`;
}

function noteOnDateKey(note, key) {
  if (!key || !note || !note.updatedAt) return false;
  return toDateKey(note.updatedAt) === key;
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
  if (syncStatusEl) {
    syncStatusEl.textContent = text;
    syncStatusEl.dataset.status = text;
  }
  if (settingsSyncStatusEl) {
    settingsSyncStatusEl.textContent = text;
    settingsSyncStatusEl.dataset.status = text;
  }
}

function updateAuthUi(user) {
  const configured = Boolean(syncApi && syncApi.configured);
  if (btnSettingsSignIn) {
    btnSettingsSignIn.hidden = Boolean(user);
    btnSettingsSignIn.disabled = !configured;
    btnSettingsSignIn.title = configured ? '' : 'Firebase 設定が必要です';
  }
  if (btnSettingsSignOut) btnSettingsSignOut.hidden = !user;
  if (settingsAuthUserEl) {
    settingsAuthUserEl.hidden = !user;
    if (user) {
      const name = user.displayName || '';
      const email = user.email || '';
      settingsAuthUserEl.textContent = name && email ? `${name}（${email}）` : name || email || 'サインイン中';
      settingsAuthUserEl.title = email || name;
    } else {
      settingsAuthUserEl.textContent = '';
      settingsAuthUserEl.removeAttribute('title');
    }
  }
}

function openSettingsModal() {
  const modal = settingsModal || document.getElementById('settings-modal');
  if (!modal) {
    console.error('settings-modal not found');
    showToast('設定画面を開けませんでした');
    return;
  }
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  // クラス漏れでも必ず見せる
  modal.style.display = 'flex';
  requestAnimationFrame(() => {
    const firstAction = modal.querySelector(
      'button:not([hidden]):not([disabled]), [href], input:not([disabled])'
    );
    if (firstAction) firstAction.focus();
  });
}

function closeSettingsModal() {
  const modal = settingsModal || document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  modal.style.display = '';
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
  // 新規→タイトル、既存→本文にフォーカス（IME もそこに開く）
  requestAnimationFrame(() => {
    const el = isNew ? titleInput : contentInput;
    if (el) el.focus();
  });
}

function filterNotes(notes) {
  let result = notes;
  if (selectedFilter === 'inbox') {
    result = result.filter((n) => noteProjectId(n) == null);
  } else if (selectedFilter !== 'all') {
    result = result.filter((n) => noteProjectId(n) === selectedFilter);
  }
  if (selectedDateKey) {
    result = result.filter((n) => noteOnDateKey(n, selectedDateKey));
  }
  return result;
}


async function renderProjectChips() {
  const projects = await getActiveProjects();
  // 選択中のプロジェクトが消えていたらすべてに戻す
  if (
    selectedFilter !== 'all' &&
    selectedFilter !== 'inbox' &&
    !projects.some((p) => p.id === selectedFilter)
  ) {
    selectedFilter = 'all';
  }

  const chips = [
    { id: 'all', label: 'すべて' },
    ...projects.map((p) => ({ id: p.id, label: p.name || '無題' })),
    { id: 'inbox', label: '未分類' }
  ];

  projectChips.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'project-chip' + (selectedFilter === chip.id ? ' is-active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', selectedFilter === chip.id ? 'true' : 'false');
    btn.dataset.filter = chip.id;
    btn.textContent = chip.label;
    frag.appendChild(btn);
  }
  projectChips.appendChild(frag);
}

async function fillProjectSelect(selectedId) {
  const projects = await getActiveProjects();
  const current = normalizeProjectId(selectedId);
  projectSelect.innerHTML = '';
  const inboxOpt = document.createElement('option');
  inboxOpt.value = '';
  inboxOpt.textContent = '未分類';
  projectSelect.appendChild(inboxOpt);
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || '無題';
    projectSelect.appendChild(opt);
  }
  projectSelect.value = current || '';
}

function updateDateFilterBar() {
  if (!dateFilterBar || !dateFilterLabel) return;
  if (!selectedDateKey) {
    dateFilterBar.hidden = true;
    dateFilterLabel.textContent = '';
    return;
  }
  dateFilterBar.hidden = false;
  dateFilterLabel.textContent = `${formatDateKeyJa(selectedDateKey)}のメモ`;
}

function openCalendarModal() {
  const modal = calendarModal || document.getElementById('calendar-modal');
  if (!modal) {
    showToast('カレンダーを開けませんでした');
    return;
  }
  if (selectedDateKey) {
    const d = parseDateKey(selectedDateKey);
    if (d) {
      calendarView = { year: d.getFullYear(), month: d.getMonth() };
    }
  } else {
    const n = new Date();
    calendarView = { year: n.getFullYear(), month: n.getMonth() };
  }
  renderCalendar().catch(console.error);
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  modal.style.display = 'flex';
  requestAnimationFrame(() => {
    const focusEl = modal.querySelector('#btn-cal-today, #btn-close-calendar');
    if (focusEl) focusEl.focus();
  });
}

function closeCalendarModal() {
  const modal = calendarModal || document.getElementById('calendar-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  modal.style.display = '';
}

async function renderCalendar() {
  if (!calendarGrid || !calendarMonthLabel) return;
  const { year, month } = calendarView;
  calendarMonthLabel.textContent = `${year}年${month + 1}月`;

  const allNotes = await getAllNotes();
  const noteDays = new Set();
  for (const note of allNotes) {
    if (note && note.updatedAt) noteDays.add(toDateKey(note.updatedAt));
  }

  const todayKey = toDateKey(new Date());
  const first = new Date(year, month, 1);
  const startDow = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Leading blanks from previous month (shown muted, non-interactive)
  const cells = [];
  for (let i = 0; i < startDow; i++) {
    cells.push({ outside: true, label: '' });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = toDateKey(new Date(year, month, day));
    const dow = (startDow + day - 1) % 7;
    cells.push({
      outside: false,
      day,
      key,
      dow,
      isToday: key === todayKey,
      isSelected: key === selectedDateKey,
      hasNotes: noteDays.has(key)
    });
  }
  // Pad to full weeks
  while (cells.length % 7 !== 0) {
    cells.push({ outside: true, label: '' });
  }

  calendarGrid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const cell of cells) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    if (cell.outside) {
      btn.classList.add('is-outside');
      btn.disabled = true;
      btn.setAttribute('aria-hidden', 'true');
      btn.textContent = '';
    } else {
      btn.textContent = String(cell.day);
      btn.dataset.date = cell.key;
      btn.setAttribute('aria-label', formatDateKeyJa(cell.key));
      if (cell.dow === 0) btn.classList.add('is-sun');
      if (cell.dow === 6) btn.classList.add('is-sat');
      if (cell.isToday) btn.classList.add('is-today');
      if (cell.isSelected) {
        btn.classList.add('is-selected');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.setAttribute('aria-pressed', 'false');
      }
      if (cell.hasNotes) btn.classList.add('has-notes');
    }
    frag.appendChild(btn);
  }
  calendarGrid.appendChild(frag);
}

function selectDateKey(key) {
  selectedDateKey = key || null;
  updateDateFilterBar();
  closeCalendarModal();
  return renderList();
}

function clearDateFilter() {
  selectedDateKey = null;
  updateDateFilterBar();
  return renderList();
}

function shiftCalendarMonth(delta) {
  let { year, month } = calendarView;
  month += delta;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  calendarView = { year, month };
  return renderCalendar();
}

async function renderList() {
  updateDateFilterBar();
  const [allNotes, projects] = await Promise.all([getAllNotes(), getActiveProjects()]);
  await renderProjectChips();

  const notes = filterNotes(allNotes);
  noteList.innerHTML = '';
  if (!notes.length) {
    return;
  }
  const projectNameById = new Map(projects.map((p) => [p.id, p.name || '無題']));
  const frag = document.createDocumentFragment();
  for (const note of notes) {
    const pid = noteProjectId(note);
    const badge =
      selectedFilter === 'all' && pid
        ? `<span class="note-project-badge">${escapeHtml(projectNameById.get(pid) || 'プロジェクト')}</span>`
        : '';
    const li = document.createElement('li');
    li.className = 'note-item';
    li.innerHTML = `
      <button type="button" class="note-item-btn" data-id="${escapeHtml(note.id)}" aria-label="${escapeHtml(displayTitle(note))} を開く">
        <div class="note-item-top">
          <p class="note-title">${escapeHtml(displayTitle(note))}</p>
          ${badge}
        </div>
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
  await fillProjectSelect(defaultProjectIdForNewNote());
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
  await fillProjectSelect(noteProjectId(note));
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
    projectId: normalizeProjectId(projectSelect.value),
    updatedAt: now
  };
  // 復活時に deletedAt が残らないよう明示的に外す（put で上書き）
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

function openDeleteModal(id, kind = 'note') {
  pendingDeleteId = id;
  pendingDeleteKind = kind;
  if (kind === 'project') {
    deleteModalTitle.textContent = 'プロジェクトを削除しますか？';
    deleteModalDesc.textContent =
      'メモは削除されず「未分類」に移ります。この操作は取り消せません。';
  } else {
    deleteModalTitle.textContent = 'メモを削除しますか？';
    deleteModalDesc.textContent = 'この操作は取り消せません。';
  }
  deleteModal.classList.add('is-open');
  deleteModal.setAttribute('aria-hidden', 'false');
  $('#btn-confirm-delete').focus();
}

function closeDeleteModal() {
  pendingDeleteId = null;
  pendingDeleteKind = null;
  deleteModal.classList.remove('is-open');
  deleteModal.setAttribute('aria-hidden', 'true');
}

async function confirmDelete() {
  const id = pendingDeleteId;
  const kind = pendingDeleteKind;
  if (!id || !kind) return;

  if (kind === 'project') {
    const { project, notes } = await softDeleteProjectAndUnassignNotes(id);
    if (syncApi && syncApi.configured) {
      try {
        await syncApi.pushProject(project);
        for (const note of notes) {
          await syncApi.pushNote(note);
        }
      } catch (e) {
        console.error(e);
      }
    }
    if (selectedFilter === id) selectedFilter = 'all';
    closeDeleteModal();
    showToast('プロジェクトを削除しました');
    await renderProjectsManageList();
    await renderList();
    return;
  }

  const note = await softDeleteNote(id);
  if (syncApi && syncApi.configured) {
    try {
      await syncApi.pushNote(note);
    } catch (e) {
      console.error(e);
    }
  }
  closeDeleteModal();
  showToast('削除しました');
  if (editingId === id) {
    showList();
  }
  await renderList();
}

function openProjectsModal() {
  projectsModal.classList.add('is-open');
  projectsModal.setAttribute('aria-hidden', 'false');
  renderProjectsManageList().catch(console.error);
  projectNameInput.value = '';
  requestAnimationFrame(() => projectNameInput.focus());
}

function closeProjectsModal() {
  projectsModal.classList.remove('is-open');
  projectsModal.setAttribute('aria-hidden', 'true');
}

async function renderProjectsManageList() {
  await ensureProjectSortOrders();
  const projects = await getActiveProjects();
  projectManageList.innerHTML = '';
  if (!projects.length) {
    const li = document.createElement('li');
    li.className = 'project-manage-empty';
    li.textContent = 'プロジェクトはまだありません。上の欄から追加できます。';
    projectManageList.appendChild(li);
    return;
  }
  const frag = document.createDocumentFragment();
  projects.forEach((p, idx) => {
    const li = document.createElement('li');
    li.className = 'project-manage-item';
    const idAttr = escapeHtml(p.id);
    const upDisabled = idx === 0 ? ' disabled' : '';
    const downDisabled = idx === projects.length - 1 ? ' disabled' : '';
    li.innerHTML = `
      <div class="project-manage-reorder">
        <button type="button" class="btn btn-ghost btn-reorder" data-move-up="${idAttr}" aria-label="上へ移動"${upDisabled}>↑</button>
        <button type="button" class="btn btn-ghost btn-reorder" data-move-down="${idAttr}" aria-label="下へ移動"${downDisabled}>↓</button>
      </div>
      <span class="project-manage-name">${escapeHtml(p.name || '無題')}</span>
      <div class="project-manage-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-rename="${idAttr}">名前変更</button>
        <button type="button" class="btn btn-danger btn-sm" data-delete-project="${idAttr}">削除</button>
      </div>`;
    frag.appendChild(li);
  });
  projectManageList.appendChild(frag);
}

async function addProject(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    showToast('プロジェクト名を入力してください');
    return;
  }
  const project = {
    id: projectUid(),
    name: trimmed,
    sortOrder: await nextProjectSortOrder(),
    updatedAt: Date.now()
  };
  await putProject(project);
  if (syncApi && syncApi.configured) {
    try {
      await syncApi.pushProject(project);
    } catch (e) {
      console.error(e);
      showToast('追加しました（クラウド同期に失敗）');
    }
  } else {
    showToast('プロジェクトを追加しました');
  }
  projectNameInput.value = '';
  await renderProjectsManageList();
  await renderList();
}


async function reorderProject(id, direction) {
  await ensureProjectSortOrders();
  const list = await getActiveProjects();
  const idx = list.findIndex((p) => p.id === id);
  const j = idx + direction;
  if (idx < 0 || j < 0 || j >= list.length) return;

  const now = Date.now();
  const a = list[idx];
  const b = list[j];
  let orderA = typeof a.sortOrder === 'number' ? a.sortOrder : idx;
  let orderB = typeof b.sortOrder === 'number' ? b.sortOrder : j;
  if (orderA === orderB) {
    orderA = idx;
    orderB = j;
  }
  const updatedA = { ...a, sortOrder: orderB, updatedAt: now };
  const updatedB = { ...b, sortOrder: orderA, updatedAt: now };
  await putProject(updatedA);
  await putProject(updatedB);
  if (syncApi && syncApi.configured) {
    try {
      await syncApi.pushProject(updatedA);
      await syncApi.pushProject(updatedB);
    } catch (e) {
      console.error(e);
      showToast('順序を変更しました（クラウド同期に失敗）');
    }
  }
  await renderProjectsManageList();
  await renderList();
}

function openRenameModal(id, currentName) {
  pendingRenameId = id;
  renameProjectInput.value = currentName || '';
  renameModal.classList.add('is-open');
  renameModal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    renameProjectInput.focus();
    renameProjectInput.select();
  });
}

function closeRenameModal() {
  pendingRenameId = null;
  renameModal.classList.remove('is-open');
  renameModal.setAttribute('aria-hidden', 'true');
}

async function confirmRename() {
  const id = pendingRenameId;
  if (!id) return;
  const name = renameProjectInput.value.trim();
  if (!name) {
    showToast('プロジェクト名を入力してください');
    return;
  }
  const existing = await getProject(id);
  const project = {
    id,
    name,
    updatedAt: Date.now()
  };
  if (existing && typeof existing.sortOrder === 'number') {
    project.sortOrder = existing.sortOrder;
  }
  await putProject(project);
  if (syncApi && syncApi.configured) {
    try {
      await syncApi.pushProject(project);
    } catch (e) {
      console.error(e);
    }
  }
  closeRenameModal();
  showToast('名前を変更しました');
  await renderProjectsManageList();
  await renderList();
  await fillProjectSelect(projectSelect.value);
}

// —— Events ——
function bindEvents() {
  // 設定は委譲でも拾う（キャッシュずれ・再描画でも確実）
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('#btn-calendar')) {
      e.preventDefault();
      openCalendarModal();
      return;
    }
    if (t.closest('#btn-close-calendar')) {
      e.preventDefault();
      closeCalendarModal();
      return;
    }
    if (t.closest('#btn-cal-prev')) {
      e.preventDefault();
      shiftCalendarMonth(-1).catch(console.error);
      return;
    }
    if (t.closest('#btn-cal-next')) {
      e.preventDefault();
      shiftCalendarMonth(1).catch(console.error);
      return;
    }
    if (t.closest('#btn-cal-today')) {
      e.preventDefault();
      const today = new Date();
      calendarView = { year: today.getFullYear(), month: today.getMonth() };
      selectDateKey(toDateKey(today)).catch(console.error);
      return;
    }
    const dayBtn = t.closest('#calendar-grid .cal-day[data-date]');
    if (dayBtn) {
      e.preventDefault();
      const key = dayBtn.getAttribute('data-date');
      selectDateKey(key).catch(console.error);
      return;
    }
    if (t.closest('#btn-clear-date-filter')) {
      e.preventDefault();
      clearDateFilter().catch(console.error);
      return;
    }
    if (t.closest('#btn-settings')) {
      e.preventDefault();
      openSettingsModal();
      return;
    }
    if (t.closest('#btn-close-settings')) {
      e.preventDefault();
      closeSettingsModal();
      return;
    }
    const calModal = calendarModal || document.getElementById('calendar-modal');
    if (calModal && t === calModal) {
      closeCalendarModal();
      return;
    }
    const modal = settingsModal || document.getElementById('settings-modal');
    if (modal && t === modal) closeSettingsModal();
  });

  $('#btn-new').addEventListener('click', () => {
    openCreate().catch((e) => {
      console.error(e);
      showToast('開けませんでした');
    });
  });
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
    if (editingId) openDeleteModal(editingId, 'note');
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

  projectChips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    selectedFilter = chip.getAttribute('data-filter') || 'all';
    renderList().catch(console.error);
  });

  $('#btn-projects-manage').addEventListener('click', openProjectsModal);
  $('#btn-close-projects').addEventListener('click', closeProjectsModal);
  projectsModal.addEventListener('click', (e) => {
    if (e.target === projectsModal) closeProjectsModal();
  });

  $('#project-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addProject(projectNameInput.value).catch((err) => {
      console.error(err);
      showToast('追加に失敗しました');
    });
  });

  projectManageList.addEventListener('click', (e) => {
    const upBtn = e.target.closest('[data-move-up]');
    if (upBtn && !upBtn.disabled) {
      reorderProject(upBtn.getAttribute('data-move-up'), -1).catch((err) => {
        console.error(err);
        showToast('並び替えに失敗しました');
      });
      return;
    }
    const downBtn = e.target.closest('[data-move-down]');
    if (downBtn && !downBtn.disabled) {
      reorderProject(downBtn.getAttribute('data-move-down'), 1).catch((err) => {
        console.error(err);
        showToast('並び替えに失敗しました');
      });
      return;
    }
    const renameBtn = e.target.closest('[data-rename]');
    if (renameBtn) {
      const id = renameBtn.getAttribute('data-rename');
      const nameEl = renameBtn.closest('.project-manage-item')?.querySelector(
        '.project-manage-name'
      );
      openRenameModal(id, nameEl ? nameEl.textContent : '');
      return;
    }
    const delBtn = e.target.closest('[data-delete-project]');
    if (delBtn) {
      openDeleteModal(delBtn.getAttribute('data-delete-project'), 'project');
    }
  });

  $('#btn-cancel-rename').addEventListener('click', closeRenameModal);
  $('#btn-confirm-rename').addEventListener('click', () => {
    confirmRename().catch((e) => {
      console.error(e);
      showToast('変更に失敗しました');
    });
  });
  renameModal.addEventListener('click', (e) => {
    if (e.target === renameModal) closeRenameModal();
  });
  renameProjectInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmRename().catch(console.error);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (renameModal.classList.contains('is-open')) {
      closeRenameModal();
      return;
    }
    if (deleteModal.classList.contains('is-open')) {
      closeDeleteModal();
      return;
    }
    if (calendarModal && calendarModal.classList.contains('is-open')) {
      closeCalendarModal();
      return;
    }
    if (settingsModal.classList.contains('is-open')) {
      closeSettingsModal();
      return;
    }
    if (projectsModal.classList.contains('is-open')) {
      closeProjectsModal();
    }
  });

  if (btnSettingsSignIn) {
    btnSettingsSignIn.addEventListener('click', () => {
      if (!syncApi || !syncApi.configured) {
        showToast('Firebase 設定が必要です（README 参照）');
        return;
      }
      if (btnSettingsSignIn.disabled) return;
      btnSettingsSignIn.disabled = true;
      showToast('Googleへ移動します…');
      syncApi
        .signIn()
        .catch((err) => {
          console.error(err);
          const code = err && err.code;
          if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
            showToast('サインインがキャンセルされました');
            return;
          }
          showToast('サインインに失敗しました');
        })
        .finally(() => {
          // redirect の場合はページ遷移するのでここはほぼ到達しない
          btnSettingsSignIn.disabled = false;
        });
    });
  }
  if (btnSettingsSignOut) {
    btnSettingsSignOut.addEventListener('click', () => {
      if (!syncApi) return;
      btnSettingsSignOut.disabled = true;
      syncApi
        .signOutUser()
        .then(() => {
          showToast('サインアウトしました');
        })
        .catch((err) => {
          console.error(err);
          showToast('サインアウトに失敗しました');
        })
        .finally(() => {
          btnSettingsSignOut.disabled = false;
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

async function refreshUiFromRemote() {
  await ensureProjectSortOrders();
  await renderList();
  if (projectsModal.classList.contains('is-open')) {
    await renderProjectsManageList();
  }
  if (!editorScreen.classList.contains('is-active')) return;
  await fillProjectSelect(projectSelect.value);
}

async function init() {
  bindEvents();
  setSyncStatus('ローカルのみ');
  updateAuthUi(null);

  try {
    await openDb();
    await ensureProjectSortOrders();
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
      getAllProjectsIncludingDeleted,
      putProject,
      onRemoteChange: () => {
        refreshUiFromRemote().catch((e) => console.error(e));
      },
      onAuthChange: (user) => {
        updateAuthUi(user);
        const nextUid = user ? user.uid : null;
        if (authReady && nextUid && nextUid !== lastUid) {
          showToast('サインインしました');
        }
        lastUid = nextUid;
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
