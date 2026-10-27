import { initializeApp } from "firebase/app";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  onAuthStateChanged, signOut
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot
} from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

const $ = id => document.getElementById(id);
const CFG_KEY = "joblog.firebaseConfig";
const isNative = Capacitor.isNativePlatform();

/* ---------------- Firebase config ---------------- */

export function parseConfig(text) {
  // Accepts the JS block Firebase shows (unquoted keys) or plain JSON.
  const out = {};
  const re = /["']?(\w+)["']?\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  const need = ["apiKey", "authDomain", "projectId", "appId"];
  const missing = need.filter(k => !out[k]);
  if (missing.length) throw new Error("Missing " + missing.join(", ") + ". Copy the whole firebaseConfig block.");
  return out;
}

function getConfig() {
  if (window.JOBLOG_FIREBASE && window.JOBLOG_FIREBASE.apiKey) return window.JOBLOG_FIREBASE;
  try { const c = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); if (c && c.apiKey) return c; } catch (e) {}
  return null;
}

function show(screen) {
  for (const id of ["setup", "auth", "main"]) $(id).hidden = id !== screen;
}

/* ---------------- State ---------------- */

let auth, fs, user = null, unsub = null;
let tasks = new Map();
let tab = "todo", editing = null, confirmDel = null;
let undoFn = null, toastTimer = null;

function boot() {
  const cfg = getConfig();
  if (!cfg) { show("setup"); return; }
  try {
    const app = initializeApp(cfg);
    auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
    fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    $("cfgErr").textContent = "That config didn't work: " + e.message;
    $("cfgErr").hidden = false; show("setup"); return;
  }
  onAuthStateChanged(auth, u => {
    if (unsub) { unsub(); unsub = null; }
    user = u; tasks = new Map();
    if (!u) { show("auth"); return; }
    $("who").textContent = "Signed in as " + u.email;
    show("main"); render(); listen();
  });
}

$("cfgSave").onclick = () => {
  try {
    const cfg = parseConfig($("cfgText").value);
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    location.reload();
  } catch (e) {
    $("cfgErr").textContent = e.message; $("cfgErr").hidden = false;
  }
};
$("changeProject").onclick = () => {
  try { localStorage.removeItem(CFG_KEY); } catch (e) {}
  location.reload();
};

/* ---------------- Auth ---------------- */

function authMsg(e) {
  const c = (e && e.code) || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Email or password is wrong.";
  if (c.includes("email-already-in-use")) return "That email already has an account. Tap Sign in instead.";
  if (c.includes("weak-password")) return "Use a password of at least 6 characters.";
  if (c.includes("invalid-email")) return "Enter a valid email address.";
  if (c.includes("operation-not-allowed")) return "Email sign-in is off. In Firebase, enable Authentication → Email/Password.";
  if (c.includes("network")) return "No internet connection. Connect once to sign in.";
  return e.message || "Something went wrong. Try again.";
}
function authErr(msg) { $("authErr").textContent = msg; $("authErr").hidden = !msg; }

$("authForm").addEventListener("submit", async e => {
  e.preventDefault(); authErr("");
  $("signInBtn").disabled = true;
  try { await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value); }
  catch (err) { authErr(authMsg(err)); }
  $("signInBtn").disabled = false;
});
$("createBtn").onclick = async () => {
  authErr("");
  if (!$("authForm").reportValidity()) return;
  try { await createUserWithEmailAndPassword(auth, $("email").value.trim(), $("password").value); }
  catch (err) { authErr(authMsg(err)); }
};
$("resetBtn").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) { authErr("Type your email first, then tap Forgot password."); return; }
  try { await sendPasswordResetEmail(auth, email); authErr(""); $("authErr").hidden = false; $("authErr").textContent = "Reset link sent to " + email + "."; }
  catch (err) { authErr(authMsg(err)); }
};
$("menuBtn").onclick = () => {
  const open = $("menu").hidden; $("menu").hidden = !open; $("menuBtn").setAttribute("aria-expanded", open);
};
$("signOut").onclick = async () => { $("menu").hidden = true; await cancelAllReminders(); signOut(auth); };

/* ---------------- Data ---------------- */

const tasksCol = () => collection(fs, "users", user.uid, "tasks");

function listen() {
  setSync("", "Connecting…");
  unsub = onSnapshot(tasksCol(), { includeMetadataChanges: true }, snap => {
    const m = new Map();
    snap.forEach(d => m.set(d.id, d.data()));
    tasks = m; render(); syncReminders();
    if (snap.metadata.fromCache) setSync("off", navigator.onLine ? "Syncing…" : "Offline — saved on phone");
    else if (snap.metadata.hasPendingWrites) setSync("", "Saving…");
    else setSync("live", "Synced");
  }, err => setSync("off", "Sync error — sign out and in"));
}
window.addEventListener("online", () => setSync("", "Syncing…"));
window.addEventListener("offline", () => setSync("off", "Offline — saved on device"));

