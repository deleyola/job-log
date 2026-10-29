import "./styles.css";
import { initializeApp } from "firebase/app";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence,
  setPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  onAuthStateChanged, signOut
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot
} from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { NativeBiometric } from "@capgo/capacitor-native-biometric";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { StatusBar, Style } from "@capacitor/status-bar";
import { App } from "@capacitor/app";

const $ = id => document.getElementById(id);
const isNative = Capacitor.isNativePlatform();
const BIO_SERVER = "com.joblog.app";
const pref = {
  get(k, d) { try { const v = localStorage.getItem("joblog." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("joblog." + k, JSON.stringify(v)); } catch (e) {} }
};

/* ================= Helpers ================= */
const DAY = 864e5;
export const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export function startOfWeek(now = Date.now()) { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); }
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function relDay(t, now = Date.now()) {
  const d = Math.round((startOfDay(t) - startOfDay(now)) / DAY);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  if (d > 1 && d < 7) return new Date(t).toLocaleDateString([], { weekday: "long" });
  const y = new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric";
  return new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: y });
}
const relLower = t => { const r = relDay(t); return ["Today", "Tomorrow", "Yesterday"].includes(r) ? r.toLowerCase() : r; };
function dueLabel(t) { const r = relDay(t); return (r === "Today" ? "" : r + " ") + fmtTime(t); }
function ageLabel(t) {
  const d = Math.floor((startOfDay(Date.now()) - startOfDay(t)) / DAY);
  return d <= 0 ? "Added today" : d === 1 ? "Added yesterday" : "Added " + d + " days ago";
}
const toLocalInput = ms => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function at(dayOffset, h, m = 0) { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); }
function nextMonday9() { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); d.setHours(9, 0, 0, 0); return d.getTime(); }
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svgUse = (id, cls = "ic") => { const ns = "http://www.w3.org/2000/svg"; const s = document.createElementNS(ns, "svg"); s.setAttribute("class", cls); const u = document.createElementNS(ns, "use"); u.setAttribute("href", "#" + id); s.append(u); return s; };
const buzz = (kind = "light") => {
  if (!isNative) return;
  try { kind === "success" ? Haptics.notification({ type: NotificationType.Success }) : Haptics.impact({ style: ImpactStyle.Light }); } catch (e) {}
};

/* ================= Pure logic (tested) ================= */
export function summarize(list, now = Date.now()) {
  const today = startOfDay(now), wk = startOfWeek(now);
  const todo = list.filter(([, t]) => !t.done);
  const done = list.filter(([, t]) => t.done).sort((a, b) => b[1].doneAt - a[1].doneAt);
  const week = Array(7).fill(0);
  done.forEach(([, t]) => { if (t.doneAt >= wk && t.doneAt < wk + 7 * DAY) week[Math.floor((startOfDay(t.doneAt) - wk) / DAY + 0.5)]++; });
  return {
    todo, done, week,
    doneToday: done.filter(([, t]) => t.doneAt >= today).length,
    doneWeek: done.filter(([, t]) => t.doneAt >= wk).length,
    overdue: todo.filter(([, t]) => t.due && t.due < now).length,
    todayIndex: Math.round((today - wk) / DAY)
  };
}
export function groupTodo(todo, now = Date.now()) {
  const t0 = startOfDay(now), t1 = t0 + DAY, t2 = t0 + 2 * DAY;
  const g = { overdue: [], today: [], tomorrow: [], later: [], anytime: [] };
  todo.forEach(e => {
    const d = e[1].due;
    if (!d) g.anytime.push(e);
    else if (d < now) g.overdue.push(e);
    else if (d < t1) g.today.push(e);
    else if (d < t2) g.tomorrow.push(e);
    else g.later.push(e);
  });
  const sort = (a, b) => (b[1].urgent ? 1 : 0) - (a[1].urgent ? 1 : 0) || (a[1].due || 0) - (b[1].due || 0) || a[1].createdAt - b[1].createdAt;
  Object.values(g).forEach(a => a.sort(sort));
  return g;
}
export function notifId(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return Math.abs(h) % 2000000000 + 1; }

/* ================= Screens ================= */
function show(screen) { for (const id of ["lock", "auth", "main"]) $(id).hidden = id !== screen; }

/* ================= Firebase ================= */
let auth, fs, user = null, unsub = null, tasks = new Map();
let unlocked = false, lastCreds = null, bioAvail = false;

