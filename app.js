"use strict";
/* ============================================================
   غَرْس — محرك صقل الشخصية (نسخة PWA مستقلة، بدون أي اعتماد خارجي)
   ============================================================ */

const STORAGE_KEY = "ghars-db-v1";

const TIER_META = {
  macro: { label: "صفة كبرى", sub: "معيار شهري", duration: 30, color: "#C9A24B" },
  meso:  { label: "صفة متوسطة", sub: "معيار أسبوعي", duration: 14, color: "#6B8F5A" },
  micro: { label: "صفة خفيفة", sub: "معيار متغيّر", duration: null, color: "#9CB98A" },
};
const DEFAULT_BRANCHES = ["أخلاق", "انضباط", "علاقات", "روحانيات", "صحة", "قيادة", "عطاء"];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function dayDiff(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const da = new Date(ay, am - 1, ad).getTime();
  const dbb = new Date(by, bm - 1, bd).getTime();
  return Math.round((dbb - da) / 86400000);
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function toBase64Utf8(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16))));
}
function fromBase64Utf8(b64) {
  return decodeURIComponent(atob(b64).split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
}
function formatDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function emptyDb() {
  return {
    traits: [],
    history: {},
    logs: {},
    slots: { macro: null, meso: [null, null], micro: [null, null] },
    tierUsed: { macro: [], meso: [], micro: [] },
    tierLap: { macro: 0, meso: 0, micro: 0 },
    cycle: 1,
    lastOpenDate: null,
    updatedAt: Date.now(),
  };
}

/* ---------- منطق الدورة والحساب (مطابق تماماً لنسخة الويب) ---------- */

function traitsOfTier(db, tier) { return db.traits.filter((t) => t.tier === tier); }

function commitmentScore(db, traitId) {
  const h = db.history[traitId];
  if (!h || h.totalDaysAssigned === 0) return 0.5;
  const rate = h.totalDaysCompleted / h.totalDaysAssigned;
  const avgRating = h.ratingCount ? h.ratingSum / h.ratingCount / 5 : 0.5;
  return 0.6 * rate + 0.4 * avgRating;
}

function pickNextTrait(db, tier) {
  const pool = traitsOfTier(db, tier).filter((t) => !(db.tierUsed[tier] || []).includes(t.id));
  if (pool.length === 0) return null;
  const lap = db.tierLap[tier] || 0;
  if (lap === 0) return [...pool].sort((a, b) => a.createdAt - b.createdAt)[0];
  return [...pool].sort((a, b) => {
    const sa = commitmentScore(db, a.id), sb = commitmentScore(db, b.id);
    if (sa !== sb) return sa - sb;
    return a.createdAt - b.createdAt;
  })[0];
}

function finalizeRun(db, slot) {
  const { traitId, startDate, duration } = slot;
  let completedCount = 0, ratingSum = 0, ratingCount = 0, lastDone = null;
  for (let i = 0; i < duration; i++) {
    const d = addDays(startDate, i);
    const entry = db.logs[d] && db.logs[d][traitId];
    if (entry && entry.done) { completedCount++; lastDone = d; }
    if (entry && entry.rating) { ratingSum += entry.rating; ratingCount++; }
  }
  const rate = completedCount / duration;
  const h = db.history[traitId] || {
    totalDaysAssigned: 0, totalDaysCompleted: 0, ratingSum: 0, ratingCount: 0,
    lastCompletedDate: null, masteredRuns: 0, timesRun: 0,
  };
  h.totalDaysAssigned += duration;
  h.totalDaysCompleted += completedCount;
  h.ratingSum += ratingSum;
  h.ratingCount += ratingCount;
  h.timesRun += 1;
  if (rate >= 0.7) h.masteredRuns += 1;
  if (lastDone) h.lastCompletedDate = lastDone;
  db.history[traitId] = h;
}

function markUsed(db, tier, traitId) {
  db.tierUsed[tier] = [...(db.tierUsed[tier] || []), traitId];
  const total = traitsOfTier(db, tier).length;
  if (total > 0 && db.tierUsed[tier].length >= total) {
    db.tierUsed[tier] = [];
    db.tierLap[tier] = (db.tierLap[tier] || 0) + 1;
    if (tier === "macro") {
      db.cycle += 1;
      db.tierUsed.meso = [];
      db.tierUsed.micro = [];
      db.tierLap.meso = (db.tierLap.meso || 0) + 1;
      db.tierLap.micro = (db.tierLap.micro || 0) + 1;
    }
  }
}

function processSlot(db, tier, today, getSlot, setSlot) {
  let slot = getSlot(db);
  if (slot) {
    const endExclusive = addDays(slot.startDate, slot.duration);
    if (dayDiff(endExclusive, today) <= 0) { finalizeRun(db, slot); slot = null; }
  }
  if (!slot) {
    const candidate = pickNextTrait(db, tier);
    if (candidate) {
      const duration = tier === "micro" ? Math.floor(Math.random() * 3) + 1 : TIER_META[tier].duration;
      slot = { traitId: candidate.id, startDate: today, duration };
      markUsed(db, tier, candidate.id);
    } else slot = null;
  }
  setSlot(db, slot);
}

function ensureDailySlots(dbIn) {
  const db = JSON.parse(JSON.stringify(dbIn));
  const today = todayStr();
  if (db.lastOpenDate === today) return db;
  processSlot(db, "macro", today, (d) => d.slots.macro, (d, s) => { d.slots.macro = s; });
  for (let i = 0; i < 2; i++) processSlot(db, "meso", today, (d) => d.slots.meso[i], (d, s) => { d.slots.meso[i] = s; });
  for (let i = 0; i < 2; i++) processSlot(db, "micro", today, (d) => d.slots.micro[i], (d, s) => { d.slots.micro[i] = s; });
  db.lastOpenDate = today;
  return db;
}

function liveCompletedCount(db, traitId) {
  const h = db.history[traitId];
  let base = h ? h.totalDaysCompleted : 0;
  const today = todayStr();
  const scanSlot = (slot) => {
    if (slot && slot.traitId === traitId) {
      let n = 0, d = slot.startDate;
      while (dayDiff(d, today) >= 0 && dayDiff(d, addDays(slot.startDate, slot.duration)) < 0) {
        const entry = db.logs[d] && db.logs[d][traitId];
        if (entry && entry.done) n++;
        d = addDays(d, 1);
      }
      base += n;
    }
  };
  scanSlot(db.slots.macro);
  db.slots.meso.forEach(scanSlot);
  db.slots.micro.forEach(scanSlot);
  return base;
}

function missedStreakFor(db, traitId, slot) {
  if (!slot || slot.traitId !== traitId) return 0;
  const today = todayStr();
  let missed = 0, d = today;
  while (dayDiff(d, slot.startDate) >= 0) {
    const entry = db.logs[d] && db.logs[d][traitId];
    if (entry && entry.done) break;
    missed++; d = addDays(d, -1);
  }
  return missed;
}

function traitStreak(db, traitId) {
  const today = todayStr();
  let streak = 0, d = today;
  for (let i = 0; i < 400; i++) {
    const entry = db.logs[d] && db.logs[d][traitId];
    if (entry && entry.done) { streak++; d = addDays(d, -1); } else break;
  }
  return streak;
}

function findTrait(db, id) { return db.traits.find((t) => t.id === id); }

function activeSlotsList(db) {
  const list = [];
  if (db.slots.macro) list.push({ tier: "macro", idx: 0, slot: db.slots.macro });
  db.slots.meso.forEach((s, i) => { if (s) list.push({ tier: "meso", idx: i, slot: s }); });
  db.slots.micro.forEach((s, i) => { if (s) list.push({ tier: "micro", idx: i, slot: s }); });
  return list;
}
function seededRand(seed) { let x = Math.sin(seed) * 10000; return x - Math.floor(x); }

/* ============================================================
   الحالة والتخزين
   ============================================================ */

let db = null;
let ui = { tab: "today", modal: null };
let syncConfig = { apiKey: "", binId: "", enabled: false };
let syncPushTimer = null;
let syncStatus = { busy: false, lastMsg: "" };

const SYNC_CONFIG_KEY = "ghars-sync-config-v1";
function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if (raw) return Object.assign({ apiKey: "", binId: "", enabled: false }, JSON.parse(raw));
  } catch (e) {}
  return { apiKey: "", binId: "", enabled: false };
}
function saveSyncConfig() {
  try { localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(syncConfig)); } catch (e) {}
}