function setSync(state, text) { $("sync").className = "sync " + state; $("syncText").textContent = text; }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function put(id, body) {
  tasks.set(id, body); render();
  setDoc(doc(tasksCol(), id), body).catch(fail);
}
function remove(id) {
  tasks.delete(id); render();
  deleteDoc(doc(tasksCol(), id)).catch(fail);
}
function fail(e) { showToast("Couldn't save: " + ((e && e.code) || "error") + ". Try again."); }

/* ---------------- Reminders (Android only) ---------------- */

export function notifId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 2000000000 + 1;
}
let remindersBusy = false, remindersAgain = false;
async function syncReminders() {
  if (!isNative) return;
  if (remindersBusy) { remindersAgain = true; return; }
  remindersBusy = true;
  try {
    const now = Date.now();
    const want = [...tasks.entries()].filter(([, t]) => !t.done && t.due && t.due > now);
    const pending = (await LocalNotifications.getPending()).notifications || [];
    if (pending.length) await LocalNotifications.cancel({ notifications: pending.map(n => ({ id: n.id })) });
    if (want.length) {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") return;
      await LocalNotifications.schedule({
        notifications: want.slice(0, 60).map(([id, t]) => ({
          id: notifId(id), title: t.urgent ? "Urgent job due" : "Job due",
          body: t.title, schedule: { at: new Date(t.due), allowWhileIdle: true }
        }))
      });
    }
  } catch (e) { /* reminders are best-effort */ }
  finally { remindersBusy = false; if (remindersAgain) { remindersAgain = false; syncReminders(); } }
}
async function askNotifyPermission() {
  if (!isNative) return;
  try {
    const p = await LocalNotifications.checkPermissions();
    if (p.display !== "granted") await LocalNotifications.requestPermissions();
  } catch (e) {}
}
async function cancelAllReminders() {
  if (!isNative) return;
  try {
    const pending = (await LocalNotifications.getPending()).notifications || [];
    if (pending.length) await LocalNotifications.cancel({ notifications: pending.map(n => ({ id: n.id })) });
  } catch (e) {}
}

/* ---------------- Dates ---------------- */

export const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export function startOfWeek(now = Date.now()) { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); }
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function fmtWhen(t) {
  const sd = startOfDay(t), today = startOfDay(Date.now());
  if (sd === today) return "today " + fmtTime(t);
  if (sd === today + 864e5) return "tomorrow " + fmtTime(t);
  if (sd === today - 864e5) return "yesterday " + fmtTime(t);
  return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }) + " " + fmtTime(t);
}
function dayLabel(t) {
  const today = startOfDay(Date.now()), d = startOfDay(t);
  if (d === today) return "Today";
  if (d === today - 864e5) return "Yesterday";
  const y = new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: y });
}
function ago(t) {
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(t)) / 864e5);
  return days <= 0 ? "added today" : days === 1 ? "added yesterday" : "added " + days + " days ago";
}

/* ---------------- Render ---------------- */

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const tick = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function row(id, t) {
  const li = el("li", "item" + (t.done ? " done" : ""));
  const c = el("button", "check"); c.type = "button";
  c.setAttribute("aria-label", t.done ? "Mark as not done" : "Mark as done");
  if (t.done) c.innerHTML = tick;
  c.onclick = () => toggle(id);
  const body = el("div", "body");
  if (editing === id) {
    const inp = el("input", "edit"); inp.value = t.title; inp.maxLength = 200;
    let done = false;
    const commit = () => { if (done) return; done = true; const v = inp.value.trim(); editing = null; if (v && v !== t.title) put(id, { ...t, title: v }); else render(); };
    inp.onkeydown = e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { done = true; editing = null; render(); } };
    inp.onblur = commit;
    body.append(inp); setTimeout(() => inp.focus(), 0);
  } else body.append(el("div", "title", t.title));
  const meta = el("div", "meta");
  if (t.urgent && !t.done) meta.append(el("span", "pri", "URGENT"));
  if (t.done) meta.append(el("span", "stampt", "Done " + fmtTime(t.doneAt)));
  else {
    if (t.due) meta.append(el("span", t.due < Date.now() ? "late" : "", (t.due < Date.now() ? "overdue · was due " : "due ") + fmtWhen(t.due)));
    meta.append(el("span", "", ago(t.createdAt)));
  }
  body.append(meta);
  const acts = el("div", "acts");
  if (!t.done && editing !== id) {
    const e = el("button", "icon", "Edit"); e.type = "button";
    e.onclick = () => { editing = id; confirmDel = null; render(); }; acts.append(e);
  }
  const d = el("button", "icon" + (confirmDel === id ? " confirm" : ""), confirmDel === id ? "Delete?" : "Delete"); d.type = "button";
  d.onclick = () => {
    if (confirmDel !== id) { confirmDel = id; render(); return; }
    confirmDel = null; const copy = { ...t }; remove(id);
    showToast("Job deleted.", () => put(id, copy));
  };
  acts.append(d);
  li.append(c, body, acts);
  return li;
}