async function boot() {
  applyTheme();
  if (isNative) {
    try { bioAvail = (await NativeBiometric.isAvailable()).isAvailable; } catch (e) { bioAvail = false; }
    App.addListener("pause", () => { pausedAt = Date.now(); });
    App.addListener("resume", () => {
      if (user && pref.get("bio", false) && Date.now() - pausedAt > 60000) { unlocked = false; showLock(); }
    });
  }
  const cfg = window.JOBLOG_FIREBASE;
  if (!cfg || !cfg.apiKey) { show("auth"); authMsg("This build has no Firebase config. Add it to www/config.js."); return; }
  const app = initializeApp(cfg);
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  onAuthStateChanged(auth, u => {
    if (unsub) { unsub(); unsub = null; }
    user = u; tasks = new Map();
    if (!u) { unlocked = false; showAuth(); return; }
    if (isNative && pref.get("bio", false) && !unlocked) showLock();
    else enterMain();
  });
}
let pausedAt = Date.now();

/* ---------- Theme & status bar ---------- */
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
const themePref = () => { const t = pref.get("theme", "light"); return ["light", "dark", "system"].includes(t) ? t : "light"; };
const isDark = () => themePref() === "dark" || (themePref() === "system" && darkMQ.matches);
function applyTheme() {
  document.documentElement.setAttribute("data-theme", themePref());
  const dark = isDark(), bg = dark ? "#0A100D" : "#F3F5F1";
  $("themeColor").setAttribute("content", bg);
  document.querySelectorAll("[data-theme-opt]").forEach(b => b.setAttribute("aria-pressed", b.dataset.themeOpt === themePref()));
  if (!isNative) return;
  try {
    StatusBar.setOverlaysWebView({ overlay: false });
    StatusBar.setBackgroundColor({ color: bg });
    StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch (e) {}
}
darkMQ.addEventListener?.("change", applyTheme);
document.querySelectorAll("[data-theme-opt]").forEach(b => b.onclick = () => { pref.set("theme", b.dataset.themeOpt); applyTheme(); buzz(); });

/* ---------- Lock ---------- */
function showLock() {
  closeAllSheets();
  $("lockWho").textContent = user ? user.email : "";
  show("lock");
  setTimeout(unlock, 250);
}
let unlocking = false;
async function unlock() {
  if (unlocking) return; unlocking = true;
  try {
    await NativeBiometric.verifyIdentity({ title: "Unlock Job Log", subtitle: user ? user.email : "", negativeButtonText: "Cancel", maxAttempts: 5 });
    unlocked = true; buzz("success"); enterMain();
  } catch (e) { /* stays on lock screen */ }
  unlocking = false;
}
$("unlockBtn").onclick = unlock;
$("lockSignOut").onclick = () => signOut(auth);

/* ---------- Auth ---------- */
let mode = "signin";
function authMsg(text, ok) { const m = $("authErr"); m.textContent = text || ""; m.hidden = !text; m.classList.toggle("ok", !!ok); }
function setMode(m) {
  mode = m;
  $("authTitle").textContent = m === "signin" ? "Welcome back" : "Create your account";
  $("authSub").textContent = m === "signin" ? "Sign in to see your jobs on this device." : "Use the same email on your phone and computer to share one list.";
  $("submitBtn").textContent = m === "signin" ? "Sign in" : "Create account";
  $("modeBtn").textContent = m === "signin" ? "New here? Create an account" : "Have an account? Sign in";
  $("password").autocomplete = m === "signin" ? "current-password" : "new-password";
  $("resetBtn").hidden = m !== "signin";
  authMsg("");
}
async function showAuth() {
  closeAllSheets(); setMode("signin");
  $("keep").checked = pref.get("keep", true);
  const bioReady = isNative && bioAvail && pref.get("bioSaved", false);
  $("bioSignIn").hidden = $("bioOr").hidden = !bioReady;
  if (pref.get("email", "")) $("email").value = pref.get("email", "");
  show("auth");
  if (bioReady) setTimeout(bioSignIn, 300);
  else if (!isNative && window.PasswordCredential && navigator.credentials) {
    try {
      const c = await navigator.credentials.get({ password: true, mediation: "optional" });
      if (c && c.password) { $("email").value = c.id; $("password").value = c.password; }
    } catch (e) {}
  }
}
function friendly(e) {
  const c = (e && e.code) || "";
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return "That email and password don't match. Check them and try again.";
  if (c.includes("email-already-in-use")) return "That email already has an account. Sign in instead.";
  if (c.includes("weak-password")) return "Use a password with at least 6 characters.";
  if (c.includes("invalid-email")) return "Enter a valid email address.";
  if (c.includes("too-many-requests")) return "Too many attempts. Wait a minute, then try again.";
  if (c.includes("network")) return "No internet connection. You need to be online to sign in.";
  if (c.includes("operation-not-allowed")) return "Email sign-in is turned off in Firebase → Authentication.";
  return (e && e.message) || "Something went wrong. Try again.";
}
async function doSignIn(email, password, create) {
  await setPersistence(auth, $("keep").checked ? indexedDBLocalPersistence : browserSessionPersistence);
  pref.set("keep", $("keep").checked); pref.set("email", email);
  lastCreds = { email, password }; unlocked = true;
  if (create) await createUserWithEmailAndPassword(auth, email, password);
  else await signInWithEmailAndPassword(auth, email, password);
  afterPasswordSignIn(email, password);
}
async function afterPasswordSignIn(email, password) {
  if (!isNative) {
    if (window.PasswordCredential && navigator.credentials) {
      try { await navigator.credentials.store(new window.PasswordCredential({ id: email, password, name: email })); } catch (e) {}
    }
    return;
  }
  if (!bioAvail) return;
  if (pref.get("bio", false)) { try { await NativeBiometric.setCredentials({ username: email, password, server: BIO_SERVER }); pref.set("bioSaved", true); } catch (e) {} }
  else if (!pref.get("bioAsked", false)) setTimeout(() => openSheet("bioOffer"), 700);
}
$("authForm").addEventListener("submit", async e => {
  e.preventDefault(); authMsg("");
  const email = $("email").value.trim(), pw = $("password").value;
  $("submitBtn").disabled = true;
  try { await doSignIn(email, pw, mode === "create"); $("password").value = ""; }
  catch (err) { unlocked = false; lastCreds = null; authMsg(friendly(err)); }
  $("submitBtn").disabled = false;
});
$("modeBtn").onclick = () => setMode(mode === "signin" ? "create" : "signin");
$("resetBtn").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) { authMsg("Type your email above, then tap Forgot password."); $("email").focus(); return; }
  try { await sendPasswordResetEmail(auth, email); authMsg("Password reset link sent to " + email + ".", true); }
  catch (err) { authMsg(friendly(err)); }
};
$("pwToggle").onclick = () => {
  const on = $("password").type === "password";
  $("password").type = on ? "text" : "password";
  $("pwToggle").setAttribute("aria-pressed", on); $("pwToggle").setAttribute("aria-label", on ? "Hide password" : "Show password");
};
async function bioSignIn() {
  try {
    await NativeBiometric.verifyIdentity({ title: "Sign in to Job Log", negativeButtonText: "Use password", maxAttempts: 5 });
    const c = await NativeBiometric.getCredentials({ server: BIO_SERVER });
    $("bioSignIn").disabled = true;
    unlocked = true;
    await setPersistence(auth, indexedDBLocalPersistence);
    await signInWithEmailAndPassword(auth, c.username, c.password);
    buzz("success");
  } catch (err) {
    unlocked = false;
    if (err && err.code && String(err.code).startsWith("auth/")) {
      authMsg(/invalid-credential|wrong-password/.test(err.code) ? "Your saved password no longer works. Sign in with your password to update it." : friendly(err));
    }
  }
  $("bioSignIn").disabled = false;
}
$("bioSignIn").onclick = bioSignIn;