function loadDb() {
  let loaded = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) loaded = JSON.parse(raw);
  } catch (e) { loaded = null; }
  return ensureDailySlots(loaded || emptyDb());
}
function saveDb() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch (e) {}
}
function mutate(fn) {
  fn(db);
  db.updatedAt = Date.now();
  saveDb();
  render();
  scheduleSyncPush();
}

/* -------- مزامنة تلقائية عبر jsonbin.io -------- */

const JSONBIN_BASE = "https://api.jsonbin.io/v3/b";

async function jsonbinCreate(apiKey, data) {
  const res = await fetch(JSONBIN_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Master-Key": apiKey, "X-Bin-Private": "true" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("create-failed");
  const json = await res.json();
  return json.metadata.id;
}
async function jsonbinRead(apiKey, binId) {
  const res = await fetch(`${JSONBIN_BASE}/${binId}/latest`, { headers: { "X-Master-Key": apiKey } });
  if (!res.ok) {
    const err = new Error("read-failed");
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.record;
}
async function jsonbinUpdate(apiKey, binId, data) {
  const res = await fetch(`${JSONBIN_BASE}/${binId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": apiKey },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = new Error("update-failed");
    err.status = res.status;
    throw err;
  }
}

function scheduleSyncPush() {
  if (!syncConfig.enabled || !syncConfig.apiKey || !syncConfig.binId) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(async () => {
    try { await jsonbinUpdate(syncConfig.apiKey, syncConfig.binId, db); }
    catch (e) { /* صامت: غالباً بلا إنترنت، سيُحاول لاحقاً عند أي تعديل جديد */ }
  }, 900);
}

async function pullAndMerge(showFeedback) {
  if (!syncConfig.enabled || !syncConfig.apiKey || !syncConfig.binId) {
    if (showFeedback) showToast("فعّل المزامنة أولاً");
    return;
  }
  try {
    const remote = await jsonbinRead(syncConfig.apiKey, syncConfig.binId);
    if (remote && Array.isArray(remote.traits)) {
      const remoteTs = remote.updatedAt || 0;
      const localTs = db.updatedAt || 0;
      if (remoteTs > localTs) {
        db = ensureDailySlots(remote);
        saveDb();
        render();
        if (showFeedback) showToast("تم سحب أحدث نسخة");
      } else if (localTs > remoteTs) {
        await jsonbinUpdate(syncConfig.apiKey, syncConfig.binId, db);
        if (showFeedback) showToast("تم رفع بياناتك لتصبح الأحدث");
      } else if (showFeedback) {
        showToast("بياناتك محدّثة بالفعل");
      }
    }
  } catch (e) {
    if (showFeedback) {
      let msg = "تعذّرت المزامنة، تحقق من الإنترنت";
      if (e && e.status === 401) msg = "المفتاح غير صحيح (401) — انسخه من جديد من jsonbin.io";
      else if (e && e.status === 404) msg = "معرّف الصندوق غير موجود (404) — تأكد من نسخه بالكامل";
      showToast(msg);
    }
  }
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 1800);
}

/* ============================================================
   الإجراءات
   ============================================================ */

function addTrait(data) {
  mutate((d) => {
    d.traits.push({ id: uid(), createdAt: Date.now(), ...data });
    const fresh = ensureDailySlots(d);
    Object.assign(d, fresh);
  });
  showToast("أُضيفت الصفة إلى غرسك 🌱");
}
function updateTrait(id, data) {
  mutate((d) => { d.traits = d.traits.map((t) => (t.id === id ? { ...t, ...data } : t)); });
  showToast("تم تحديث الصفة");
}
function deleteTrait(id) {
  mutate((d) => {
    d.traits = d.traits.filter((t) => t.id !== id);
    delete d.history[id];
    if (d.slots.macro && d.slots.macro.traitId === id) d.slots.macro = null;
    d.slots.meso = d.slots.meso.map((s) => (s && s.traitId === id ? null : s));
    d.slots.micro = d.slots.micro.map((s) => (s && s.traitId === id ? null : s));
    Object.keys(d.tierUsed).forEach((tier) => { d.tierUsed[tier] = d.tierUsed[tier].filter((x) => x !== id); });
  });
  showToast("حُذفت الصفة");
}
function toggleDone(traitId) {
  mutate((d) => {
    const today = todayStr();
    d.logs[today] = d.logs[today] || {};
    const entry = d.logs[today][traitId] || { done: false, rating: null, note: "" };
    entry.done = !entry.done;
    d.logs[today][traitId] = entry;
  });
}
function setRating(traitId, rating) {
  mutate((d) => {
    const today = todayStr();
    d.logs[today] = d.logs[today] || {};
    const entry = d.logs[today][traitId] || { done: false, rating: null, note: "" };
    entry.rating = entry.rating === rating ? null : rating;
    d.logs[today][traitId] = entry;
  });
}
function setNoteVal(traitId, note) {
  db.logs[todayStr()] = db.logs[todayStr()] || {};
  const entry = db.logs[todayStr()][traitId] || { done: false, rating: null, note: "" };
  entry.note = note;
  db.logs[todayStr()][traitId] = entry;
  db.updatedAt = Date.now();
  saveDb();
}

/* -------- نقل البيانات بين الأجهزة (تصدير/استيراد يدوي) -------- */

function exportCode() {
  return toBase64Utf8(JSON.stringify(db));
}
function importCode(code) {
  const json = fromBase64Utf8(code.trim());
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.traits)) throw new Error("invalid");
  db = ensureDailySlots(parsed);
  db.updatedAt = Date.now();
  saveDb();
}

/* ============================================================
   العرض (Rendering)
   ============================================================ */

function render() {
  document.getElementById("header").innerHTML = renderHeader();
  document.getElementById("content").innerHTML = renderTab();
  document.getElementById("nav").innerHTML = renderNav();
  document.getElementById("modal-root").innerHTML = renderModal();
  attachListeners();
}

function renderHeader() {
  const lap = db.cycle;
  const mode = lap <= 1 ? "البذر والإنبات" : "التثبيت والتجميع الذكي";
  return `
    <div class="ghars-header-top">
      <div class="ghars-brand">${sproutSvg(20)}<span>غَرْس</span></div>
      <div style="display:flex;align-items:center;gap:8px">
        <button class="ghars-icon-btn" data-action="open-sync" aria-label="نقل البيانات بين الأجهزة">${iconSync(15)}</button>
        <div class="ghars-cycle-badge">الدورة ${lap}</div>
      </div>
    </div>
    <div class="ghars-header-sub">${mode} · ${db.traits.length}/100 صفة مغروسة</div>
  `;
}

function renderNav() {
  const items = [
    { id: "today", label: "اليوم", icon: iconListChecks },
    { id: "tree", label: "الشجرة", icon: iconTree },
    { id: "traits", label: "الصفات", icon: iconSprout },
    { id: "museum", label: "المتحف", icon: iconTrophy },
  ];
  return items.map((it) => `
    <button class="ghars-nav-btn ${ui.tab === it.id ? "active" : ""}" data-tab="${it.id}">
      ${it.icon(19)}<span>${it.label}</span>
    </button>
  `).join("");
}

function renderTab() {
  if (ui.tab === "today") return renderToday();
  if (ui.tab === "tree") return renderTree();
  if (ui.tab === "traits") return renderTraits();
  if (ui.tab === "museum") return renderMuseum();
  return "";
}

function renderToday() {
  const todayLog = db.logs[todayStr()] || {};
  const sections = [
    { tier: "macro", slots: [db.slots.macro] },
    { tier: "meso", slots: db.slots.meso },
    { tier: "micro", slots: db.slots.micro },
  ];
  let html = `<div class="ghars-scroll">`;
  if (db.traits.length === 0) {
    html += emptyState("أرضك جاهزة، لكنها بلا بذور بعد", "أضف أول صفة من كتابك أو قدوتك لتبدأ الرحلة.", "أضف صفة الآن", "go-traits");
  }
  sections.forEach((sec) => {
    const meta = TIER_META[sec.tier];
    html += `<div class="ghars-section">
      <div class="ghars-section-title"><span style="color:${meta.color}">${meta.label}</span><span class="ghars-section-sub">${meta.sub}</span></div>
      <div class="ghars-cards">`;
    sec.slots.forEach((slot, idx) => {
      if (!slot) {
        if (traitsOfTier(db, sec.tier).length === 0) {
          html += `<button class="ghars-card ghars-card-placeholder" data-action="go-traits">${iconPlus(18)}<span>أضف ${meta.label} لتظهر هنا</span></button>`;
        }
        return;
      }
      const trait = findTrait(db, slot.traitId);
      if (!trait) return;
      const entry = todayLog[slot.traitId] || { done: false };
      const dayNum = Math.min(dayDiff(slot.startDate, todayStr()) + 1, slot.duration);
      const missed = missedStreakFor(db, slot.traitId, slot);
      html += `
        <div class="ghars-card ${entry.done ? "done" : ""} ${missed >= 2 ? "wilting" : ""}" style="--tier-color:${meta.color}">
          <button class="ghars-card-check" data-action="toggle" data-id="${trait.id}">${entry.done ? iconCheck(16) : ""}</button>
          <div class="ghars-card-body" data-action="open-detail" data-tier="${sec.tier}" data-idx="${idx}">
            <div class="ghars-card-name">${escapeHtml(trait.name)}</div>
            <div class="ghars-card-meta">
              <span class="ghars-chip">${escapeHtml(trait.branch)}</span>
              <span class="ghars-day-count">يوم ${dayNum} / ${slot.duration}</span>
            </div>
            <div class="ghars-card-task">${escapeHtml(trait.task)}</div>
          </div>
          ${iconChevron()}
        </div>`;
    });
    html += `</div></div>`;
  });
  html += `</div>`;
  return html;
}

function emptyState(title, desc, actionLabel, actionId) {
  return `<div class="ghars-empty">${sproutSvg(32)}
    <div class="ghars-empty-title">${title}</div>
    <div class="ghars-empty-desc">${desc}</div>
    ${actionLabel ? `<button class="ghars-btn-primary" data-action="${actionId}">${actionLabel}</button>` : ""}
  </div>`;
}

function renderTree() {
  const set = new Set(DEFAULT_BRANCHES);
  db.traits.forEach((t) => set.add(t.branch));
  let branches = Array.from(set).filter((b) => db.traits.some((t) => t.branch === b));
  if (branches.length === 0) branches = DEFAULT_BRANCHES.slice(0, 3);

  const branchStats = branches.map((branch) => {
    const traitIds = db.traits.filter((t) => t.branch === branch).map((t) => t.id);
    const leaves = traitIds.reduce((sum, id) => sum + liveCompletedCount(db, id), 0);
    const fruits = traitIds.reduce((sum, id) => sum + (db.history[id]?.masteredRuns || 0), 0);
    const active = activeSlotsList(db).filter((a) => traitIds.includes(a.slot.traitId));
    const wilting = active.some((a) => missedStreakFor(db, a.slot.traitId, a.slot) >= 2);
    return { branch, leaves, fruits, wilting };
  }).filter((b) => b.leaves > 0 || b.fruits > 0 || db.traits.some((t) => t.branch === b.branch));

  const totalCheckins = Object.values(db.logs).reduce((sum, day) => sum + Object.values(day).filter((e) => e.done).length, 0);
  const totalFruits = branchStats.reduce((s, b) => s + b.fruits, 0);
  const rings = Math.max(0, db.cycle - 1);

  return `
    <div class="ghars-scroll">
      <div class="ghars-tree-canvas">${treeSvg(branchStats, rings)}</div>
      <div class="ghars-tree-stats">
        <div class="ghars-stat"><div class="n">${totalCheckins}</div><div class="l">إنجاز يومي</div></div>
        <div class="ghars-stat"><div class="n">${totalFruits}</div><div class="l">صفة مُتقنة</div></div>
        <div class="ghars-stat"><div class="n">${rings}</div><div class="l">حلقة نمو</div></div>
      </div>
      <div class="ghars-section-title" style="margin-top:8px"><span>فروع الشخصية</span></div>
      <div class="ghars-branch-list">
        ${branchStats.map((b) => `
          <div class="ghars-branch-row">
            <span class="ghars-branch-dot ${b.wilting ? "wilt" : ""}"></span>
            <span class="ghars-branch-name">${escapeHtml(b.branch)}</span>
            <span class="ghars-branch-leaves">${iconLeaf(13)} ${b.leaves}</span>
            <span class="ghars-branch-fruits">🍊 ${b.fruits}</span>
          </div>`).join("")}
        ${branchStats.length === 0 ? `<div class="ghars-empty-desc" style="padding:8px 4px">ابدأ بإضافة صفات وتفعيلها لترى الفروع تنمو.</div>` : ""}
      </div>
    </div>`;
}

function treeSvg(branchStats, rings) {
  const W = 340, H = 300, trunkTopY = 150, canopyCenterY = 110;
  const n = Math.max(branchStats.length, 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="260" style="overflow:visible">
    <defs><radialGradient id="canopyGlow" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#3a5a34" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#3a5a34" stop-opacity="0"/>
    </radialGradient></defs>
    <ellipse cx="${W/2}" cy="${canopyCenterY}" rx="140" ry="95" fill="url(#canopyGlow)"/>
    <ellipse cx="${W/2}" cy="272" rx="100" ry="10" fill="#0e1712" opacity="0.5"/>
    <path d="M ${W/2-14} 272 C ${W/2-16} 230, ${W/2-10} 190, ${W/2-8} ${trunkTopY} L ${W/2+8} ${trunkTopY} C ${W/2+10} 190, ${W/2+16} 230, ${W/2+14} 272 Z" fill="#4a3423" stroke="#2c2013" stroke-width="1.5"/>`;
  for (let i = 0; i < Math.min(rings, 8); i++) {
    s += `<ellipse cx="${W/2}" cy="${266 - i*16}" rx="${13 - i*0.6}" ry="3.2" fill="none" stroke="#C9A24B" stroke-opacity="0.55" stroke-width="1.3"/>`;
  }
  branchStats.forEach((b, i) => {
    const angle = (Math.PI / (n + 1)) * (i + 1);
    const bx = W/2 + Math.cos(Math.PI - angle) * 105;
    const by = canopyCenterY + 55 - Math.sin(angle) * 70;
    const leafCount = Math.min(Math.max(Math.round(b.leaves / 2), b.leaves > 0 ? 3 : 0), 22);
    const baseColor = b.wilting ? "#9c8a4e" : "#5f8a4f";
    s += `<line x1="${W/2}" y1="${trunkTopY-5}" x2="${bx}" y2="${by}" stroke="#4a3423" stroke-width="4" stroke-linecap="round"/>`;
    for (let li = 0; li < leafCount; li++) {
      const r1 = seededRand(i * 97 + li * 13.7), r2 = seededRand(i * 233 + li * 5.1 + 1);
      const lx = bx + (r1 - 0.5) * 70, ly = by + (r2 - 0.5) * 55 - 10;
      const size = 6 + seededRand(i * 31 + li) * 5;
      s += `<ellipse cx="${lx}" cy="${ly}" rx="${size}" ry="${size*0.62}" fill="${baseColor}" opacity="0.85" transform="rotate(${Math.round(r1*360)} ${lx} ${ly})"/>`;
    }
    for (let fi = 0; fi < Math.min(b.fruits, 8); fi++) {
      const r1 = seededRand(i * 400 + fi * 17.3 + 3), r2 = seededRand(i * 500 + fi * 9.1 + 4);
      const fx = bx + (r1 - 0.5) * 60, fy = by + (r2 - 0.5) * 45;
      s += `<circle cx="${fx}" cy="${fy}" r="5.5" fill="#C9782E" stroke="#7a3d10" stroke-width="0.6"/>`;
    }
  });
  s += `</svg>`;
  return s;
}

function renderTraits() {
  const filter = ui.traitFilter || "all";
  const list = db.traits.filter((t) => filter === "all" || t.tier === filter).sort((a, b) => b.createdAt - a.createdAt);
  return `
    <div class="ghars-scroll">
      <div class="ghars-traits-topbar">
        <div class="ghars-progress-track"><div class="ghars-progress-fill" style="width:${Math.min(100, db.traits.length)}%"></div></div>
        <div class="ghars-progress-label">${db.traits.length} / 100 صفة</div>
      </div>
      <div class="ghars-filter-row">
        ${["all", "macro", "meso", "micro"].map((f) => `
          <button class="ghars-filter-chip ${filter === f ? "active" : ""}" data-action="filter" data-filter="${f}">
            ${f === "all" ? "الكل" : TIER_META[f].label}
          </button>`).join("")}
      </div>
      <button class="ghars-btn-primary ghars-add-btn" data-action="new-trait">${iconPlus(16)} أضف صفة جديدة</button>
      <div class="ghars-traits-list">
        ${list.map((t) => `
          <div class="ghars-trait-row">
            <span class="ghars-tier-dot" style="background:${TIER_META[t.tier].color}"></span>
            <div class="ghars-trait-info">
              <div class="ghars-trait-name">${escapeHtml(t.name)}</div>
              <div class="ghars-trait-sub">${escapeHtml(t.branch)} · ${TIER_META[t.tier].label}</div>
            </div>
            <button class="ghars-icon-btn" data-action="edit-trait" data-id="${t.id}">${iconPencil(14)}</button>
            <button class="ghars-icon-btn danger" data-action="delete-trait" data-id="${t.id}">${iconTrash(14)}</button>
          </div>`).join("")}
        ${list.length === 0 ? `<div class="ghars-empty-desc" style="padding:20px 4px">لا توجد صفات هنا بعد.</div>` : ""}
      </div>
    </div>`;
}

function renderMuseum() {
  const mastered = db.traits.filter((t) => (db.history[t.id]?.masteredRuns || 0) > 0);
  let html = `<div class="ghars-scroll">`;
  if (mastered.length === 0) html += emptyState("المتحف فارغ حتى الآن", "أول صفة تُتقنها بثبات ستظهر هنا كثمرة.", null, null);
  html += `<div class="ghars-museum-grid">`;
  mastered.forEach((t) => {
    const h = db.history[t.id];
    html += `<div class="ghars-museum-card">
      <div class="ghars-museum-fruit">🍊</div>
      <div class="ghars-museum-name">${escapeHtml(t.name)}</div>
      <div class="ghars-museum-branch">${escapeHtml(t.branch)}</div>
      <div class="ghars-museum-count">أُتقنت ${h.masteredRuns} ${h.masteredRuns === 1 ? "مرة" : "مرات"}</div>
    </div>`;
  });
  html += `</div></div>`;
  return html;
}

/* -------- النوافذ (Modals) -------- */

function renderModal() {
  if (!ui.modal) return "";
  if (ui.modal.type === "detail") return renderDetailModal(ui.modal);
  if (ui.modal.type === "form") return renderFormModal(ui.modal);
  if (ui.modal.type === "sync") return renderSyncModal();
  return "";
}

function renderDetailModal(modal) {
  const slot = modal.tier === "macro" ? db.slots.macro : db.slots[modal.tier][modal.idx];
  if (!slot) return "";
  const trait = findTrait(db, slot.traitId);
  if (!trait) return "";
  const todayLog = db.logs[todayStr()] || {};
  const entry = todayLog[slot.traitId] || { done: false, rating: null, note: "" };
  const dayNum = Math.min(dayDiff(slot.startDate, todayStr()) + 1, slot.duration);
  const streak = traitStreak(db, trait.id);
  return `
    <div class="ghars-modal-overlay" data-action="close-modal">
      <div class="ghars-modal ghars-page" data-stop="1">
        <button class="ghars-modal-close" data-action="close-modal">${iconX(18)}</button>
        <div class="ghars-modal-tier" style="color:${TIER_META[modal.tier].color}">${TIER_META[modal.tier].label} · يوم ${dayNum}/${slot.duration}</div>
        <h2 class="ghars-modal-title">${escapeHtml(trait.name)}</h2>
        <div class="ghars-modal-branch">${escapeHtml(trait.branch)}</div>
        <div class="ghars-quote-box">${iconBook(16)}<p>${escapeHtml(trait.quote) || "لم تُضف قصة بعد لهذه الصفة."}</p></div>
        <div class="ghars-task-box"><div class="ghars-task-label">التطبيق اليومي</div><p>${escapeHtml(trait.task)}</p></div>
        <button class="ghars-done-btn ${entry.done ? "done" : ""}" data-action="toggle" data-id="${trait.id}">
          ${entry.done ? iconCheck(18) + " تم إنجازها اليوم" : "علّم بأنّها أُنجزت اليوم"}
        </button>
        <div class="ghars-rate-row">
          <span>تقييم الالتزام اليوم</span>
          <div class="ghars-stars">
            ${[1,2,3,4,5].map((n) => `<button data-action="rate" data-id="${trait.id}" data-n="${n}">${iconStar(20, (entry.rating||0) >= n)}</button>`).join("")}
          </div>
        </div>
        <textarea class="ghars-note-input" id="note-input" placeholder="ملاحظة سريعة من سطر واحد…" rows="2">${escapeHtml(entry.note || "")}</textarea>
        ${streak >= 2 ? `<div class="ghars-streak-pill">${iconFlame(14)} ${streak} أيام متتالية</div>` : ""}
      </div>
    </div>`;
}

function renderFormModal(modal) {
  const t = modal.editing;
  const branches = Array.from(new Set([...DEFAULT_BRANCHES, ...db.traits.map((x) => x.branch)]));
  return `
    <div class="ghars-modal-overlay" data-action="close-modal">
      <div class="ghars-modal" data-stop="1">
        <button class="ghars-modal-close" data-action="close-modal">${iconX(18)}</button>
        <h2 class="ghars-modal-title" style="margin-bottom:14px">${t ? "تعديل صفة" : "صفة جديدة"}</h2>
        <label class="ghars-field-label">اسم الصفة</label>
        <input class="ghars-input" id="f-name" value="${t ? escapeHtml(t.name) : ""}" placeholder="مثال: الصبر"/>
        <label class="ghars-field-label">مستوى المدار</label>
        <div class="ghars-tier-picker" id="f-tier-picker">
          ${Object.keys(TIER_META).map((k) => `
            <button type="button" class="ghars-tier-pick ${((t ? t.tier : "micro") === k) ? "active" : ""}" data-tier="${k}" style="--tc:${TIER_META[k].color}">${TIER_META[k].label}</button>`).join("")}
        </div>
        <label class="ghars-field-label">فرع الشخصية (التصنيف)</label>
        <input class="ghars-input" id="f-branch" list="branch-options" value="${t ? escapeHtml(t.branch) : ""}" placeholder="مثال: انضباط"/>
        <datalist id="branch-options">${branches.map((b) => `<option value="${escapeHtml(b)}"></option>`).join("")}</datalist>
        <label class="ghars-field-label">اقتباس / موقف من الكتاب</label>
        <textarea class="ghars-input" id="f-quote" rows="3" placeholder="كيف مارس القدوة هذه الصفة؟">${t ? escapeHtml(t.quote) : ""}</textarea>
        <label class="ghars-field-label">التطبيق اليومي (المهمة المصغّرة)</label>
        <textarea class="ghars-input" id="f-task" rows="2" placeholder="فعل بسيط وقابل للقياس اليوم">${t ? escapeHtml(t.task) : ""}</textarea>
        <button class="ghars-btn-primary" id="f-save" style="margin-top:14px;width:100%">حفظ</button>
      </div>
    </div>`;
}

function renderSyncModal() {
  const code = exportCode();
  const cfg = syncConfig;
  return `
    <div class="ghars-modal-overlay" data-action="close-modal">
      <div class="ghars-modal" data-stop="1">
        <button class="ghars-modal-close" data-action="close-modal">${iconX(18)}</button>
        <h2 class="ghars-modal-title" style="margin-bottom:4px">المزامنة بين الأجهزة</h2>
        <div class="ghars-modal-branch" style="margin-bottom:16px">آخر تحديث على هذا الجهاز: ${formatDateTime(db.updatedAt)}</div>

        <div class="ghars-sync-status ${cfg.enabled ? "on" : ""}">${cfg.enabled ? "المزامنة التلقائية مُفعّلة ✅" : "المزامنة التلقائية غير مفعّلة"}</div>

        <div class="ghars-field-label" style="margin-top:14px">مفتاح API (X-Master-Key) من jsonbin.io</div>
        <input class="ghars-input" id="sync-apikey" value="${escapeHtml(cfg.apiKey)}" placeholder="الصق المفتاح هنا">

        <div class="ghars-field-label">معرّف الصندوق (Bin ID)</div>
        <input class="ghars-input" id="sync-binid" value="${escapeHtml(cfg.binId)}" placeholder="سيُملأ تلقائياً عند الإنشاء، أو الصقه إن أنشأته على جهاز آخر">

        <div style="display:flex; gap:8px; margin-top:10px">
          <button class="ghars-btn-primary" id="sync-create-btn" style="flex:1">إنشاء صندوق جديد</button>
          <button class="ghars-btn-primary" id="sync-activate-btn" style="flex:1; background:linear-gradient(135deg,#C9A24B,#a9863d)">تفعيل ومزامنة الآن</button>
        </div>
        <button class="ghars-btn-outline" id="sync-now-btn" style="width:100%;margin-top:8px">مزامنة الآن يدوياً</button>
        <div class="ghars-empty-desc" style="text-align:right;max-width:none;margin-top:8px">
          أنشئ حساباً مجانياً على jsonbin.io وانسخ مفتاح API من صفحة API Keys، الصقه هنا واضغط "إنشاء صندوق جديد" مرة واحدة على أول جهاز. ثم انسخ نفس المفتاح ومعرّف الصندوق إلى بقية أجهزتك واضغط "تفعيل ومزامنة الآن".
        </div>

        <div style="height:1px;background:rgba(237,230,211,0.1);margin:20px 0"></div>

        <div class="ghars-field-label" style="margin-top:0">بديل بلا إنترنت: نسخ يدوي</div>
        <textarea class="ghars-input ghars-code-box" id="sync-export" rows="3" readonly>${code}</textarea>
        <button class="ghars-btn-outline" id="sync-copy-btn" style="width:100%;margin-top:8px">${iconCopy(15)} نسخ الكود</button>
        <textarea class="ghars-input ghars-code-box" id="sync-import" rows="3" placeholder="أو الصق كوداً هنا لاستيراده…" style="margin-top:10px"></textarea>
        <button class="ghars-btn-warn" id="sync-import-btn" style="width:100%;margin-top:8px">استيراد الآن (سيستبدل بيانات هذا الجهاز)</button>
      </div>
    </div>`;
}

/* ============================================================
   الأيقونات (SVG مضمّنة، بلا اعتماد خارجي)
   ============================================================ */
function icon(paths, size, extra="") { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`; }
function sproutSvg(size){ return icon(`<path d="M7 20h10"/><path d="M12 20V10"/><path d="M12 10C12 6 9 4 5 4c0 4 2 7 7 6z"/><path d="M12 10c0-4 3-6 7-6 0 4-2 7-7 6z"/>`, size); }
function iconListChecks(size){ return icon(`<path d="M3 6l2 2 3-3"/><path d="M3 13l2 2 3-3"/><path d="M11 6h10"/><path d="M11 13h10"/><path d="M11 20h10"/><path d="M3 20l2 2 3-3"/>`, size); }
function iconTree(size){ return icon(`<path d="M12 22v-6"/><path d="M8 15l4 -3 4 3"/><path d="M6 11l6 -6 6 6"/><path d="M8 6l4 -4 4 4"/>`, size); }
function iconSprout(size){ return sproutSvg(size); }
function iconTrophy(size){ return icon(`<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 5H4a2 2 0 0 0 0 4h1"/><path d="M17 5h3a2 2 0 0 1 0 4h-1"/>`, size); }
function iconPlus(size){ return icon(`<path d="M12 5v14M5 12h14"/>`, size); }
function iconCheck(size){ return icon(`<path d="M20 6L9 17l-5-5"/>`, size); }
function iconChevron(){ return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:.35;flex-shrink:0"><path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function iconX(size){ return icon(`<path d="M18 6L6 18M6 6l12 12"/>`, size); }
function iconBook(size){ return icon(`<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5"/><path d="M4 4.5v16A2.5 2.5 0 0 0 6.5 23H20"/>`, size, 'style="opacity:.6;flex-shrink:0;margin-top:2px"'); }
function iconStar(size, filled){ return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? "#C9A24B" : "none"}" stroke="${filled ? "#C9A24B" : "#8a927e"}" stroke-width="1.8"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`; }
function iconFlame(size){ return icon(`<path d="M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-1-1-2-1-2s3 2 3 6a5 5 0 0 1-10 0c0-5 3-6 5-13z"/>`, size); }
function iconLeaf(size){ return icon(`<path d="M11 20A7 7 0 0 1 4 13c0-4 3-9 10-9 0 7-3 10-9 10z"/><path d="M4 20l7-7"/>`, size); }
function iconPencil(size){ return icon(`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>`, size); }
function iconTrash(size){ return icon(`<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>`, size); }
function iconSync(size){ return icon(`<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>`, size); }
function iconCopy(size){ return icon(`<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`, size); }

/* ============================================================
   ربط الأحداث
   ============================================================ */

function attachListeners() {
  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => { ui.tab = el.getAttribute("data-tab"); render(); });
  });
  document.querySelectorAll('[data-action="go-traits"]').forEach((el) => {
    el.addEventListener("click", () => { ui.tab = "traits"; render(); });
  });
  document.querySelectorAll('[data-action="open-sync"]').forEach((el) => {
    el.addEventListener("click", () => { ui.modal = { type: "sync" }; render(); });
  });
  document.querySelectorAll('[data-action="toggle"]').forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); toggleDone(el.getAttribute("data-id")); });
  });
  document.querySelectorAll('[data-action="open-detail"]').forEach((el) => {
    el.addEventListener("click", () => {
      ui.modal = { type: "detail", tier: el.getAttribute("data-tier"), idx: Number(el.getAttribute("data-idx")) };
      render();
    });
  });
  document.querySelectorAll('[data-action="filter"]').forEach((el) => {
    el.addEventListener("click", () => { ui.traitFilter = el.getAttribute("data-filter"); render(); });
  });
  document.querySelectorAll('[data-action="new-trait"]').forEach((el) => {
    el.addEventListener("click", () => { ui.modal = { type: "form", editing: null, tier: "micro" }; render(); });
  });
  document.querySelectorAll('[data-action="edit-trait"]').forEach((el) => {
    el.addEventListener("click", () => {
      const t = findTrait(db, el.getAttribute("data-id"));
      ui.modal = { type: "form", editing: t };
      render();
    });
  });
  document.querySelectorAll('[data-action="delete-trait"]').forEach((el) => {
    el.addEventListener("click", () => { deleteTrait(el.getAttribute("data-id")); });
  });
  document.querySelectorAll('[data-action="close-modal"]').forEach((el) => {
    el.addEventListener("click", () => { ui.modal = null; render(); });
  });
  document.querySelectorAll('[data-stop]').forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
  });
  document.querySelectorAll('[data-action="rate"]').forEach((el) => {
    el.addEventListener("click", () => setRating(el.getAttribute("data-id"), Number(el.getAttribute("data-n"))));
  });

  const noteInput = document.getElementById("note-input");
  if (noteInput && ui.modal && ui.modal.type === "detail") {
    const slot = ui.modal.tier === "macro" ? db.slots.macro : db.slots[ui.modal.tier][ui.modal.idx];
    if (slot) noteInput.addEventListener("input", (e) => setNoteVal(slot.traitId, e.target.value));
  }

  const tierPicker = document.getElementById("f-tier-picker");
  if (tierPicker) {
    tierPicker.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        tierPicker.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        tierPicker.dataset.selected = btn.getAttribute("data-tier");
      });
    });
    if (!tierPicker.dataset.selected) {
      const active = tierPicker.querySelector(".active");
      tierPicker.dataset.selected = active ? active.getAttribute("data-tier") : "micro";
    }
  }

  const syncCreateBtn = document.getElementById("sync-create-btn");
  if (syncCreateBtn) {
    syncCreateBtn.addEventListener("click", async () => {
      const apiKey = document.getElementById("sync-apikey").value.trim();
      if (!apiKey) { showToast("الصق مفتاح API أولاً"); return; }
      syncCreateBtn.textContent = "جارٍ الإنشاء…";
      try {
        const binId = await jsonbinCreate(apiKey, db);
        syncConfig = { apiKey, binId, enabled: true };
        saveSyncConfig();
        ui.modal = { type: "sync" };
        render();
        showToast("تم إنشاء الصندوق وتفعيل المزامنة");
      } catch (e) {
        showToast("تعذّر الإنشاء، تحقق من المفتاح والإنترنت");
        syncCreateBtn.textContent = "إنشاء صندوق جديد";
      }
    });
  }
  const syncActivateBtn = document.getElementById("sync-activate-btn");
  if (syncActivateBtn) {
    syncActivateBtn.addEventListener("click", async () => {
      const apiKey = document.getElementById("sync-apikey").value.trim();
      const binId = document.getElementById("sync-binid").value.trim();
      if (!apiKey || !binId) { showToast("أدخل المفتاح ومعرّف الصندوق معاً"); return; }
      syncConfig = { apiKey, binId, enabled: true };
      saveSyncConfig();
      await pullAndMerge(true);
      ui.modal = { type: "sync" };
      render();
    });
  }
  const syncNowBtn = document.getElementById("sync-now-btn");
  if (syncNowBtn) {
    syncNowBtn.addEventListener("click", async () => {
      await pullAndMerge(true);
      ui.modal = { type: "sync" };
      render();
    });
  }

  const syncCopyBtn = document.getElementById("sync-copy-btn");
  if (syncCopyBtn) {
    syncCopyBtn.addEventListener("click", async () => {
      const ta = document.getElementById("sync-export");
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch (e) {
        ta.removeAttribute("readonly");
        ta.select();
        try { document.execCommand("copy"); } catch (e2) {}
        ta.setAttribute("readonly", "readonly");
      }
      showToast("تم نسخ الكود");
    });
  }
  const syncImportBtn = document.getElementById("sync-import-btn");
  if (syncImportBtn) {
    syncImportBtn.addEventListener("click", () => {
      const val = document.getElementById("sync-import").value.trim();
      if (!val) { showToast("الصق الكود أولاً"); return; }
      const ok = window.confirm("سيتم استبدال كل بيانات هذا الجهاز بالكود الملصق. هل أنت متأكد؟");
      if (!ok) return;
      try {
        importCode(val);
        ui.modal = null;
        render();
        showToast("تم استيراد البيانات بنجاح");
      } catch (e) {
        showToast("الكود غير صالح، تأكد من نسخه كاملاً");
      }
    });
  }

  const saveBtn = document.getElementById("f-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const name = document.getElementById("f-name").value.trim();
      const branch = document.getElementById("f-branch").value.trim();
      const quote = document.getElementById("f-quote").value.trim();
      const task = document.getElementById("f-task").value.trim();
      const tier = tierPicker ? (tierPicker.dataset.selected || "micro") : "micro";
      if (!name || !branch || !task) { showToast("أكمل الاسم والفرع والمهمة اليومية على الأقل"); return; }
      const editing = ui.modal.editing;
      if (editing) updateTrait(editing.id, { name, tier, branch, quote, task });
      else addTrait({ name, tier, branch, quote, task });
      ui.modal = null;
      render();
    });
  }
}

/* ============================================================
   الإقلاع
   ============================================================ */

function boot() {
  db = loadDb();
  saveDb();
  syncConfig = loadSyncConfig();
  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
  if (syncConfig.enabled) {
    pullAndMerge(false);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && syncConfig.enabled) pullAndMerge(false);
  });
  window.addEventListener("focus", () => { if (syncConfig.enabled) pullAndMerge(false); });
}
document.addEventListener("DOMContentLoaded", boot);
