/**
 * Firebase Auth + Firestore 同期
 * IndexedDB をオフラインキャッシュとして維持し、サインイン時にクラウドとマージする
 * Firebase SDK は設定があるときだけ動的 import（未設定・オフラインでもアプリは動く）
 */
import { loadFirebaseConfig } from './firebase-config.js';

/** @typedef {{ id: string, title: string, content: string, updatedAt: number, deletedAt?: number|null }} Note */

const FIREBASE_VERSION = '10.14.1';
const gstatic = (pkg) =>
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/${pkg}.js`;

/**
 * @param {{
 *   getAllNotesIncludingDeleted: () => Promise<Note[]>,
 *   putNote: (note: Note) => Promise<Note>,
 *   onRemoteChange: () => void,
 *   onAuthChange: (user: object|null) => void,
 *   onSyncStatus: (status: string) => void,
 * }} deps
 */
export async function createSync(deps) {
  const {
    getAllNotesIncludingDeleted,
    putNote,
    onRemoteChange,
    onAuthChange,
    onSyncStatus
  } = deps;

  const config = await loadFirebaseConfig();
  if (!config) {
    onSyncStatus('未設定');
    return {
      configured: false,
      getUser: () => null,
      signIn: async () => {
        throw new Error('Firebase が未設定です。firebase-config.local.js を作成してください。');
      },
      signOutUser: async () => {},
      pushNote: async () => {},
      start: async () => {}
    };
  }

  let initializeApp, authMod, fsMod;
  try {
    [{ initializeApp }, authMod, fsMod] = await Promise.all([
      import(gstatic('firebase-app')),
      import(gstatic('firebase-auth')),
      import(gstatic('firebase-firestore'))
    ]);
  } catch (err) {
    console.warn('Firebase SDK の読み込みに失敗しました（オフライン等）。ローカルのみで動作します。', err);
    onSyncStatus('ローカルのみ');
    return {
      configured: true,
      getUser: () => null,
      signIn: async () => {
        throw new Error('Firebase SDK を読み込めませんでした。ネットワークを確認して再読み込みしてください。');
      },
      signOutUser: async () => {},
      pushNote: async () => {},
      start: async () => {}
    };
  }

  const {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signOut,
    onAuthStateChanged
  } = authMod;

  const {
    getFirestore,
    collection,
    doc,
    setDoc,
    onSnapshot,
    writeBatch
  } = fsMod;

  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  /** @type {object|null} */
  let currentUser = null;
  /** @type {(() => void)|null} */
  let unsubscribeSnapshot = null;
  let applyingRemote = false;
  let initialMergeDone = false;

  function notesCol(uid) {
    return collection(db, 'users', uid, 'notes');
  }

  function noteRef(uid, noteId) {
    return doc(db, 'users', uid, 'notes', noteId);
  }

  function setStatus(s) {
    onSyncStatus(s);
  }

  /**
   * @param {Note|null|undefined} a
   * @param {Note|null|undefined} b
   * @returns {Note|null}
   */
  function preferNewer(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const at = a.updatedAt || 0;
    const bt = b.updatedAt || 0;
    if (bt > at) return b;
    if (at > bt) return a;
    if (b.deletedAt && !a.deletedAt) return b;
    return a;
  }

  function normalizeRemote(id, data) {
    if (!data || typeof data !== 'object') return null;
    /** @type {Note} */
    const note = {
      id: String(data.id || id),
      title: typeof data.title === 'string' ? data.title : '',
      content: typeof data.content === 'string' ? data.content : '',
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0
    };
    if (data.deletedAt != null && data.deletedAt !== undefined) {
      note.deletedAt = typeof data.deletedAt === 'number' ? data.deletedAt : null;
    }
    return note;
  }

  function toFirestorePayload(note) {
    /** @type {Record<string, unknown>} */
    const payload = {
      id: note.id,
      title: note.title || '',
      content: note.content || '',
      updatedAt: note.updatedAt || Date.now()
    };
    if (note.deletedAt != null) {
      payload.deletedAt = note.deletedAt;
    }
    return payload;
  }

  /**
   * @param {Note[]} remoteNotes
   */
  async function mergeLocalAndRemote(remoteNotes) {
    const localNotes = await getAllNotesIncludingDeleted();
    const localMap = new Map(localNotes.map((n) => [n.id, n]));
    const remoteMap = new Map(remoteNotes.map((n) => [n.id, n]));
    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);

    const toUpload = [];
    applyingRemote = true;
    try {
      for (const id of allIds) {
        const merged = preferNewer(localMap.get(id), remoteMap.get(id));
        if (!merged) continue;

        const local = localMap.get(id);
        const remote = remoteMap.get(id);

        if (!local || (remote && (remote.updatedAt || 0) > (local.updatedAt || 0))) {
          await putNote(merged);
        } else if (
          local &&
          remote &&
          (remote.updatedAt || 0) === (local.updatedAt || 0) &&
          remote.deletedAt &&
          !local.deletedAt
        ) {
          await putNote(merged);
        }

        if (!remote || (local && (local.updatedAt || 0) > (remote.updatedAt || 0))) {
          toUpload.push(merged);
        } else if (
          local &&
          remote &&
          (local.updatedAt || 0) === (remote.updatedAt || 0) &&
          local.deletedAt &&
          !remote.deletedAt
        ) {
          toUpload.push(merged);
        }
      }
    } finally {
      applyingRemote = false;
    }

    if (currentUser && toUpload.length) {
      await uploadNotes(currentUser.uid, toUpload);
    }

    onRemoteChange();
  }

  /**
   * @param {string} uid
   * @param {Note[]} notes
   */
  async function uploadNotes(uid, notes) {
    if (!notes.length) return;
    const CHUNK = 400;
    for (let i = 0; i < notes.length; i += CHUNK) {
      const chunk = notes.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      for (const note of chunk) {
        batch.set(noteRef(uid, note.id), toFirestorePayload(note));
      }
      await batch.commit();
    }
  }

  /**
   * @param {Note} note
   */
  async function pushNote(note) {
    if (!currentUser || applyingRemote) return;
    try {
      setStatus('同期中…');
      await setDoc(noteRef(currentUser.uid, note.id), toFirestorePayload(note));
      setStatus('同期済み');
    } catch (err) {
      console.error('pushNote failed', err);
      setStatus('同期エラー');
      throw err;
    }
  }

  function stopListener() {
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
    initialMergeDone = false;
  }

  /**
   * @param {object} user
   */
  function startListener(user) {
    stopListener();
    setStatus('同期中…');
    unsubscribeSnapshot = onSnapshot(
      notesCol(user.uid),
      async (snap) => {
        try {
          const remoteNotes = [];
          snap.forEach((d) => {
            const n = normalizeRemote(d.id, d.data());
            if (n) remoteNotes.push(n);
          });

          if (!initialMergeDone) {
            await mergeLocalAndRemote(remoteNotes);
            initialMergeDone = true;
            setStatus('同期済み');
            return;
          }

          applyingRemote = true;
          try {
            const localNotes = await getAllNotesIncludingDeleted();
            const localMap = new Map(localNotes.map((n) => [n.id, n]));
            let changed = false;

            for (const remote of remoteNotes) {
              const local = localMap.get(remote.id);
              const winner = preferNewer(local, remote);
              if (!winner) continue;
              if (
                !local ||
                (winner.updatedAt || 0) > (local.updatedAt || 0) ||
                (winner.deletedAt &&
                  !local.deletedAt &&
                  (winner.updatedAt || 0) >= (local.updatedAt || 0))
              ) {
                if (
                  !local ||
                  local.title !== winner.title ||
                  local.content !== winner.content ||
                  local.updatedAt !== winner.updatedAt ||
                  (local.deletedAt || null) !== (winner.deletedAt || null)
                ) {
                  await putNote(winner);
                  changed = true;
                }
              }
            }

            if (changed) onRemoteChange();
          } finally {
            applyingRemote = false;
          }
          setStatus('同期済み');
        } catch (err) {
          console.error('snapshot handler', err);
          setStatus('同期エラー');
        }
      },
      (err) => {
        console.error('onSnapshot error', err);
        setStatus('同期エラー');
      }
    );
  }

  async function signIn() {
    setStatus('サインイン中…');
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      const code = err && err.code;
      if (code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, provider);
        return;
      }
      setStatus(currentUser ? '同期済み' : 'ローカルのみ');
      throw err;
    }
  }

  async function signOutUser() {
    stopListener();
    await signOut(auth);
    setStatus('ローカルのみ');
  }

  function getUser() {
    return currentUser;
  }

  async function start() {
    try {
      await getRedirectResult(auth);
    } catch (err) {
      console.warn('getRedirectResult', err);
    }

    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      onAuthChange(user);
      if (user) {
        startListener(user);
      } else {
        stopListener();
        setStatus('ローカルのみ');
      }
    });
  }

  return {
    configured: true,
    getUser,
    signIn,
    signOutUser,
    pushNote,
    start
  };
}