/* ---------- Fingerprint offer & account ---------- */
async function enableBio() {
  try {
    await NativeBiometric.verifyIdentity({ title: "Turn on fingerprint", subtitle: "Confirm it's you", negativeButtonText: "Cancel" });
    if (lastCreds) { await NativeBiometric.setCredentials({ username: lastCreds.email, password: lastCreds.password, server: BIO_SERVER }); pref.set("bioSaved", true); }
    pref.set("bio", true); buzz("success");
    showToast(lastCreds ? "Fingerprint unlock is on." : "Fingerprint lock is on. Sign in with your password once more to enable fingerprint sign-in.");
    return true;
  } catch (e) { return false; }
}
async function disableBio() {
  pref.set("bio", false); pref.set("bioSaved", false);
  try { await NativeBiometric.deleteCredentials({ server: BIO_SERVER }); } catch (e) {}
}
$("bioYes").onclick = async () => { pref.set("bioAsked", true); closeSheet(); await enableBio(); };
$("bioNo").onclick = () => { pref.set("bioAsked", true); closeSheet(); };
$("avatarBtn").onclick = () => {
  $("accEmail").textContent = user ? user.email : "";
  $("bioRow").hidden = !(isNative && bioAvail);
  $("bioToggle").checked = pref.get("bio", false);
  $("remindRow").hidden = !isNative;
  $("remindToggle").checked = pref.get("remind", true);
  openSheet("account");
};
$("bioToggle").onchange = async () => {
  if ($("bioToggle").checked) { const ok = await enableBio(); $("bioToggle").checked = ok; }
  else { await disableBio(); showToast("Fingerprint unlock is off."); }
};
$("remindToggle").onchange = async () => {
  pref.set("remind", $("remindToggle").checked);
  if ($("remindToggle").checked) await askNotifyPermission();
  syncReminders();
};
$("signOutBtn").onclick = async () => { closeSheet(); await cancelAllReminders(); signOut(auth); };

