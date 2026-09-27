/**
 * Firebase Auth + Firestore 同期
 * IndexedDB をオフラインキャッシュとして維持し、サインイン時にクラウドとマージする
 * notes / projects を soft-delete + updatedAt マージで同期
 */
import { loadFirebaseConfig } from './firebase-config.js';

/** @typedef {{ id: string, title: string, content: string, projectId?: string|null, updatedAt: number, deletedAt?: number|null }} Note */
/** @typedef {{ id: string, name: string, updatedAt: number, deletedAt?: number|null }} Project */

const FIREBASE_VERSION = '10.14.1';
const gstatic = (pkg) =>
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/${pkg}.js`;

/**
 * @param {{
 *   getAllNotesIncludingDeleted: () => Promise<Note[]>,
 *   putNote: (note: Note) => Promise<Note>,
 *   getAllProjectsIncludingDeleted: () => Promise<Project[]>,
 *   putProject: (project: Project) => Promise<Project>,
 *   onRemoteChange: () => void,
 *   onAuthChange: (user: object|null) => void,
 *   onSyncStatus: (status: string) => void,
 * }} deps
 */
export async function createSync(deps) {
  const {
    getAllNotesIncludingDeleted,
    putNote,
    getAllProjectsIncludingDeleted,
    putProject,
    onRemoteChange,
    onAuthChange,
    onSyncStatus
  } = deps;

  const noopApi = (configured, signInMsg) => ({
    configured,
    getUser: () => null,
    signIn: async () => {
      throw new Error(signInMsg);
    },
    signOutUser: async () => {},
    pushNote: async () => {},
    pushProject: async () => {},
    start: async () => {}
  });

  const config = await loadFirebaseConfig();
  if (!config) {
    onSyncStatus('未設定');
    return noopApi(
      false,
      'Firebase が未設定です。firebase-config.local.js を作成してください。'
    );
  }

  let initializeApp, authMod, fsMod;
  try {
    [{ initializeApp }, authMod, fsMod] = await Promise.all([
      import(gstatic('firebase-app')),
      import(gstatic('firebase-auth')),
      import(gstatic('firebase-firestore'))
    ]);
  } catch (err) {
    console.warn(
      'Firebase SDK の読み込みに失敗しました（オフライン等）。ローカルのみで動作します。',
      err
    );
    onSyncStatus('ローカルのみ');
    return noopApi(
      true,
      'Firebase SDK を読み込めませんでした。ネットワークを確認して再読み込みしてください。'
    );
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
  let unsubNotes = null;
  /** @type {(() => void)|null} */
  let unsubProjects = null;
  let applyingRemote = false;
  let notesInitialDone = false;
  let projectsInitialDone = false;
  /** @type {Note[]|null} */
  let pendingRemoteNotes = null;
  /** @type {Project[]|null} */
  let pendingRemoteProjects = null;

  function notesCol(uid) {
    return collection(db, 'users', uid, 'notes');
  }

  function noteRef(uid, noteId) {
    return doc(db, 'users', uid, 'notes', noteId);
  }

  function projectsCol(uid) {
    return collection(db, 'users', uid, 'projects');
  }

  function projectRef(uid, projectId) {
    return doc(db, 'users', uid, 'projects', projectId);
  }

  function setStatus(s) {
    onSyncStatus(s);
  }

  /**
   * @template {{ updatedAt?: number, deletedAt?: number|null }} T
   * @param {T|null|undefined} a
   * @param {T|null|undefined} b
   * @returns {T|null}
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

  function normalizeProjectId(value) {
    if (value == null || value === '') return null;
    return String(value);
  }

  function normalizeRemoteNote(id, data) {
    if (!data || typeof data !== 'object') return null;
    /** @type {Note} */
    const note = {
      id: String(data.id || id),
      title: typeof data.title === 'string' ? data.title : '',
      content: typeof data.content === 'string' ? data.content : '',
      projectId: normalizeProjectId(data.projectId),
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0
    };
    if (data.deletedAt != null && data.deletedAt !== undefined) {
      note.deletedAt = typeof data.deletedAt === 'number' ? data.deletedAt : null;
    }
    return note;
  }

  function normalizeRemoteProject(id, data) {
    if (!data || typeof data !== 'object') return null;
    /** @type {Project} */
    const project = {
      id: String(data.id || id),
      name: typeof data.name === 'string' ? data.name : '',
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0
    };
    if (data.deletedAt != null && data.deletedAt !== undefined) {
      project.deletedAt =
        typeof data.deletedAt === 'number' ? data.deletedAt : null;
    }
    return project;
  }

  function toNotePayload(note) {
    /** @type {Record<string, unknown>} */
    const payload = {
      id: note.id,
      title: note.title || '',
      content: note.content || '',
      projectId: normalizeProjectId(note.projectId),
      updatedAt: note.updatedAt || Date.now()
    };
    if (note.deletedAt != null) {
      payload.deletedAt = note.deletedAt;
    }
    return payload;
  }

  function toProjectPayload(project) {
    /** @type {Record<string, unknown>} */
    const payload = {
      id: project.id,
      name: project.name || '',
      updatedAt: project.updatedAt || Date.now()
    };
    if (project.deletedAt != null) {
      payload.deletedAt = project.deletedAt;
    }
    return payload;
  }

  function noteChanged(local, winner) {
    return (
      !local ||
      local.title !== winner.title ||
      local.content !== winner.content ||
      normalizeProjectId(local.projectId) !== normalizeProjectId(winner.projectId) ||
      local.updatedAt !== winner.updatedAt ||
      (local.deletedAt || null) !== (winner.deletedAt || null)
    );
  }

  function projectChanged(local, winner) {
    return (
      !local ||
      local.name !== winner.name ||
      local.updatedAt !== winner.updatedAt ||
      (local.deletedAt || null) !== (winner.deletedAt || null)
    );
  }

  /**
   * 汎用マージ（notes / projects）
   * @template {{ id: string, updatedAt?: number, deletedAt?: number|null }} T
   */
  async function mergeCollections({
    localItems,
    remoteItems,
    putItem,
    uploadItems
  }) {
    const localMap = new Map(localItems.map((n) => [n.id, n]));
    const remoteMap = new Map(remoteItems.map((n) => [n.id, n]));
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
          await putItem(merged);
        } else if (
          local &&
          remote &&
          (remote.updatedAt || 0) === (local.updatedAt || 0) &&
          remote.deletedAt &&
          !local.deletedAt
        ) {
          await putItem(merged);
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
      await uploadItems(currentUser.uid, toUpload);
    }
  }

  async function uploadNotes(uid, notes) {
    if (!notes.length) return;
    const CHUNK = 400;
    for (let i = 0; i < notes.length; i += CHUNK) {
      const chunk = notes.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      for (const note of chunk) {
        batch.set(noteRef(uid, note.id), toNotePayload(note));
      }
      await batch.commit();
    }
  }

  async function uploadProjects(uid, projects) {
    if (!projects.length) return;
    const CHUNK = 400;
    for (let i = 0; i < projects.length; i += CHUNK) {
      const chunk = projects.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      for (const project of chunk) {
        batch.set(projectRef(uid, project.id), toProjectPayload(project));
      }
      await batch.commit();
    }
  }

  async function mergeLocalAndRemoteNotes(remoteNotes) {
    const localNotes = await getAllNotesIncludingDeleted();
    await mergeCollections({
      localItems: localNotes,
      remoteItems: remoteNotes,
      putItem: putNote,
      uploadItems: uploadNotes
    });
  }

  async function mergeLocalAndRemoteProjects(remoteProjects) {
    const localProjects = await getAllProjectsIncludingDeleted();
    await mergeCollections({
      localItems: localProjects,
      remoteItems: remoteProjects,
      putItem: putProject,
      uploadItems: uploadProjects
    });
  }

  async function tryFinishInitialMerge() {
    if (!notesInitialDone || !projectsInitialDone) return;
    if (pendingRemoteNotes == null || pendingRemoteProjects == null) return;
    try {
      await mergeLocalAndRemoteNotes(pendingRemoteNotes);
      await mergeLocalAndRemoteProjects(pendingRemoteProjects);
      pendingRemoteNotes = null;
      pendingRemoteProjects = null;
      setStatus('同期済み');
      onRemoteChange();
    } catch (err) {
      console.error('initial merge failed', err);
      setStatus('同期エラー');
    }
  }

  /**
   * @param {Note} note
   */
  async function pushNote(note) {
    if (!currentUser || applyingRemote) return;
    try {
      setStatus('同期中…');
      await setDoc(noteRef(currentUser.uid, note.id), toNotePayload(note));
      setStatus('同期済み');
    } catch (err) {
      console.error('pushNote failed', err);
      setStatus('同期エラー');
      throw err;
    }
  }

  /**
   * @param {Project} project
   */
  async function pushProject(project) {
    if (!currentUser || applyingRemote) return;
    try {
      setStatus('同期中…');
      await setDoc(
        projectRef(currentUser.uid, project.id),
        toProjectPayload(project)
      );
      setStatus('同期済み');
    } catch (err) {
      console.error('pushProject failed', err);
      setStatus('同期エラー');
      throw err;
    }
  }

  function stopListener() {
    if (unsubNotes) {
      unsubNotes();
      unsubNotes = null;
    }
    if (unsubProjects) {
      unsubProjects();
      unsubProjects = null;
    }
    notesInitialDone = false;
    projectsInitialDone = false;
    pendingRemoteNotes = null;
    pendingRemoteProjects = null;
  }

  /**
   * @param {object} user
   */
  function startListener(user) {
    stopListener();
    setStatus('同期中…');

    unsubNotes = onSnapshot(
      notesCol(user.uid),
      async (snap) => {
        try {
          const remoteNotes = [];
          snap.forEach((d) => {
            const n = normalizeRemoteNote(d.id, d.data());
            if (n) remoteNotes.push(n);
          });

          if (!notesInitialDone) {
            pendingRemoteNotes = remoteNotes;
            notesInitialDone = true;
            await tryFinishInitialMerge();
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
                if (noteChanged(local, winner)) {
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
          console.error('notes snapshot handler', err);
          setStatus('同期エラー');
        }
      },
      (err) => {
        console.error('notes onSnapshot error', err);
        setStatus('同期エラー');
      }
    );

    unsubProjects = onSnapshot(
      projectsCol(user.uid),
      async (snap) => {
        try {
          const remoteProjects = [];
          snap.forEach((d) => {
            const p = normalizeRemoteProject(d.id, d.data());
            if (p) remoteProjects.push(p);
          });

          if (!projectsInitialDone) {
            pendingRemoteProjects = remoteProjects;
            projectsInitialDone = true;
            await tryFinishInitialMerge();
            return;
          }

          applyingRemote = true;
          try {
            const localProjects = await getAllProjectsIncludingDeleted();
            const localMap = new Map(localProjects.map((p) => [p.id, p]));
            let changed = false;

            for (const remote of remoteProjects) {
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
                if (projectChanged(local, winner)) {
                  await putProject(winner);
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
          console.error('projects snapshot handler', err);
          setStatus('同期エラー');
        }
      },
      (err) => {
        console.error('projects onSnapshot error', err);
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
    pushProject,
    start
  };
}