export function summarize(list, now = Date.now()) {
  const todo = list.filter(([, t]) => !t.done).sort((a, b) =>
    (b[1].urgent ? 1 : 0) - (a[1].urgent ? 1 : 0) ||
    (a[1].due || Infinity) - (b[1].due || Infinity) ||
    a[1].createdAt - b[1].createdAt);
  const done = list.filter(([, t]) => t.done).sort((a, b) => b[1].doneAt - a[1].doneAt);
  const today = startOfDay(now), wk = startOfWeek(now);
  return { todo, done, doneToday: done.filter(([, t]) => t.doneAt >= today).length, doneWeek: done.filter(([, t]) => t.doneAt >= wk).length };
}

function render() {
  if ($("main").hidden) return;
  const { todo, done, doneToday, doneWeek } = summarize([...tasks.entries()]);
  $("sOpen").textContent = todo.length; $("sToday").textContent = doneToday; $("sWeek").textContent = doneWeek;
  $("nTodo").textContent = todo.length; $("nDone").textContent = done.length;
  $("tabTodo").setAttribute("aria-selected", tab === "todo");
  $("tabDone").setAttribute("aria-selected", tab === "done");
  const v = $("view"); v.replaceChildren();
  if (tab === "todo") {
    if (!todo.length) {
      const e = el("div", "empty"); e.append(el("b", null, "Nothing on the list"),
        document.createTextNode("Type a job below and tap Add. Set a due time to get a reminder on your phone. Tick a job when it's finished and it moves to the Done log with the time."));
      v.append(e); return;
    }
    const ul = el("ul", "list"); todo.forEach(([id, t]) => ul.append(row(id, t))); v.append(ul);
  } else {
    if (!done.length) {
      const e = el("div", "empty"); e.append(el("b", null, "No finished jobs yet"),
        document.createTextNode("Jobs you tick off appear here, grouped by day, with the time each was done."));
      v.append(e); return;
    }
    let cur = null, ul = null, count = 0, head = null;
    done.forEach(([id, t]) => {
      const k = startOfDay(t.doneAt);
      if (k !== cur) { cur = k; count = 0; head = el("div", "day"); head.append(el("span", null, dayLabel(t.doneAt)), el("span", null, "")); ul = el("ul", "list"); v.append(head, ul); }
      count++; head.lastChild.textContent = count + (count === 1 ? " job" : " jobs");
      ul.append(row(id, t));
    });
  }
}

function toggle(id) {
  const t = tasks.get(id); if (!t) return;
  const prev = { ...t };
  const next = t.done ? { ...t, done: false, doneAt: null } : { ...t, done: true, doneAt: Date.now() };
  put(id, next);
  if (next.done) showToast("Marked done at " + fmtTime(next.doneAt) + ".", () => put(id, prev));
}

function showToast(text, undo) {
  $("toastText").textContent = text; undoFn = undo || null;
  $("toastUndo").hidden = !undo; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; undoFn = null; }, 5000);
}
$("toastUndo").onclick = () => { if (undoFn) undoFn(); undoFn = null; $("toast").hidden = true; };
$("tabTodo").onclick = () => { tab = "todo"; confirmDel = null; render(); };
$("tabDone").onclick = () => { tab = "done"; confirmDel = null; render(); };
$("flagBtn").onclick = () => { const b = $("flagBtn"); b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); };
$("newDue").addEventListener("change", () => { if ($("newDue").value) askNotifyPermission(); });
$("addForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("newTitle").value.trim(); if (!v) return;
  const urgent = $("flagBtn").getAttribute("aria-pressed") === "true";
  const dueVal = $("newDue").value;
  const due = dueVal ? new Date(dueVal).getTime() : null;
  put(newId(), { title: v, urgent, due, done: false, createdAt: Date.now(), doneAt: null });
  $("newTitle").value = ""; $("newDue").value = ""; $("flagBtn").setAttribute("aria-pressed", "false");
  if (tab !== "todo") { tab = "todo"; render(); }
});
// Refresh "overdue" labels and day boundaries every minute.
setInterval(render, 60000);

if (typeof document !== "undefined" && $("setup")) boot();