/* ================= Main ================= */
const tasksCol = () => collection(fs, "users", user.uid, "tasks");
function enterMain() {
  closeAllSheets();
  const initial = (user.email || "?").trim()[0].toUpperCase();
  $("avatarTxt").textContent = $("accAvatar").textContent = initial;
  show("main"); render();
  if (!unsub) listen();
}
function listen() {
  setSync("", "Connecting…");
  unsub = onSnapshot(tasksCol(), { includeMetadataChanges: true }, snap => {
    const m = new Map(); snap.forEach(d => m.set(d.id, d.data()));
    tasks = m; render(); syncReminders();
    if (snap.metadata.fromCache) setSync("off", navigator.onLine ? "Syncing…" : "Offline · saved here");
    else if (snap.metadata.hasPendingWrites) setSync("", "Saving…");
    else setSync("live", "Synced");
  }, () => setSync("off", "Sync paused · sign in again"));
}
window.addEventListener("offline", () => setSync("off", "Offline · saved here"));
window.addEventListener("online", () => setSync("", "Syncing…"));
function setSync(state, text) { $("sync").className = "sync " + state; $("syncText").textContent = text; }
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function put(id, body) { tasks.set(id, body); render(); setDoc(doc(tasksCol(), id), body).catch(fail); }
function remove(id) { tasks.delete(id); render(); deleteDoc(doc(tasksCol(), id)).catch(fail); }
function fail(e) { showToast("Couldn't save that change. Check your connection and try again."); }

/* ---------- Reminders ---------- */
let remBusy = false, remAgain = false;
async function syncReminders() {
  if (!isNative) return;
  if (remBusy) { remAgain = true; return; }
  remBusy = true;
  try {
    const pending = (await LocalNotifications.getPending()).notifications || [];
    if (pending.length) await LocalNotifications.cancel({ notifications: pending.map(n => ({ id: n.id })) });
    const now = Date.now();
    const want = pref.get("remind", true) ? [...tasks.entries()].filter(([, t]) => !t.done && t.due && t.due > now) : [];
    if (want.length && (await LocalNotifications.checkPermissions()).display === "granted") {
      await LocalNotifications.schedule({ notifications: want.slice(0, 60).map(([id, t]) => ({
        id: notifId(id), title: t.urgent ? "Urgent job due now" : "Job due now", body: t.title,
        schedule: { at: new Date(t.due), allowWhileIdle: true }
      })) });
    }
  } catch (e) {}
  finally { remBusy = false; if (remAgain) { remAgain = false; syncReminders(); } }
}
async function askNotifyPermission() {
  if (!isNative) return;
  try { if ((await LocalNotifications.checkPermissions()).display !== "granted") await LocalNotifications.requestPermissions(); } catch (e) {}
}
async function cancelAllReminders() {
  if (!isNative) return;
  try { const p = (await LocalNotifications.getPending()).notifications || []; if (p.length) await LocalNotifications.cancel({ notifications: p.map(n => ({ id: n.id })) }); } catch (e) {}
}

/* ---------- Render ---------- */
let tab = "todo";
const ART_TODO = '<svg class="art" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="40" fill="var(--accent-soft)"/><circle cx="42" cy="42" r="26" fill="var(--surface)" stroke="var(--accent)" stroke-width="3"/><path d="M31 42.5l7.5 7.5L54 34.5" fill="none" stroke="var(--accent)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ART_DONE = '<svg class="art" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="40" fill="var(--surface-2)"/><path d="M30 24v36" stroke="var(--line-2)" stroke-width="3" stroke-linecap="round"/><circle cx="30" cy="30" r="5" fill="var(--accent)"/><circle cx="30" cy="44" r="5" fill="var(--line-2)"/><circle cx="30" cy="58" r="5" fill="var(--line-2)"/><rect x="40" y="27" width="20" height="6" rx="3" fill="var(--ink-3)"/><rect x="40" y="41" width="14" height="6" rx="3" fill="var(--line-2)"/><rect x="40" y="55" width="17" height="6" rx="3" fill="var(--line-2)"/></svg>';

function render() {
  if ($("main").hidden) return;
  const now = Date.now();
  const s = summarize([...tasks.entries()], now);
  $("weekday").textContent = new Date(now).toLocaleDateString([], { weekday: "long" });
  $("dateTitle").textContent = new Date(now).toLocaleDateString([], { day: "numeric", month: "long" });
  $("sToday").textContent = s.doneToday; $("sOpen").textContent = s.todo.length;
  $("sOverdue").textContent = s.overdue; $("sOverdue").classList.toggle("zero", !s.overdue);
  $("sWeek").textContent = s.doneWeek;
  const total = s.doneToday + s.todo.length;
  $("ringFill").setAttribute("stroke-dashoffset", (314.16 * (1 - (total ? s.doneToday / total : 0))).toFixed(1));
  const max = Math.max(1, ...s.week), wk = $("week"); wk.replaceChildren();
  "MTWTFSS".split("").forEach((l, i) => {
    const c = el("div", "wk" + (s.week[i] ? " has" : "") + (i === s.todayIndex ? " today" : ""));
    c.title = s.week[i] + " done";
    const bar = el("i"); bar.style.height = Math.max(8, (s.week[i] / max) * 100) * 0.7 + "%";
    c.append(bar, el("span", null, l)); wk.append(c);
  });
  $("nTodo").textContent = s.todo.length; $("nDone").textContent = s.done.length;
  $("tabTodo").setAttribute("aria-selected", tab === "todo"); $("tabDone").setAttribute("aria-selected", tab === "done");
  document.querySelector(".seg").classList.toggle("done", tab === "done");
  const v = $("view"); v.replaceChildren();
  tab === "todo" ? renderTodo(v, s, now) : renderDone(v, s);
}

function emptyState(v, art, title, text) {
  const e = el("div", "empty"); e.insertAdjacentHTML("afterbegin", art);
  e.append(el("b", null, title), el("p", null, text)); v.append(e);
}

function renderTodo(v, s, now) {
  if (!s.todo.length) {
    s.doneToday ? emptyState(v, ART_TODO, "All clear", "You've finished every job. Today's work is in the Done log.")
                : emptyState(v, ART_TODO, "Nothing on the list", "Tap New job to add your first one. Give it a due time and your phone will remind you.");
    return;
  }
  const g = groupTodo(s.todo, now);
  const sections = [["overdue", "Overdue"], ["today", "Due today"], ["tomorrow", "Tomorrow"], ["later", "Coming up"], ["anytime", "Anytime"]];
  sections.forEach(([k, label]) => {
    if (!g[k].length) return;
    const sec = el("section", "group");
    const h = el("div", "ghead" + (k === "overdue" ? " od" : "")); h.append(el("h4", null, label), el("span", null, String(g[k].length)));
    const ul = el("ul", "tasks");
    g[k].forEach(([id, t]) => ul.append(taskRow(id, t, now)));
    sec.append(h, ul); v.append(sec);
  });
}

function taskRow(id, t, now) {
  const li = el("li", "task" + (t.urgent ? " urgent" : ""));
  const tick = el("button", "tick"); tick.type = "button"; tick.setAttribute("aria-label", "Mark “" + t.title + "” as done");
  tick.append(svgUse("i-check"));
  tick.onclick = () => complete(id, li);
  const body = el("button", "tbody"); body.type = "button"; body.setAttribute("aria-label", "Edit “" + t.title + "”");
  body.append(el("span", "tt", t.title));
  const chips = el("span", "chips");
  if (t.urgent) { const p = el("span", "pill u"); p.append(svgUse("i-flag"), "Urgent"); chips.append(p); }
  if (t.due) {
    const late = t.due < now;
    const p = el("span", "pill " + (late ? "late" : "d")); p.append(svgUse("i-clock"), (late ? "Was due " : "") + (late ? relLower(t.due) + " " + fmtTime(t.due) : dueLabel(t.due)));
    chips.append(p);
  }
  chips.append(el("span", "pill age", ageLabel(t.createdAt)));
  body.append(chips);
  body.onclick = () => openComposer(id);
  li.append(tick, body);
  return li;
}

const completing = new Set();
function complete(id, li) {
  if (completing.has(id)) return; completing.add(id);
  buzz(); li.classList.add("completing");
  setTimeout(() => li.classList.add("leaving"), 380);
  setTimeout(() => {
    completing.delete(id);
    const t = tasks.get(id); if (!t) return;
    const prev = { ...t }, next = { ...t, done: true, doneAt: Date.now() };
    put(id, next);
    showToast("Done at " + fmtTime(next.doneAt), () => put(id, prev));
  }, 620);
}

function renderDone(v, s) {
  if (!s.done.length) { emptyState(v, ART_DONE, "Your log is empty", "Every job you tick off lands here with the time you finished it, grouped by day."); return; }
  let cur = null, ul, head, count = 0;
  s.done.forEach(([id, t]) => {
    const k = startOfDay(t.doneAt);
    if (k !== cur) {
      cur = k; count = 0;
      const day = el("section", "dday"); head = el("div", "dhead");
      head.append(el("h4", null, relDay(t.doneAt)), el("span"));
      ul = el("ul", "timeline"); day.append(head, ul); v.append(day);
    }
    count++; head.lastChild.textContent = count + (count === 1 ? " job" : " jobs");
    const li = el("li", "log"); li.tabIndex = 0; li.setAttribute("role", "button");
    const body = el("div", "lbody"); body.append(el("div", "lt", t.title));
    const meta = [t.urgent ? "Urgent" : "", "Added " + relLower(t.createdAt)].filter(Boolean).join(" · ");
    body.append(el("div", "lmeta", meta));
    const rail = el("div", "rail"); rail.append(el("i"));
    li.append(el("div", "ltime", fmtTime(t.doneAt)), rail, body);
    const open = () => openActions(id);
    li.onclick = open; li.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    ul.append(li);
  });
}

/* ---------- Sheets ---------- */
let openId = null;
function openSheet(id) {
  if (openId && openId !== id) $(openId).classList.remove("show"), $(openId).hidden = true;
  openId = id; const sh = $(id), sc = $("scrim");
  sc.hidden = false; sh.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { sc.classList.add("show"); sh.classList.add("show"); }));
}
function closeSheet() {
  if (!openId) return;
  const sh = $(openId), sc = $("scrim"); openId = null;
  sh.classList.remove("show"); sc.classList.remove("show");
  setTimeout(() => { if (!sh.classList.contains("show")) sh.hidden = true; if (!openId) sc.hidden = true; }, 300);
}
function closeAllSheets() { ["composer", "actions", "account", "bioOffer"].forEach(i => { $(i).classList.remove("show"); $(i).hidden = true; }); $("scrim").hidden = true; $("scrim").classList.remove("show"); openId = null; }
$("scrim").onclick = closeSheet;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
if (isNative) App.addListener("backButton", ({ canGoBack }) => { if (openId) closeSheet(); else App.minimizeApp(); });

/* ---------- Composer ---------- */
let editId = null, compDue = null, compUrgent = false, delArmed = false;
function dueOptions() {
  const h = new Date().getHours();
  const todayOpt = h < 17 ? ["Today 5 PM", at(0, 17)] : h < 20 ? ["Tonight 8 PM", at(0, 20)] : null;
  return [["No date", null], todayOpt, ["Tomorrow 9 AM", at(1, 9)], ["Monday 9 AM", nextMonday9()], ["Pick a time…", "pick"]].filter(Boolean);
}
function renderDue() {
  const row = $("dueChips"); row.replaceChildren();
  let matched = false;
  dueOptions().forEach(([label, val]) => {
    const b = el("button", "chip", label); b.type = "button";
    let on = false;
    if (val === null) on = compDue === null;
    else if (val === "pick") on = false;
    else on = compDue === val;
    if (on) matched = true;
    if (val === "pick") { b.prepend(svgUse("i-clock")); on = !matched && compDue !== null; }
    b.setAttribute("aria-pressed", on);
    b.onclick = () => {
      if (val === "pick") {
        $("dtRow").hidden = false;
        if (!compDue) compDue = at(0, new Date().getHours() + 1);
        $("compDue").value = toLocalInput(compDue);
        renderDue(); $("compDue").focus(); try { $("compDue").showPicker && $("compDue").showPicker(); } catch (e) {}
        return;
      }
      compDue = val; $("dtRow").hidden = true; renderDue();
    };
    row.append(b);
  });
  if (compDue && !matched) { $("dtRow").hidden = false; $("compDue").value = toLocalInput(compDue); }
  $("dueNote").textContent = compDue
    ? "Due " + relLower(compDue) + " at " + fmtTime(compDue) + (isNative && pref.get("remind", true) ? " · you'll get a reminder" : "")
    : "No due time. It stays under Anytime.";
}
$("compDue").addEventListener("change", () => { const v = $("compDue").value; compDue = v ? new Date(v).getTime() : null; renderDue(); });
function openComposer(id) {
  editId = id || null; delArmed = false;
  const t = id ? tasks.get(id) : null;
  $("compTitle").textContent = t ? "Edit job" : "New job";
  $("compSave").textContent = t ? "Save changes" : "Add job";
  $("compText").value = t ? t.title : "";
  compUrgent = !!(t && t.urgent); $("compUrgent").setAttribute("aria-pressed", compUrgent);
  compDue = t && t.due ? t.due : null; $("dtRow").hidden = true;
  $("compDelete").hidden = !t; $("compDelete").textContent = "Delete";
  renderDue(); openSheet("composer");
  setTimeout(() => { $("compText").focus(); const n = $("compText").value.length; $("compText").setSelectionRange(n, n); }, 320);
}
$("fab").onclick = () => openComposer(null);
$("compClose").onclick = closeSheet;
$("compUrgent").onclick = () => { compUrgent = !compUrgent; $("compUrgent").setAttribute("aria-pressed", compUrgent); buzz(); };
$("compText").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("compForm").requestSubmit(); } });
$("compForm").addEventListener("submit", e => {
  e.preventDefault();
  const title = $("compText").value.trim().replace(/\s+/g, " ");
  if (!title) { $("compText").focus(); return; }
  if (compDue) askNotifyPermission();
  if (editId) { const t = tasks.get(editId); if (t) put(editId, { ...t, title, urgent: compUrgent, due: compDue }); }
  else { put(newId(), { title, urgent: compUrgent, due: compDue, done: false, createdAt: Date.now(), doneAt: null }); tab = "todo"; render(); }
  buzz(); closeSheet();
});
$("compDelete").onclick = () => {
  if (!delArmed) { delArmed = true; $("compDelete").textContent = "Tap again to delete"; return; }
  const id = editId, copy = { ...tasks.get(id) };
  closeSheet(); remove(id); showToast("Job deleted", () => put(id, copy));
};

/* ---------- Done actions ---------- */
let actId = null, actArmed = false;
function openActions(id) {
  const t = tasks.get(id); if (!t) return;
  actId = id; actArmed = false;
  $("actTitle").textContent = t.title;
  $("actSub").textContent = "Done " + relLower(t.doneAt) + " at " + fmtTime(t.doneAt);
  $("actDelete").textContent = "Delete from log";
  openSheet("actions");
}
$("actUndo").onclick = () => { const t = tasks.get(actId); if (t) put(actId, { ...t, done: false, doneAt: null }); closeSheet(); showToast("Moved back to To do"); };
$("actDelete").onclick = () => {
  if (!actArmed) { actArmed = true; $("actDelete").textContent = "Tap again to delete"; return; }
  const id = actId, copy = { ...tasks.get(id) }; closeSheet(); remove(id); showToast("Deleted from log", () => put(id, copy));
};

/* ---------- Tabs, toast ---------- */
$("tabTodo").onclick = () => { tab = "todo"; render(); };
$("tabDone").onclick = () => { tab = "done"; render(); };
let undoFn = null, toastTimer = null;
function showToast(text, undo) {
  const t = $("toast"); $("toastText").textContent = text; undoFn = undo || null;
  $("toastUndo").hidden = !undo; t.hidden = true; void t.offsetWidth; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; undoFn = null; }, 4500);
}
$("toastUndo").onclick = () => { if (undoFn) undoFn(); undoFn = null; $("toast").hidden = true; buzz(); };
setInterval(render, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

boot();
