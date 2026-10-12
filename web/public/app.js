"use strict";
/* ============================================================
 * Howl 外观工坊前端 —— 复刻 zscsgo.com/skins 的信息架构:
 *   武器平铺卡网格(双队/TR/CT 自动拆分合并) → 居中大弹层
 *   (左 360 竖排子标签 + 内联属性块,右滑出翼钻取选择)
 *   自动保存(乐观更新 + 防抖写库,游戏内秒级生效);数据版本轮询热更新。
 * ============================================================ */
const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let LOCAL = true;
let CDN = "https://community.akamai.steamstatic.com/economy/image/";
function imgUrl(file, url) {
  if (LOCAL && file) return "/img/" + file;
  return url || "";
}
const RAR_ORDER = ["common", "uncommon", "rare", "mythical", "legendary", "ancient", "contraband"];
const CATLABEL = { rifles: "步枪", snipers: "狙击步枪", pistols: "手枪", smgs: "微型冲锋枪", heavy: "重型武器", knife: "匕首", glove: "手套" };

let ME = null, CAT = null, KEYCH = [];
/* 参考站 lucide 图标同款线条(内联 SVG) */
const ICONS = {
  swords: '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6 3 3-6 6z"/><path d="M16 16l4-4"/><path d="M19 13l-3-3"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 000 20c1.1 0 2-.9 2-2v-1c0-1.1.9-2 2-2h1a4 4 0 004-4 10 10 0 00-9-9z"/>',
  stamp: '<path d="M5 22h14"/><path d="M19 9l1.5-1.5a2.1 2.1 0 000-3L19 2l-9.5 9.5V15a2 2 0 01-2 2H5a2 2 0 01-2-2v-2.5a2 2 0 01.6-1.4L9 2"/>',
  paperclip: '<path d="M21.4 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.2-9.19a4 4 0 015.65 5.66l-9.2 9.19a2 2 0 01-2.82-2.83l8.49-8.48"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.8 2.8-2.5-.5-.5-2.5z"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.9l7.6-4.4M8.2 13.1l7.6 4.4"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
};
const svg = (name, cls) => '<svg class="' + (cls || "ic") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || "") + "</svg>";
const STKU = new Map();   // def → CDN url(贴纸接口回包时登记,卡片预览兜底用)
const S = {
  steam: null, meta: null, editPlan: null, bagMode: null, srvTimer: null,   // editPlan=编辑中的背包;bagMode=二级详情页背包
  rows: new Map(),       // key = s|t|a → v
  dirtySet: new Map(), dirtyDel: new Map(),
  edit: null,                          // {item, side:'both'|'ct'|'t'}
  q: "", dataVer: null,
};

async function api(p, o) {
  o = o || {};
  const r = await fetch(p, {
    method: o.method || "GET", headers: { "content-type": "application/json" },
    body: o.body ? JSON.stringify(o.body) : undefined, credentials: "same-origin",
  }).catch(() => null);
  if (!r) return { ok: false, error: "net" };
  const j = await r.json().catch(() => ({ ok: false, error: "net" }));
  if (r.status === 401 && !/^\/api\/(login|register)$/.test(p)) { ME = null; nav(); }
  return j;
}
const ERRMAP = {
  bad_username: "用户名需 3-32 位", bad_password: "密码至少 8 位", username_taken: "用户名已存在",
  bad_credentials: "用户名或密码错误", code_invalid: "绑定码无效或已过期", steam_taken: "该 SteamID 已绑定其他账号",
  forbidden: "没有权限", unauthorized: "请先登录", bad_steam: "SteamID 格式错误", too_many: "太频繁,稍后再试",
  server_error: "服务器错误", net: "网络错误", catalog_not_ready: "目录未就绪",
};
const t = k => ERRMAP[k] || k;
let toastTimer = null;
function toast(msg, cls) {
  const el = $("#toast"); el.textContent = msg; el.className = "toast show " + (cls || "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast " + (cls || ""); }, 2400);
}
const hash = () => (location.hash || "#/skins").replace(/^#\//, "").split("?")[0];
const isAdm = r => r === "admin" || r === "superadmin";
const isSuper = r => r === "superadmin";
function refreshNav() {
  $("#logout").classList.toggle("hidden", !ME);
  $("#navAdmin").classList.toggle("hidden", !ME || !isAdm(ME.role));
  $("#who").textContent = ME ? ME.username + (isSuper(ME.role) ? " · 最高管理员" : isAdm(ME.role) ? " · 管理员" : "") : "";
  const h = hash();
  $$("#nav a").forEach(a => a.classList.toggle("on", a.dataset.v === h));
}
const mount = id => { const v = $("#view"); v.innerHTML = ""; v.appendChild($("#" + id).content.cloneNode(true)); };
function nav() {
  if (S.srvTimer) { clearInterval(S.srvTimer); S.srvTimer = null; }
  const h = hash();
  if (!ME) return loginView();
  if (h === "me") return meView();
  if (h === "servers") return serversView();
  if (h === "admin" && isAdm(ME.role)) return adminView();
  return skinsView();
}
window.addEventListener("hashchange", nav);
function imgWire(root) {
  $$("img[data-n]", root || document).forEach(im => {
    if (im.dataset.wired) return;
    im.dataset.wired = "1";
    im.addEventListener("load", () => { im.classList.add("loaded"); const sk = im.parentElement && im.parentElement.querySelector(".skel"); if (sk) sk.remove(); });
    im.addEventListener("error", () => {
      if (!im.dataset.f && im.dataset.c) { im.dataset.f = "1"; im.src = im.dataset.c; return; }
      im.style.visibility = "hidden";
      const sk = im.parentElement && im.parentElement.querySelector(".skel"); if (sk) sk.remove();
    });
  });
}
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

/* ---------- 登录 / 账号(与 astra-web 同逻辑) ---------- */
function loginView() {
  mount("t-login");
  const swap = reg => { $("#fLogin").classList.toggle("hidden", reg); $("#fReg").classList.toggle("hidden", !reg); };
  $("#tabLogin").onclick = () => swap(false);
  $("#tabReg").onclick = () => swap(true);
  $("#fLogin").onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    const j = await api("/api/login", { method: "POST", body: { username: f.get("username"), password: f.get("password") } });
    if (j.ok) { await loadMe(); location.hash = "#/skins"; nav(); } else toast(t(j.error), "bad");
  };
  $("#fReg").onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    const j = await api("/api/register", { method: "POST", body: { username: f.get("username"), email: f.get("email") || null, password: f.get("password") } });
    if (j.ok) { await loadMe(); location.hash = "#/skins"; nav(); } else toast(t(j.error), "bad");
  };
}
async function loadMe() { const j = await api("/api/me"); ME = j.ok ? j : null; refreshNav(); }
function meView() {
  mount("t-me");
  const list = ME.steamids || [];
  $("#mySteam").innerHTML = list.length
    ? list.map(s => '<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)"><span class="grow" style="flex:1">' +
        esc(s.persona || "(无昵称)") + ' <span class="tag">' + esc(s.steamid64) + "</span></span>" +
        '<button class="mini danger" data-u="' + esc(s.steamid64) + '">解绑</button></div>').join("")
    : '<p class="hint">尚未绑定 SteamID:进服务器输入 <b>/howlbind</b> 获取绑定码。</p>';
  $$("#mySteam [data-u]").forEach(b => b.onclick = async () => {
    if (!confirm("确定解绑该 SteamID?")) return;
    const j = await api("/api/steam/" + b.dataset.u, { method: "DELETE" });
    if (j.ok) { toast("已解绑", "ok"); await loadMe(); meView(); } else toast(t(j.error), "bad");
  });
  $("#fBind").onsubmit = async e => {
    e.preventDefault();
    const code = String(new FormData(e.target).get("code") || "").toUpperCase().trim();
    const j = await api("/api/bind", { method: "POST", body: { code } });
    if (j.ok) { toast("绑定成功", "ok"); await loadMe(); meView(); } else toast(t(j.error), "bad");
  };
  $("#fPass").onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    if (f.get("nw") !== f.get("nw2")) return toast("两次新密码不一致", "bad");
    const j = await api("/api/password", { method: "POST", body: { oldPassword: f.get("old"), newPassword: f.get("nw") } });
    if (j.ok) { toast("密码已修改", "ok"); e.target.reset(); } else toast(t(j.error), "bad");
  };
}

/* ---------- 行式外观状态(与插件协议同构:s=side, t=sel_type, a=target, v=value) ---------- */
const key = (s, tt, a) => s + "|" + tt + "|" + a;
function getV(s, tt, a) {
  const k = key(s, tt, a);
  if (S.dirtyDel.has(k)) return null;
  if (S.dirtySet.has(k)) return S.dirtySet.get(k).v;
  return S.rows.has(k) ? S.rows.get(k) : null;
}
function putV(s, tt, a, v) {
  const k = key(s, tt, a);
  if (v == null || v === "") { S.dirtySet.delete(k); S.dirtyDel.set(k, { s, t: tt, a }); S.rows.delete(k); }
  else { S.dirtyDel.delete(k); S.rows.set(k, String(v)); S.dirtySet.set(k, { s, t: tt, a, v: String(v) }); }
  markDirty(); queueSave();
}
/* 读取"某武器在某边的生效值"(ct/t 覆盖 any) */
function effV(side, tt, a) { return getV(side, tt, a) != null ? getV(side, tt, a) : getV("any", tt, a); }
function markDirty() {
  const c = S.dirtySet.size + S.dirtyDel.size;
  const el = $("#fSave"); if (!el) return;
  if (!c) return;
  el.textContent = "● " + c + (isLivePlan() ? " 项待保存…" : " 项待存入背包…");
  el.style.color = "var(--gold)";
}
const curPlan = () => PLANS.find(p => p.id === (S.editPlan ?? (PLANS.find(p => p.inUse) || {}).id));
const isLivePlan = () => { const p = curPlan(); return !p || !!p.inUse; };
let saveSeq = 0;
const queueSave = debounce(async () => {
  const seq = ++saveSeq;
  const set = [...S.dirtySet.values()], del = [...S.dirtyDel.values()];
  if (!set.length && !del.length) return;
  $("#fSave").textContent = "保存中…";
  if (isLivePlan()) {
    const j = await api("/api/loadout/" + S.steam, { method: "POST", body: { set, del } });
    if (seq !== saveSeq) return;   // 背包已切换,丢弃过期批次
    if (j.ok) {
      S.dirtySet.clear(); S.dirtyDel.clear(); markDirty();
      $("#fSave").textContent = "已保存 · 游戏内约 3 秒生效";
      $("#fSave").style.color = "var(--ok)";
      const p = curPlan(); if (p) { p.rows = [...S.rows.entries()].map(([k, v]) => { const [s, t2, a2] = k.split("|"); return { s, t: t2, a: a2, v }; }); }
    } else { toast("保存失败:" + t(j.error), "bad"); $("#fSave").textContent = "保存失败,将自动重试"; }
    return;
  }
  /* 编辑非使用中背包:工作副本全量存回背包,不碰游戏 */
  const rows = [...S.rows.entries()].map(([k, v]) => { const [s, t2, a2] = k.split("|"); return { s, t: t2, a: a2, v }; });
  const j = await api("/api/plans/" + S.steam + "/save", { method: "POST", body: { id: (curPlan() || {}).id, rows } });
  if (seq !== saveSeq) return;    // 背包已切换,丢弃过期批次
  if (j.ok) {
    S.dirtySet.clear(); S.dirtyDel.clear(); markDirty();
    const p = curPlan(); if (p) p.rows = rows;
    $("#fSave").textContent = "已存入背包「" + ((p || {}).name || "") + "」(未应用到游戏)";
    $("#fSave").style.color = "var(--accText)";
  } else { toast("背包保存失败:" + t(j.error), "bad"); $("#fSave").textContent = "保存失败,将自动重试"; }
}, 800);
async function loadRows() {
  const j = await api("/api/loadout/" + S.steam);
  if (!j.ok) return toast(t(j.error), "bad");
  S.rows = new Map(j.rows.map(r => [key(r.s, r.t, r.a), r.v]));
  S.dirtySet.clear(); S.dirtyDel.clear(); markDirty();
}

/* ---------- 主视图:页头 + 服务器 + 背包 + 平铺武器网格 ---------- */
async function skinsView() {
  if (!CAT) {
    const c = await api("/api/catalog");
    if (!c.ok) return toast("目录加载失败:" + t(c.error), "bad");
    CAT = c;
    const kc = await api("/api/keychains"); if (kc.ok) KEYCH = kc.items || [];
    const m = await api("/api/meta"); if (m.ok) { S.meta = m; LOCAL = m.localAssets !== false; $("#fData").textContent = "数据 v" + String(m.version || "").slice(0, 8) + (m.gameVersion && m.gameVersion !== String(m.version || "").slice(0, 12) ? " · 游戏端 v" + m.gameVersion : ""); renderNotice(); }
    S.dataVer = CAT.version;
  }
  const v = $("#view"); v.innerHTML = "";
  // 页头
  const head = document.createElement("div");
  head.className = "pagehead";
  head.innerHTML = '<div class="eyebrow">饰品</div><h1>Howl <em>外观工坊</em></h1>' +
    '<div class="desc">自定义你的 CS2 武器外观、手套、探员与音乐盒。改动自动保存,进服约 3 秒生效。</div><div class="wm">DIY</div>';
  v.appendChild(head);
  // Steam 选择条
  const list = ME.steamids || [];
  if (!list.length) {
    const c = document.createElement("div"); c.className = "card";
    c.innerHTML = '<p class="hint">还没有绑定 SteamID:进服务器输入 <b>/howlbind</b> 拿绑定码,再到「账号」页绑定。也可以 <a href="/api/logout" onclick="event.preventDefault();fetch(\'/api/logout\',{method:\'POST\'}).then(()=>location.reload())">退出登录</a>。</p>';
    v.appendChild(c); // 服务器区已独立为 #/servers 页面 return;
  }
  S.steam = S.steam && list.some(s => s.steamid64 === S.steam) ? S.steam : list[0].steamid64;
  const tb = document.createElement("div");
  tb.className = "toolbar";
  tb.innerHTML = '<select id="steamPick" style="min-width:170px;max-width:40vw">' +
    list.map(s => '<option value="' + esc(s.steamid64) + '"' + (s.steamid64 === S.steam ? " selected" : "") + ">" + esc(s.persona || s.steamid64) + "</option>").join("") + "</select>" +
    '<span class="searchwrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="q" placeholder="搜索武器 / 皮肤 / 印花…"></span>' +
    '<button class="mini" id="btnCopyCT" title="把当前配置整边复制">复制 CT→T</button>' +
    '<button class="mini" id="btnCopyTC" title="把当前配置整边复制">复制 T→CT</button>' +
    '<button class="mini danger" id="btnClearAll">清空全部</button>' +
    '<span class="savestate" id="saveTip"></span>';
  v.appendChild(tb);
  $("#steamPick").onchange = e => { S.steam = e.target.value; S.edit = null; S.editPlan = null; S.bagMode = null; PLANS = []; renderEditorChrome(); loadRows().then(() => { renderGrid(); loadBag(); }); };
  $("#q").value = S.q;
  $("#q").oninput = debounce(() => { S.q = $("#q").value; renderGrid(); }, 220);
  $("#btnCopyCT").onclick = async () => { const j = await api("/api/loadout/" + S.steam + "/copy", { method: "POST", body: { from: "ct", to: "t" } }); if (j.ok) { toast("已将 CT 配置复制到 T 边", "ok"); await loadRows(); renderGrid(); } else toast(t(j.error), "bad"); };
  $("#btnCopyTC").onclick = async () => { const j = await api("/api/loadout/" + S.steam + "/copy", { method: "POST", body: { from: "t", to: "ct" } }); if (j.ok) { toast("已将 T 配置复制到 CT 边", "ok"); await loadRows(); renderGrid(); } else toast(t(j.error), "bad"); };
  $("#btnClearAll").onclick = async () => {
    if (!confirm("确定清空该 SteamID 的【全部】外观配置(CT/T/双队)?\n游戏内将恢复默认外观,不可恢复。")) return;
    const j = await api("/api/loadout/" + S.steam + "/all", { method: "DELETE" });
    if (j.ok) { toast("已清空", "ok"); await loadRows(); renderGrid(); } else toast(t(j.error), "bad");
  };
  // 背包行 + 摘要
  const lo = document.createElement("section"); lo.className = "loadoutrow";
  lo.innerHTML =
    '<div class="bagcol"><div class="sec-h"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h16v12H4z"/><path d="M8 8V6a4 4 0 018 0v2"/></svg>我的背包<span class="hint" style="font-weight:400;margin-left:8px">最多 3 套 · 设使用中即覆盖游戏内外观</span></div>' +
    '<div class="bagrow" id="bagRow"></div><div class="hint" id="planBanner" style="margin-top:8px"></div></div>' +
    '<div class="summary" id="summary"></div>';
  v.appendChild(lo);
  // 编辑器(普通模式 / 背包二级页 复用同一容器)
  const ed = document.createElement("section");
  ed.innerHTML = '<div class="sec-h" id="edChrome"></div><div id="grid" class="itemgrid"></div>';
  v.appendChild(ed);
  renderEditorChrome();
  $("#fSteam").textContent = "SteamID " + S.steam;
  await loadRows();
  renderGrid();
  renderBagSummary();
  // 服务器区已独立为 #/servers 页面
  loadBag();
}

/* ---------- 背包二级详情页(增/删/改背包内物品;使用中=实时同步游戏) ---------- */
async function enterBag(id) {
  await enterPlanEdit(id);
  S.bagMode = id;
  renderEditorChrome();
}
async function exitBag() {
  S.bagMode = null;
  const lp = PLANS.find(x => x.inUse);
  if (lp) await enterPlanEdit(lp.id); else { S.editPlan = null; await loadRows(); }
  markDirty(); renderGrid(); renderBagSummary(); renderBagRow(); renderEditorChrome();
}
async function deletePlan(id) {
  const p = PLANS.find(x => x.id === id); if (!p) return;
  await flushDirty();
  const extra = p.inUse ? "\n(这是使用中的背包:删除后游戏外观保持不变,编辑将自动回到下一个背包)" : "";
  if (!confirm("确定删除背包「" + p.name + "」?此操作不可恢复。" + extra)) return;
  const j = await api("/api/plans/" + S.steam + "/delete", { method: "POST", body: { id } });
  if (!j.ok) return toast(t(j.error), "bad");
  toast("已删除背包「" + p.name + "」", "ok");
  const wasLive = !!p.inUse;
  S.bagMode = null; S.editPlan = null;
  const r = await api("/api/plans/" + S.steam);
  PLANS = r.ok ? (r.plans || []) : [];
  if (wasLive) {
    if (PLANS.length) { S.editPlan = PLANS[0].id; PLANS[0].inUse = 1; S.rows = new Map((PLANS[0].rows || []).map(x => [key(x.s, x.t, x.a), x.v])); }
    else { await loadRows(); }
  }
  renderGrid(); renderBagSummary(); renderBagRow(); renderEditorChrome();
}
function openBagAddItem() {
  const box = document.createElement("div"); box.className = "ovl"; box.id = "ovl";
  box.innerHTML = '<div class="mask"></div><div class="modal" id="modal" style="width:min(96vw,680px)"><div class="dual"><div class="lcol"><div class="whead"><h4>添加物品到背包</h4><button class="mclose" id="aiX" style="position:static">✕</button></div><div class="wbody custom-scrollbar"><span class="searchwrap" style="display:flex;margin-bottom:10px"><input id="aiQ" placeholder="搜索武器 / 刀 / 手套"></span><div class="wgrid" id="aiGrid"></div></div></div></div></div>';
  document.body.appendChild(box);
  box.querySelector(".mask").onclick = () => box.remove();
  $("#aiX").onclick = () => box.remove();
  const render = () => {
    const q = ($("#aiQ").value || "").trim().toLowerCase();
    const its = allItems().filter(it => !q || (it.zh + " " + (it.en || "") + " " + it.ent).toLowerCase().includes(q));
    $("#aiGrid").innerHTML = its.map((it, i) => '<div class="pick" data-i="' + i + '"><div class="im" style="height:64px">' + imgTag(it.kind === "glove" ? "" : (it.baseImg || (it.ent + ".png")), it.url || "") + '</div><span class="nm">' + esc(it.zh) + "</span></div>").join("");
    imgWire($("#aiGrid"));
    $$("#aiGrid [data-i]").forEach(el => el.onclick = () => { box.remove(); openEdit(its[+el.dataset.i], "both"); });
  };
  $("#aiQ").oninput = debounce(render, 200);
  render();
}

/* ---------- 我的背包(多套配置:创建/重命名/设使用中/同步/清空/删除) ---------- */
let PLANS = [];
async function loadBag() {
  const j = await api("/api/plans/" + S.steam);
  PLANS = j.ok ? (j.plans || []) : [];
  renderBagRow();
}
function planPreview(rows) {
  // 取前 9 个有皮肤的条目做九宫格预览
  const cells = [];
  for (const o of rows || []) {
    if (cells.length >= 9) break;
    if (o.t === "weapon" || o.t === "knife" || o.t === "glove") {
      const id = o.v; const ix = String(id).lastIndexOf(":");
      if (ix > 0) { const ent = String(id).slice(0, ix), paint = String(id).slice(ix + 1); cells.push(ent + "-" + paint + ".png"); }
    }
  }
  return cells;
}
function renderBagRow() {
  const row = $("#bagRow"); if (!row) return;
  if (!PLANS.length) {
    row.innerHTML = '<div class="bag-empty" style="width:100%"><svg style="width:30px;height:30px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l2-5h14l2 5v11a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/><path d="M3 8h18M12 3v5M7.5 13a4.5 4.5 0 009 0"/></svg>背包还是空的,点右侧「新建」保存当前搭配</div>' + bagAddBtn();
  } else {
    row.innerHTML = PLANS.map((p, i) => {
      const cells = planPreview(p.rows);
      const total = (p.rows || []).filter(o => ["weapon", "knife", "glove"].includes(o.t)).length;
      const editing = S.editPlan === p.id || (S.editPlan == null && p.inUse);
      return '<div class="bagcard' + (editing ? " on" : "") + '" data-bag="' + p.id + '">' +
        '<span class="wmnum">' + String(i + 1).padStart(2, "0") + "</span>" +
        (p.inUse ? '<span class="inusechip"><i></i>使用中</span>' : "") +
        (editing ? '<span class="editchip">✎ 编辑中</span>' : "") +
        '<div class="prevzone">' + (cells.length ? cells.map(f => '<div class="cell">' + imgTag(f, "") + "</div>").join("") : '<span style="grid-area:1/1/-1/-1;align-self:center;font-size:11px;color:rgba(255,255,255,.25)">空背包</span>') +
        (total > 9 ? '<span class="morechip">+' + (total - 9) + "</span>" : "") + "</div>" +
        '<div class="nmrow"><b>' + esc(p.name) + '</b><button class="delbagx" data-delbag="' + p.id + '" title="删除此背包">✕</button><button class="menu3" data-menu="' + p.id + '" title="更多操作">⋮</button></div>' +
        '<button class="slideuse" data-use="' + p.id + '">✓ 设为使用中</button></div>';
    }).join("") + bagAddBtn();
  }
  imgWire(row);
  const banner = $("#planBanner");
  if (banner) {
    const cp = curPlan();
    banner.innerHTML = cp && !cp.inUse
      ? '<span style="color:#fde68a">📖 正在编辑背包「' + esc(cp.name) + '」(未使用中)——改动只存背包。 <a id="backLive">← 返回编辑使用中背包</a></span>'
      : (PLANS.length ? '<span>📖 正在编辑使用中背包,改动自动保存并同步到游戏</span>' : "");
    const bl = $("#backLive"); if (bl) bl.onclick = () => { const lp = PLANS.find(x => x.inUse); if (lp) enterPlanEdit(lp.id); else { S.editPlan = null; loadRows().then(() => { renderGrid(); renderBagRow(); }); } };
  }
  $$("[data-use]", row).forEach(b => b.onclick = e => { e.stopPropagation(); applyPlan(+b.dataset.use); });
  $$("[data-menu]", row).forEach(b => b.onclick = e => { e.stopPropagation(); openBagMenu(+b.dataset.menu, b); });
  $$(".bagcard", row).forEach(card => card.onclick = e => {
    if (e.target.closest("[data-menu],[data-use],[data-delbag],.slideuse")) return;
    enterBag(+card.dataset.bag);
  });
  $$("[data-delbag]", row).forEach(b => b.onclick = e => { e.stopPropagation(); deletePlan(+b.dataset.delbag); });
  const add = $("#bagAdd", row);
  if (add) add.onclick = async () => {
    if (PLANS.length >= 3) return toast("最多可以使用 3 个背包", "bad");
    const name = (prompt("给这套搭配起个名字:", "搭配 " + (PLANS.length + 1)) || "").trim().slice(0, 20);
    if (!name) return;
    const j = await api("/api/plans/" + S.steam + "/create", { method: "POST", body: { name, from: "current" } });
    if (j.ok) { toast("已创建背包「" + name + "」(内容=当前配置)", "ok"); loadBag(); } else toast(j.error === "plan_limit" ? "最多可以使用 3 个背包" : t(j.error), "bad");
  };
}
function bagAddBtn() {
  return '<button class="bag-add" id="bagAdd"><svg style="width:22px;height:22px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>新建<br>(存当前配置)</button>';
}
async function enterPlanEdit(id) {
  const p = PLANS.find(x => x.id === id); if (!p) return;
  await flushDirty();
  if (p.inUse) {
    S.editPlan = null;
    await loadRows();
  } else {
    S.editPlan = id;
    S.rows = new Map((p.rows || []).map(r => [key(r.s, r.t, r.a), r.v]));
    S.dirtySet.clear(); S.dirtyDel.clear();
  }
  markDirty(); renderGrid(); renderBagSummary(); renderBagRow();
  toast(p.inUse ? "正在编辑使用中背包(改动会同步到游戏)" : "已打开背包「" + p.name + "」— 修改只存背包,不影响游戏;「设为使用中」后生效", "ok");
}
const queueSaveFlush = () => new Promise(r => { const t0 = setTimeout(r, 1000); queueSave(); setTimeout(() => { clearTimeout(t0); r(); }, 900); });
async function flushDirty() {
  if (S.dirtySet.size + S.dirtyDel.size > 0) {
    await queueSaveNow();
    await new Promise(r => setTimeout(r, 300));
  }
  S.dirtySet.clear(); S.dirtyDel.clear();
}
async function queueSaveNow() {
  const set = [...S.dirtySet.values()], del = [...S.dirtyDel.values()];
  if (!set.length && !del.length) return;
  if (isLivePlan()) { await api("/api/loadout/" + S.steam, { method: "POST", body: { set, del } }); }
  else {
    const rows = [...S.rows.entries()].map(([k, v]) => { const [s, t2, a2] = k.split("|"); return { s, t: t2, a: a2, v }; });
    await api("/api/plans/" + S.steam + "/save", { method: "POST", body: { id: (curPlan() || {}).id, rows } });
  }
}
async function applyPlan(id) {
  const p = PLANS.find(x => x.id === id);
  if (!p) return;
  if (S.dirtySet.size + S.dirtyDel.size > 0 && !confirm("还有未保存的改动,将先为你保存再继续。继续?")) return;
  await flushDirty();
  const j = await api("/api/plans/" + S.steam + "/apply", { method: "POST", body: { id } });
  if (j.ok) { S.editPlan = null; toast("已设为使用中:" + p.name, "ok"); await loadRows(); renderGrid(); renderBagSummary(); loadBag(); } else toast(t(j.error), "bad");
}
function openBagMenu(id, anchor) {
  const p = PLANS.find(x => x.id === id); if (!p) return;
  const box = $("#popMenu");
  box.innerHTML =
    (p.inUse ? "" : '<button data-mi="use">✓ 设为使用中</button>') +
    '<button data-mi="sync">↥ 把当前外观同步到此背包</button>' +
    '<button data-mi="rename">✎ 重命名</button>' +
    '<hr><button data-mi="clear" class="danger">清空背包内容</button>' +
    '<button data-mi="del" class="danger">删除背包</button>';
  const rc = anchor.getBoundingClientRect();
  box.style.left = Math.min(rc.left, window.innerWidth - 190) + "px";
  box.style.top = (rc.bottom + 6) + "px";
  box.classList.add("show");
  const close = () => box.classList.remove("show");
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
  const act = async (what) => {
    close();
    if (what === "use") return applyPlan(id);
    if (what === "sync") { const j = await api("/api/plans/" + S.steam + "/sync", { method: "POST", body: { id } }); if (j.ok) toast("已同步到「" + p.name + "」", "ok"); return; }
    if (what === "rename") { const name = (prompt("新名称:", p.name) || "").trim().slice(0, 20); if (!name) return; await api("/api/plans/" + S.steam + "/rename", { method: "POST", body: { id, name } }); return loadBag(); }
    if (what === "clear") { if (!confirm("确定清空背包「" + p.name + "」的内容?使用中背包清空会同步清游戏内外观。")) return; await api("/api/plans/" + S.steam + "/clear", { method: "POST", body: { id } }); if (p.inUse) { await api("/api/loadout/" + S.steam + "/all", { method: "DELETE" }); await loadRows(); renderGrid(); } return loadBag(); }
    if (what === "del") { if (!confirm("确定删除背包「" + p.name + "」?该操作不可恢复。")) return; await api("/api/plans/" + S.steam + "/delete", { method: "POST", body: { id } }); return loadBag(); }
  };
  $$("[data-mi]", box).forEach(b => b.onclick = () => act(b.dataset.mi));
}
/* ---------- 顶栏公告条(参考站 amber 通知):数据版本与同步状态 ---------- */
function renderNotice() {
  const el = $("#notice"); const txt = $("#noticeTxt"); const pop = $("#noticePop");
  if (!el || !txt || !pop) return;
  const m = S.meta;
  const ver = m && m.version ? String(m.version).slice(0, 8) : "—";
  const verFull = m && m.version ? String(m.version) : "";
  const gameFull = m && m.gameVersion ? String(m.gameVersion) : "";
  /* 游戏端存的是指纹前 12 位(插件写 howl_meta 时截短);全 64 位 SHA256 用前缀判等 */
  const sameVer = !!verFull && !!gameFull && (verFull.length === gameFull.length
    ? verFull.toLowerCase() === gameFull.toLowerCase()
    : verFull.slice(0, gameFull.length).toLowerCase() === gameFull.toLowerCase());
  txt.textContent = "皮肤数据 v" + ver + " · " + (m && m.counts ? m.counts.skins : "?") + " 款皮肤 / " + (m && m.counts ? m.counts.stickers : "?") + " 张贴纸,CSGO-API 自动同步";
  pop.innerHTML = m ? "<b>Howl 数据同步</b><br>网页端版本 v" + esc(verFull ? verFull.slice(0, 12) : "—") +
    (gameFull ? "<br>游戏端版本 v" + esc(gameFull) + (sameVer ? "(一致)" : "(不一致,游戏端稍后自动对齐)") : "<br>游戏端:等待插件首次同步") +
    "<br>最近同步:" + esc(m.lastSync && m.lastSync.at ? new Date(m.lastSync.at).toLocaleString() : (m.lastSync && m.lastSync.msg) || "启动检查中") +
    (m.lastSync && m.lastSync.images ? "<br>图片:总数 " + m.lastSync.images.total + ",本次新下 " + m.lastSync.images.downloaded + (m.lastSync.images.failed ? ",失败 " + m.lastSync.images.failed : "") : "") +
    "<br>本地素材:" + (m.localAssets ? "已就绪" : "未部署(走 Steam CDN 兜底)") +
    "<br><span style='opacity:.7'>插件侧按同一数据源每小时自动对齐,两侧版本号一致即同步正常。</span>" : "";
  el.onclick = () => pop.classList.toggle("show");
  document.addEventListener("click", e => { if (!e.target.closest("#notice,#noticePop")) pop.classList.remove("show"); });
}
/* 摘要三宫格:TR 探员 / CT 探员 / 音乐盒 */
function renderBagSummary() {
  const box = $("#summary"); if (!box) return;
  const agCt = CAT.agents.find(a => a.id === getV("any", "agent", "ct"));
  const agT = CAT.agents.find(a => a.id === getV("any", "agent", "t"));
  const mk = String(getV("any", "music_kit", "music") || "");
  const mkm = CAT.music.find(x => String(x.kit) === mk);
  box.innerHTML =
    '<div class="sumcard" data-sum="t"><div class="im">' + (agT ? imgTag(agT.img, agT.url) : '<span class="hint">默认</span>') + '</div><div class="lb">TR 探员</div><div class="nm">' + esc(agT ? agT.zh : "未选择") + "</div></div>" +
    '<div class="sumcard" data-sum="ct"><div class="im">' + (agCt ? imgTag(agCt.img, agCt.url) : '<span class="hint">默认</span>') + '</div><div class="lb">CT 探员</div><div class="nm">' + esc(agCt ? agCt.zh : "未选择") + "</div></div>" +
    '<div class="sumcard" data-sum="music"><div class="im">' + (mkm ? imgTag(mkm.img, "") : '<span class="hint">默认</span>') + '</div><div class="lb">音乐盒</div><div class="nm">' + esc(mkm ? mkm.zh : "未选择") + "</div></div>";
  $$("#summary [data-sum]").forEach(el => el.onclick = () => openSimpleModal(el.dataset.sum));
}
function imgTag(file, url) {
  return '<img src="' + esc(imgUrl(file, url)) + '" loading="lazy" decoding="async" data-n="' + esc(file) + '"' + (url ? ' data-c="' + esc(url) + '"' : "") + ">";
}

/* ---------- 平铺卡网格:双队 / TR / CT 自动判定 ---------- */
function allItems() {
  const out = [];
  out.push({ kind: "glove", ent: "glove", zh: "手套", en: "Gloves" });
  const order = { rifles: 0, snipers: 1, pistols: 2, smgs: 3, heavy: 4 };
  const guns = CAT.guns.slice().sort((a, b) => (order[gunCat(a)] - order[gunCat(b)]) || (a.def - b.def));
  for (const g of guns) out.push({ kind: "gun", ent: g.entity, zh: g.zh, en: g.en, g });
  for (const k of CAT.knives) out.push({ kind: "knife", ent: k.entity, zh: k.zh, en: k.en, url: k.url || "", baseImg: k.baseImg || (k.entity + ".png"), k });
  return out;
}
const gunCat = g => g.sniper ? "snipers" : g.cat;
function knifeSkinId(side, model) {
  // 型号专属行优先;target=knife 的兜底行只对"当前佩戴型号"可见(与插件 ResolveKnife 同语义)
  const own = effV(side, "knife", model);
  if (own) return own;
  return (effV(side, "knife_type", "knife") === model) ? effV(side, "knife", "knife") : null;
}
function skinOf(item, side) {
  if (item.kind === "knife") {
    const id2 = knifeSkinId(side, item.ent);
    if (!id2) return { id: null, s: null, mixed: false };
    const ks2 = (CAT.knives.find(k => k.entity === item.ent) || { skins: [] }).skins;
    return { id: id2, s: ks2.find(x => x.id === id2) || null, mixed: false };
  }
  const tk = item.kind === "gun" ? "weapon" : item.kind;
  const id = effV(side, tk, item.ent);
  if (!id) return null;
  let s = null;
  if (item.kind === "gun") { const g = CAT.guns.find(x => x.entity === item.ent); s = g && g.skins.find(x => x.id === id); }
  else { const gl = (CAT.gloves.find(x => x.model === String(id).split(":")[0]) || { skins: [] }); gl.skins.forEach(a2 => { if (a2.id === id) s = a2; }); }
  return { id, s, mixed: !!s && s.id.split(":")[0] !== item.ent };
}
function attrOf(item, side) {
  const tk = item.kind === "gun" ? "weapon" : item.kind;
  const ent = item.kind === "knife" ? "knife" : item.ent;   // 刀的通用属性行统一 target=knife
  const st = { skin: (skinOf(item, side) || {}).id || "", wear: effV(side, "wear", ent) || "", seed: effV(side, "seed", ent) || "", st: effV(side, "stattrak", ent) === "1", tag: effV(side, "nametag", ent) || "", kc: effV(side, "keychain", ent) || "", stk: [0, 1, 2, 3, 4].map(i => effV(side, "sticker", ent + ":" + i) || "") };
  if (item.kind === "knife") st.knifeType = getV(side, "knife_type", "knife") || getV("any", "knife_type", "knife") || "";
  return st;
}
const fpOf = st => JSON.stringify([st.skin, st.wear, st.seed, st.st, st.tag, st.kc, st.stk, st.knifeType || ""]);
function hasRowsFor(item) {
  const tk = item.kind === "gun" ? "weapon" : item.kind;
  const p = S.rows;
  for (const [k] of p) {
    const [s, tt, a] = k.split("|");
    if (tt !== tk && !(item.kind === "knife" && tt === "knife_type")) continue;
    if (a === item.ent || a === "knife" || a === "glove" || (a || "").startsWith(item.ent + ":")) return true;
  }
  return false;
}
function renderGrid() {
  const grid = $("#grid"); if (!grid) return;
  const q = S.q.trim().toLowerCase();
  const items = allItems().filter(it => !q || (it.zh + " " + it.en + " " + (skinOf(it, "ct") || skinOf(it, "t") || { id: "" }).id).toLowerCase().includes(q));
  grid.innerHTML = items.map(it => {
    const stCt = attrOf(it, "ct"), stT = attrOf(it, "t");
    const same = fpOf(stCt) === fpOf(stT);
    const hasAny = !!getV("any", it.kind === "gun" ? "weapon" : it.kind, it.ent);
    if (same) return cardHTML(it, "both", stCt);
    let out = "";
    if (it.kind === "gun" ? it.g.ct : true) out += cardHTML(it, "ct", stCt);
    if (it.kind === "gun" ? it.g.t : true) out += cardHTML(it, "t", stT);
    if (!out) out = cardHTML(it, "both", stCt);
    return out;
  }).join("");
  imgWire(grid);
  $$("#grid [data-card]").forEach(el => el.onclick = e => {
    if (e.target.closest("[data-op]")) return;
    const it = allItems()[+el.dataset.idx];
    openEdit(it, el.dataset.side);
  });
  $$("#grid [data-op=split]").forEach(b => b.onclick = e => {
    e.stopPropagation();
    const it = allItems()[+b.closest("[data-card]").dataset.idx];
    splitItem(it); toast("已拆分为 CT / T 两边(两边现有配置保留;以双队值为基础)", "ok");
  });
  $$("#grid [data-op=merge]").forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (!confirm("合并双队:将以当前显示的 CT 边配置覆盖 T 边并合并,另一队现有设置会被替换。继续?")) return;
    mergeItem(itOf(b));
    toast("已合并为双队", "ok");
  });
}
function renderEditorChrome() {
  const chrome = $("#edChrome"); if (!chrome) return;
  const p = PLANS.find(x => x.id === S.bagMode);
  if (!p) {
    chrome.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l6 6-6 6M14 20h6"/></svg>选择饰品(双队卡=CT/T 相同;点卡片编辑,悬停可拆分/合并)';
    return;
  }
  chrome.innerHTML = '<button class="mini" id="bagBack">‹ 返回</button>' +
    '<span style="font-size:16px">🎒 ' + esc(p.name) + (p.inUse ? ' <span class="tag" style="color:#43d17c">使用中·改动实时进游戏</span>' : ' <span class="tag" style="color:#fde68a">未使用中·改动只存背包</span>') + "</span>" +
    '<span class="spacer" style="flex:1"></span>' +
    '<button class="mini" id="bagAddItem">＋ 添加物品</button>' +
    (!p.inUse ? '<button class="mini" id="bagUse">设为使用中</button>' : "") +
    '<button class="mini danger" id="bagDel">🗑 删除此背包</button>';
  $("#bagBack").onclick = exitBag;
  $("#bagAddItem").onclick = openBagAddItem;
  const bu = $("#bagUse"); if (bu) bu.onclick = async () => { await applyPlan(p.id); S.bagMode = p.id; renderEditorChrome(); };
  $("#bagDel").onclick = () => deletePlan(p.id);
}
function planRemoveItem(it) {
  const ents = it.kind === "knife" ? ["knife", it.ent] : it.kind === "glove" ? ["glove"] : [it.ent];
  const types = ["weapon", "knife", "glove", "keychain", "wear", "seed", "nametag", "stattrak"];
  for (const t2 of types) for (const e of ents) for (const s of ["any", "ct", "t"]) putV(s, t2, e, null);
  for (const e of ents) for (const s of ["any", "ct", "t"]) for (let i = 0; i < 5; i++) putV(s, "sticker", e + ":" + i, null);
  if (it.kind === "knife") for (const s of ["any", "ct", "t"]) putV(s, "knife_type", "knife", null);
  toast("已从该背包移除", "ok");
  closeModal(); renderGrid(); renderBagSummary();
}
function itOf(b) { return allItems()[+b.closest("[data-card]").dataset.idx]; }
function cardHTML(it, side, st) {
  const idx = allItems().findIndex(x => x.ent === it.ent && x.kind === it.kind);
  const cur = st.skin ? ((skinOf(it, side === "both" ? "ct" : side) || {}).s) : null;
  const rc = cur ? cur.color : "transparent";
  const wearT = CAT.wearTiers.find(w => Number(st.wear) >= 0 && Number(st.wear) <= w.max && st.wear !== "");
  const title = cur ? cur.zh : it.zh;
  const sub = cur ? it.zh + (side === "both" ? "" : " · " + (side === "ct" ? "CT" : "T")) : (it.kind === "glove" ? "未配置" : "原皮");
  const cap = [wearT ? wearT.zh : (st.wear ? "自定义磨损" : ""), cur ? cur.rarZh : "", CATLABEL[side === "both" && it.kind === "gun" ? gunCat(it.g) : it.kind === "gun" ? gunCat(it.g) : it.kind] || ""].filter(Boolean).join(" ");
  const stks = st.stk.filter(Boolean).slice(0, 5).map(v => {
    const def = String(v).split("|")[0].replace("sticker-", "");
    return '<img src="' + esc(imgUrl("sticker-" + def + ".png", STKU.get(def) || "")) + '" loading="lazy" alt="' + esc(STKU.get(def) || "") + '">';
  }).join("");
  const kc = st.kc ? '<span class="kc"><img src="' + esc(imgUrl(String(st.kc).replace("keychain-", "keychain-") + ".png", "")) + '" loading="lazy" alt=""></span>' : "";
  const badge = side === "both" ? '<span class="badge">⛓ 双队</span>' : '<span class="badge ' + (side === "ct" ? "ct" : "t") + '">' + (side === "ct" ? "🛡 CT" : "🔥 T") + "</span>";
  const ops = side === "both"
    ? '<div class="ops"><button data-op="split">拆分队伍</button></div>'
    : '<div class="ops"><button data-op="merge">合并队伍</button></div>';
  const img = cur ? cur.img : (it.kind === "gun" ? it.ent + ".png" : it.kind === "knife" ? (it.baseImg || (it.ent + ".png")) : "");
  const imgU = cur ? (cur.url || "") : (it.kind === "gun" ? (it.g.url || "") : it.kind === "knife" ? (it.url || "") : "");
  return '<div class="scard" data-card data-idx="' + idx + '" data-side="' + side + '" style="--rc:' + rc + ';--rc2:' + rc + '26">' +
    '<span class="glow"></span>' + badge + '<span class="stk">' + stks + "</span>" + kc +
    '<div class="imgwrap">' + (img ? '<span class="skel"></span><img src="' + esc(imgUrl(img, imgU)) + '" loading="lazy" decoding="async" data-n="' + esc(img) + '"' + (imgU ? ' data-c="' + esc(imgU) + '"' : "") + ">" : (imgU ? '<img src="' + esc(imgU) + '" loading="lazy" data-c="' + esc(imgU) + '">' : '<span class="hint" style="font-size:11px">无预览</span>')) + "</div>" +
    '<div class="t1">' + esc(title) + (cur && st.wear !== "" ? '<span class="wr" style="color:' + (((CAT.wearTiers.find(w2 => Number(st.wear) <= w2.max)) || CAT.wearTiers[4]).color) + '">' + (((CAT.wearTiers.find(w2 => Number(st.wear) <= w2.max)) || CAT.wearTiers[4]).key) + "</span>" : "") + "</div>" +
    '<div class="t2">' + (cur ? '<i></i>' : "") + "<span>" + esc(sub) + "</span>" + (st.st ? '<span style="color:#e0843c;margin-left:auto">ST™</span>' : "") + "</div>" +
    '<div class="t3">' + esc(cap) + "</div>" + ops + "</div>";
}
/* 拆分:把双队(any)值写入 ct/t 两边 */
function splitItem(it) {
  const tk = it.kind === "gun" ? "weapon" : it.kind;
  const ent = it.ent;
  const move = (tt, a) => {
    const v = getV("any", tt, a);
    if (v == null) return;
    putV("ct", tt, a, v); putV("t", tt, a, v); putV("any", tt, a, null);
  };
  move(tk, ent); ["wear", "seed", "nametag", "stattrak", "keychain"].forEach(x => move(x, ent));
  if (it.kind === "knife") {
    move("knife_type", "knife"); move("knife", "knife");
    allKeysWith("knife|").forEach(k => { const [, tt, a2] = k.split("|"); if (tt === "knife" && a2 !== "knife") move("knife", a2); });
    ["wear", "seed", "nametag", "stattrak", "keychain"].forEach(x => { if (getV("any", x, "knife") != null) move(x, "knife"); });
  }
  if (it.kind !== "knife" && it.kind !== "glove") [0, 1, 2, 3, 4].forEach(i => move("sticker", ent + ":" + i));
  renderGrid();
}
function allKeysWith(prefix) { return [...new Set([...S.rows.keys(), ...S.dirtySet.keys()])].filter(k => k.startsWith(prefix)); }
/* 合并:以 CT 边当前值写入 any,并删除两边行 */
function mergeItem(it) {
  const tk = it.kind === "gun" ? "weapon" : it.kind;
  const ent = it.ent;
  const setAny = (tt, a) => {
    const v = effV("ct", tt, a) != null ? effV("ct", tt, a) : effV("t", tt, a);
    if (v != null) putV("any", tt, a, v);
    putV("ct", tt, a, null); putV("t", tt, a, null);
  };
  setAny(tk, ent); ["wear", "seed", "nametag", "stattrak", "keychain"].forEach(x => setAny(x, ent));
  if (it.kind === "knife") {
    const v = effV("ct", "knife_type", "knife"); if (v != null) putV("any", "knife_type", "knife", v);
    allKeysWith("knife|").forEach(k => { const [, tt, a2] = k.split("|"); if (tt === "knife" && a2 !== "knife") setAny("knife", a2); });
  }
  if (it.kind !== "knife" && it.kind !== "glove") [0, 1, 2, 3, 4].forEach(i => setAny("sticker", ent + ":" + i));
  renderGrid();
}

/* ---------- 详情弹层:左 360 子标签 + 内联属性块,右滑出翼(参考站结构) ---------- */
function tabHTML(x) {
  const E = S.edit;
  return '<div class="mtab' + (E.wing && E.wing.view === x[0] ? " on" : "") + '" data-tab="' + x[0] + '">' + svg(x[1]) + '<b class="lb">' + x[2] + '</b><span class="hint2">' + esc(x[3]) + "</span></div>";
}
function propsBlockHTML(wt, st) {
  return '<div class="mprops">' +
    '<div class="prow"><span class="lbl">' + (wt ? '<i style="background:' + wt.color + '"></i>' + wt.zh + "(" + wt.key + ")" : "磨损") + '</span><div class="wz"><input type="number" id="wearN" min="0" max="1" step="0.0001" value="' + (st.wear === "" ? "0" : esc(st.wear)) + '"><input type="range" id="wearR" min="0" max="1" step="0.0001" value="' + (st.wear === "" ? 0 : esc(st.wear)) + '" style="flex:1;width:120px"></div></div>' +
    '<div class="prow" style="flex-wrap:wrap"><span></span><input type="range" id="wearR2" min="0" max="1" step="0.0001" value="' + (st.wear === "" ? 0 : esc(st.wear)) + '" style="flex:1;min-width:150px"></div>' +
    '<div class="prow"><span class="lbl">模板</span><input type="number" id="seedN" min="-1" max="8192" step="1" value="' + (st.seed === "" ? "-1" : esc(st.seed)) + '"></div>' +
    '<div class="prow"><span class="lbl">名称</span><input type="text" id="tagI" maxlength="20" placeholder="默认" value="' + esc(st.tag) + '"></div>' +
    '<div class="prow"><span class="lbl">暗金 StatTrak™</span><label class="switch"><input type="checkbox" id="stIn"' + (st.st ? " checked" : "") + "></label></div>" +
    "</div>";
}

function openEdit(it, side) {
  if (it.kind === "knife") {
    const layer = side === "both" ? "any" : side;
    const cur = getV("ct", "knife_type", "knife") ?? getV("t", "knife_type", "knife") ?? getV("any", "knife_type", "knife");
    if (cur !== it.ent) putV("any", "knife_type", "knife", it.ent);   // 刀型=全局项(与插件一致,永远写 any 层)
    S.edit = { it, side, wing: { view: "knifeTypes" }, wq: "", wpage: 0, wrar: "", stkSlot: 0, knifeModel: it.ent };  // 流程:先选模型,再选皮肤
  } else {
    S.edit = { it, side, wing: null, wq: "", wpage: 0, wrar: "", stkSlot: 0 };
  }
  closeModalOnEsc();
  renderModal();
}
function closeModalOnEsc() {
  document.onkeydown = e => { if (e.key === "Escape") closeModal(); };
}
function closeModal() { const o = $("#ovl"); if (o) o.remove(); S.edit = null; renderGrid(); renderBagSummary(); }
function editLayer() { return S.edit.side === "both" ? "any" : S.edit.side; }
function renderModal() {
  const E = S.edit; if (!E) return;
  const it = E.it, layer = editLayer();
  const tk = it.kind === "glove" ? "glove" : it.kind === "knife" ? "knife" : "weapon";
  const st = attrOf(it, E.side);
  const knifeSkinTarget = it.kind === "knife" ? null : null;
  const cur = st.skin ? (skinOf(it, E.side === "both" ? "ct" : E.side) || {}).s : null;
  // 手套的"型号":skinId 冒号前缀;未选皮肤则用当前型号
  const gloveModel = it.kind === "glove" ? (st.skin ? String(st.skin).split(":")[0] : (getV(layer, "glove", "glove") ? String(getV(layer, "glove", "glove")).split(":")[0] : (S._gloveModel || (CAT.gloves[0] || {}).model))) : "";
  const knifeType = it.kind === "knife" ? (E.knifeModel || it.ent) : "";
  if (it.kind === "knife") E.knifeModel = knifeType;
  const skinList = it.kind === "gun" ? ((CAT.guns.find(g => g.entity === it.ent) || { skins: [] }).skins)
    : it.kind === "knife" ? ((CAT.knives.find(k => k.entity === knifeType) || { skins: [] }).skins)
    : ((CAT.gloves.find(g => g.model === gloveModel) || { skins: [] }).skins);
  const prevImg = cur ? cur.img : (it.kind === "gun" ? it.ent + ".png" : it.kind === "knife" ? ((CAT.knives.find(k => k.entity === knifeType) || {}).baseImg || (knifeType + ".png")) : gloveModel + "-" + (((CAT.gloves.find(g => g.model === gloveModel) || { skins: [{}] }).skins[0]) || {}).paint + ".png");
  const badgeTxt = E.side === "both" ? "⛓ 双队" : E.side === "ct" ? "🛡 CT" : "🔥 T";
  const tabsA = [];
  if (it.kind === "knife") tabsA.push(["knifeTypes", "swords", "刀型", knifeType ? ((CAT.knives.find(k => k.entity === knifeType) || {}).zh || "") : "未选"]);
  if (it.kind === "glove") tabsA.push(["gloveModels", "wrench", "种类", (CAT.gloves.find(g => g.model === gloveModel) || {}).zh || ""]);
  tabsA.push(["skins", "palette", "皮肤", cur ? cur.zh : "原皮"]);
  const tabsB = [];
  if (it.kind === "gun" && cur) tabsB.push(["stickers", "stamp", "印花", st.stk.filter(Boolean).length ? st.stk.filter(Boolean).length + " 张" : "未添加"]);
  if (cur || st.kc) tabsB.push(["keychain", "paperclip", "挂件", st.kc ? ((KEYCH.find(k => "keychain-" + k.def == String(st.kc)) || {}).zh || "已选") : "未添加"]);
  const wearNum = st.wear === "" ? 0 : Number(st.wear);
  const wt = CAT.wearTiers.find(w => wearNum <= w.max);
  let ovl = $("#ovl");
  if (!ovl) {
    ovl = document.createElement("div"); ovl.id = "ovl"; ovl.className = "ovl";
    ovl.innerHTML = '<div class="mask"></div><div class="modal" id="modal"></div>';
    document.body.appendChild(ovl);
    ovl.querySelector(".mask").onclick = closeModal;
  }
  const modal = $("#modal");
  const left =
    '<div class="mleft"><div class="mleftscroll custom-scrollbar">' +
    '<div class="grip"></div><div class="mtitle">' + esc(it.zh) + '<button class="mclose" id="mx">✕</button></div>' +
    '<div class="mprev"><span class="skel"></span><img src="' + esc(imgUrl(prevImg, "")) + '" data-n="' + esc(prevImg) + '"><span class="badge">' + badgeTxt + "</span></div>" +
    '<div class="mskinname">' + esc(cur ? cur.zh + " · " + (cur.rarZh || "") : "原皮(默认外观)") + (cur && cur.mixed ? '<span class="tag" style="margin-left:6px">混搭自 ' + esc(cur.id.split(":")[0]) + "</span>" : "") + "</div>" +
    '<div class="msync">' + (E.side === "both" ? "🔗 改动同步 TR / CT 双方" : "✏ 仅编辑 " + (E.side === "ct" ? "CT" : "TR") + " 队伍") + "</div>" +
    '<div class="mtabs">' + tabsA.map(tabHTML).join("") +
        propsBlockHTML(wt, st) + tabsB.map(tabHTML).join("") +
    (S.bagMode != null ? '<div class="mtab" id="rmItem" style="color:#ff8080"><b class="lb">🗑 从背包移除该物品</b></div>' : "") + "</div>" +
    "</div></div>";
  modal.innerHTML = left + '<div class="mwing" id="wing"></div>';
  modal.classList.toggle("winging", !!E.wing);
  imgWire(modal);
  $("#mx").onclick = closeModal;
  $$("#modal .mtab").forEach(el => el.onclick = () => {
    const v = el.dataset.tab;
    E.wing = E.wing && E.wing.view === v ? null : { view: v };
    E.wq = ""; E.wpage = 0; E.wrar = "";
    renderModal();
  });
  const wn = $("#wearN"), wr = $("#wearR"), wr2 = $("#wearR2");
  if (wr2) { wr2.oninput = () => { wr.value = wr2.value; wn.value = wr2.value; }; wr2.onchange = () => { wn.onchange(); }; }
  const setWear = v => { const cleanV = (v === "" || v == null || Number(v) === 0) ? null : String(v); putV(layer, "wear", it.ent, cleanV); };
  wn.oninput = () => { wr.value = wn.value; };
  wr.oninput = () => { wn.value = wr.value; };
  wn.onchange = () => { setWear(wn.value); renderModal(); };
  wr.onchange = () => { setWear(wr.value); renderModal(); };
  const sn = $("#seedN");
  sn.onchange = () => putV(layer, "seed", it.ent, sn.value === "" || +sn.value === 0 ? null : sn.value);
  const ti = $("#tagI");
  ti.onchange = () => putV(layer, "nametag", it.ent, ti.value.trim() || null);
  const sti = $("#stIn");
  sti.onchange = () => putV(layer, "stattrak", it.ent, sti.checked ? "1" : null);
  renderWing(skinList, it, layer, E);
  /* 统一绑定翼头按钮(返回上一级 / 关闭翼):各翼函数只负责渲染 */
  const bkE = $("#wbk");
  if (bkE) bkE.onclick = () => { const EE = S.edit; if (EE) { EE.wing = EE.wing.from || null; renderModal(); } };
  const rm = $("#rmItem"); if (rm) rm.onclick = () => planRemoveItem(it);
  const wcE = $("#wcl");
  if (wcE) wcE.onclick = () => { const EE = S.edit; if (EE) { EE.wing = null; renderModal(); } };
}
/* ---------- 翼内容 ---------- */
function wingHead(title, back) {
  return '<div class="whead">' + (back ? '<button class="wback" id="wbk" title="返回上一级">‹</button>' : "") + "<h4>" + esc(title) + '</h4><button class="wclose" id="wcl" title="收起此面板">✕</button></div><div class="wbody custom-scrollbar" id="wbody"></div>';
}
function renderWing(skinList, it, layer, E) {
  const w = $("#wing");
  if (!E.wing) { w.innerHTML = '<div class="whead"><h4 style="color:rgba(255,255,255,.4)">◀ 从左侧选择要编辑的项</h4></div><div class="wbody"><div class="empty">点「皮肤 / 刀型 / 印花 / 挂件」<br>这里会出现对应的选择网格</div></div>'; return; }
  const v = E.wing.view;
  if (v === "skins") return wingSkins(w, skinList, it, layer, E);
  if (v === "mixGuns") return wingMixGuns(w, it, layer, E);
  if (v === "mixSkins") return wingMixSkins(w, it, layer, E);
  if (v === "knifeTypes") return wingKnifeTypes(w, it, layer, E);
  if (v === "gloveModels") return wingGloveModels(w, it, layer, E);
  if (v === "stickers") return wingStickers(w, it, layer, E);
  if (v === "stickerPick") return wingStickerPick(w, it, layer, E);
  if (v === "keychain") return wingKeychain(w, it, layer, E);
}
function wingNav(w, html) {
  w.innerHTML = html;
  const bk = $("#wbk");
  if (bk) bk.onclick = () => { const E = S.edit; E.wing = (E.wing && E.wing.from) || null; renderModal(); };

  imgWire(w);
}
function pickGrid(list, curId, fileOf, nameOf, enOf, colorOf, onPick, opts) {
  opts = opts || {};
  const per = opts.per || 60;
  const show = list.slice(0, (S.edit.wpage + 1) * per);
  return show.map((x, i) => {
    const f = fileOf(x), c = colorOf(x) || "transparent";
    return '<div class="pick' + (x.id === curId ? " on" : "") + '" data-i="' + i + '" style="--rc:' + c + '">' +
      '<div class="im">' + (f ? '<span class="skel"></span><img src="' + esc(imgUrl(f, x.url || "")) + '" loading="lazy" data-n="' + esc(f) + '"' + (x.url ? ' data-c="' + esc(x.url) + '"' : "") + ">" : "") + "</div>" +
      '<span class="nm">' + esc(nameOf(x)) + "</span>" + (enOf ? '<span class="en">' + esc(enOf(x) || "") + "</span>" : "") + '<span class="rt"></span></div>';
  }).join("") + (list.length > show.length ? '<div class="loadmore"><button class="mini" id="wmore">加载更多(共 ' + list.length + ",已显示 " + show.length + ")</button></div>" : "");
}
function wirePick(w, list, onPick) {
  $$("[data-i]", w).forEach(el => el.onclick = () => onPick(list[+el.dataset.i]));
  const m = $("#wmore", w);
  if (m) m.onclick = () => { S.edit.wpage++; renderModal(); };
}
function wingSkins(w, skinList, it, layer, E) {
  const tk = it.kind === "gun" ? "weapon" : it.kind;
  const skEnt = it.kind === "knife" ? (E.knifeModel || it.ent) : it.ent;
  const skinLayer = it.kind === "glove" ? "any" : layer;   // 手套皮肤=全局
  const curId = getV(skinLayer, tk, skEnt) ?? (it.kind === "knife" ? (getV(skinLayer, tk, "knife") ?? getV("any", tk, "knife")) : null);
  w.innerHTML = wingHead("选择皮肤", null);
  const body = $("#wbody");
  const q = (E.wq || "").trim().toLowerCase();
  let list = skinList.filter(s => (!q || (s.zh + s.en + s.paint).toLowerCase().includes(q)) && (!E.wrar || s.rar === E.wrar));
  const mixRow = '<button class="mixbtn" id="mixBtn">🔀 混搭其他武器皮肤 →</button>';
  const chips = '<div class="chips"><span class="chip' + (E.wrar ? "" : " on") + '" data-r="">全部</span>' +
    RAR_ORDER.filter(r => skinList.some(s => s.rar === r)).map(r => '<span class="chip' + (E.wrar === r ? " on" : "") + '" data-r="' + r + '"><i style="background:' + CAT.rarColor[r] + '"></i>' + CAT.rarZh[r] + "</span>").join("") + "</div>";
  const stock = '<div class="pick' + (!curId ? " on" : "") + '" data-stock="1"><div class="im">—</div><span class="nm">原皮</span><span class="en">默认外观</span><span class="rt"></span></div>';
  body.innerHTML = mixRow + chips + '<div class="wgrid">' + stock + pickGrid(list, curId, s => s.img, s => s.zh, s => s.en, s => s.color, null) + "</div>";
  $("#mixBtn").onclick = () => { E.wing = { view: "mixGuns", from: { view: "skins" } }; E.wq = ""; E.wpage = 0; renderModal(); };
  $$("#wbody .chip", body).forEach(c => c.onclick = () => { E.wrar = c.dataset.r; E.wpage = 0; renderModal(); });
  $$("[data-i]", body).forEach(el => el.onclick = () => { putV(skinLayer, tk, skEnt, list[+el.dataset.i].id); renderModal(); });
  const sb = $('[data-stock="1"]', body); if (sb) sb.onclick = () => { putV(skinLayer, tk, skEnt, null); putV("any", tk, "knife", null); putV(layer, tk, "knife", null); renderModal(); };
  wirePickMore(body);
  imgWire(body);
}
function wirePickMore(box) {
  const m = $("#wmore", box);
  if (m) m.onclick = () => { S.edit.wpage++; renderModal(); };
}
function wingMixGuns(w, it, layer, E) {
  const q = (E.wq || "").trim().toLowerCase();
  const guns = CAT.guns.concat(CAT.knives.map(k => ({ entity: k.entity, zh: k.zh, en: k.en, skins: k.skins, isKnife: 1 })));
  const list = guns.filter(g => !q || (g.zh + " " + (g.en || "") + " " + g.entity).toLowerCase().includes(q));
  w.innerHTML = wingHead("混搭 · 选择来源武器", true);
  $("#wbody").innerHTML = searchBox("搜索武器名称或 ID") + '<div class="wgrid">' +
    list.map((g, i) => '<div class="pick" data-i="' + i + '"><div class="im">' + (g.isKnife ? "" : imgTag((g.entity) + ".png", g.url || "")) + '</div><span class="nm">' + esc(g.zh) + '</span><span class="en">' + esc((g.skins || []).length + " 皮肤") + "</span></div>").join("") + "</div>";
  wireSearch();
  $$("#wbody [data-i]").forEach(el => el.onclick = () => { E.wing = { view: "mixSkins", owner: list[+el.dataset.i], from: E.wing }; E.wq = ""; E.wpage = 0; renderModal(); });
  imgWire($("#wbody"));
}
function wingMixSkins(w, it, layer, E) {
  const owner = E.wing.owner;
  const q = (E.wq || "").trim().toLowerCase();
  const list = (owner.skins || []).filter(s => !q || (s.zh + s.en + s.paint).toLowerCase().includes(q));
  w.innerHTML = wingHead("混搭 · " + owner.zh, true);
  $("#wbody").innerHTML = searchBox("搜索皮肤名称") + '<p class="hint" style="margin:-4px 0 10px">跨武器涂装部分图案可能显示异常,属正常现象。</p><div class="wgrid">' + pickGrid(list, null, s => s.img, s => s.zh, s => s.en, s => s.color) + "</div>";
  wireSearch();
  const tk = it.kind === "gun" ? "weapon" : it.kind;
  const skEnt = it.kind === "knife" ? (E.knifeModel || it.ent) : it.ent;
  const skinLayer2 = it.kind === "glove" ? "any" : layer;
  $("[data-i]", $("#wbody")).forEach(el => el.onclick = () => { putV(skinLayer2, tk, skEnt, list[+el.dataset.i].id); toast("已混搭:" + list[+el.dataset.i].zh, "ok"); renderModal(); });
  wirePickMore($("#wbody"));
  imgWire($("#wbody"));
}
function wingKnifeTypes(w, it, layer, E) {
  const q = (E.wq || "").trim().toLowerCase();
  const cur = getV(layer, "knife_type", "knife") || getV("any", "knife_type", "knife");
  const list = CAT.knives.filter(k => !q || (k.zh + " " + k.en + " " + k.entity).toLowerCase().includes(q));
  w.innerHTML = wingHead("选择刀型", true);
  $("#wbody").innerHTML = searchBox("搜索刀型") + '<div class="wgrid">' + list.map((k, i) =>
    '<div class="pick' + (k.entity === cur ? " on" : "") + '" data-i="' + i + '"><div class="im">' + imgTag(k.entity + ".png", k.url || "") + '</div><span class="nm">' + esc(k.zh) + '</span><span class="en">' + esc((k.en || "") + " · " + k.skins.length + " 皮肤") + "</span><span class='rt'></span></div>").join("") + "</div>";
  wireSearch();
  $$("#wbody [data-i]").forEach(el => el.onclick = () => {
    const k = list[+el.dataset.i];
    putV("any", "knife_type", "knife", k.entity);   // 刀型=全局项
    E.knifeModel = k.entity; E.it = { ...E.it, ent: k.entity };
    S.edit.it = E.it;
    E.wing = { view: "skins" };
    renderModal();
  });
  imgWire($("#wbody"));
}
function searchBox(ph) {
  return '<span class="searchwrap" style="display:flex;margin-bottom:10px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="wq" placeholder="' + esc(ph) + '" value="' + esc(S.edit.wq || "") + '"></span>';
}
function wireSearch() {
  const i = $("#wq");
  if (i) i.oninput = debounce(() => { S.edit.wq = i.value; S.edit.wpage = 0; renderModal(); const ni = $("#wq"); if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); } }, 250);
}

/* ---------- 印花(贴纸):槽位 + 数值行 + 选择钻取(带年份/类型分面) ---------- */
function stkParse(v) {
  if (!v) return null;
  const parts = String(v).split("|");
  const def = String(parts[0]).replace("sticker-", "");
  return { def, wear: parts[1] != null ? +parts[1] : 0, scale: parts[2] != null ? +parts[2] : 1, rot: parts[3] != null ? +parts[3] : 0, x: parts[4] != null ? +parts[4] : 0, y: parts[5] != null ? +parts[5] : 0 };
}
const stkSer = o => "sticker-" + o.def + "|" + (o.wear || 0) + "|" + (o.scale == null || o.scale === 1 ? "" : o.scale) + "|" + (o.rot || 0) + "|" + (o.x || 0) + "|" + (o.y || 0);
function wingStickers(w, it, layer, E) {
  const ent = it.ent;
  const vals = [0, 1, 2, 3, 4].map(i => getV(layer, "sticker", ent + ":" + i));
  const slot = Math.min(E.stkSlot || 0, 4);
  const cur = stkParse(vals[slot]);
  w.innerHTML = wingHead("移动印花 · " + it.zh, true);
  const body = $("#wbody");
  const baseSkin = (skinOf(it, E.side) || {}).s;
  const baseImg = baseSkin ? baseSkin.img : (it.ent + ".png");
  const legacyNow = (skinOf(it, E.side) || {}).s;
  body.innerHTML = (baseSkin && baseSkin.legacy ? '<div class="chip" style="border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08);color:#fde68a;margin-bottom:8px">⚠ 旧模型皮肤(如 M4A4 咆哮)在 CS2 中没有贴纸锚点:贴纸属性可写入但不会显示,属游戏内容限制;换非 legacy 皮肤即恢复显示</div>' : "") +
    '<div class="stkcanvas" id="stkCv">' + imgTag(baseImg, "") + "</div>" +
    '<div class="slotsrow">' + vals.map((v, i) => {
    const p = stkParse(v);
    return '<button class="slotb' + (i === slot ? " on" : "") + '" data-slot="' + i + '">' + (p ? '<img src="' + esc(imgUrl("sticker-" + p.def + ".png", STKU.get(p.def) || "")) + '" data-n="sticker-' + p.def + '.png"' + (STKU.get(p.def) ? ' data-c="' + esc(STKU.get(p.def)) + '"' : "") + ">" : '<span class="hint" style="font-size:20px">+</span>') + "<span>槽" + (i + 1) + "</span></button>";
  }).join("") + "</div>" +
    (cur ? '<button class="mini" id="stkClear" style="margin-bottom:8px">移除本槽印花</button>' : "") +
    '<div class="numrows">' +
      '<div class="prow"><span class="lbl">印花磨损</span><div class="wz"><input type="number" id="swN" min="0" max="1" step="0.01" value="' + (cur ? cur.wear : 0) + '"><input type="range" id="swR" min="0" max="1" step="0.01" value="' + (cur ? cur.wear : 0) + '" style="flex:1;width:110px"></div></div>' +
      '<div class="prow"><span class="lbl">缩放</span><input type="number" id="ssN" min="0.5" max="2" step="0.05" value="' + (cur ? cur.scale : 1) + '"></div>' +
      '<div class="prow"><span class="lbl">角度(0~1)</span><input type="number" id="srN" min="0" max="1" step="0.01" value="' + (cur ? cur.rot : 0) + '"></div>' +
      '<div class="prow"><span class="lbl">位置 X / Y</span><div class="wz"><input type="number" id="sxN" min="-5" max="5" step="0.05" value="' + (cur ? cur.x : 0) + '"><input type="number" id="syN" min="-5" max="5" step="0.05" value="' + (cur ? cur.y : 0) + '"></div></div>' +
    "</div>" +
    '<div class="row" style="margin-top:10px"><button class="mini" id="stkReset">重置</button><button class="mini" id="stkCopy">复制到所有槽位</button><button class="mini primary" id="stkPick">选择印花…</button></div>' +
    '<p class="hint" style="margin-top:8px">槽位与数值自动保存;缩放/角度/坐标为引擎属性透传,极端值可能不生效。</p>';
  $$("#wbody .slotb", body).forEach(b => b.onclick = () => { E.stkSlot = +b.dataset.slot; renderModal(); });
  const set = patch => { const base = cur || { def: 0, wear: 0, scale: 1, rot: 0, x: 0, y: 0 }; if (!base.def) return; putV(layer, "sticker", ent + ":" + slot, stkSer(Object.assign(base, patch))); };
  const swN = $("#swN", body), swR = $("#swR", body);
  if (swN) { swN.oninput = () => swR.value = swN.value; swR.oninput = () => swN.value = swR.value; swN.onchange = () => set({ wear: +swN.value }); swR.onchange = () => set({ wear: +swR.value }); }
  ["ssN", "srN", "sxN", "syN"].forEach(id => { const el = $("#" + id, body); if (!el) return; const map = { ssN: "scale", srN: "rot", sxN: "x", syN: "y" }; el.onchange = () => set({ [map[id]]: +el.value }); });
  if ($("#stkClear", body)) $("#stkClear", body).onclick = () => { putV(layer, "sticker", ent + ":" + slot, null); renderModal(); };
  $("#stkReset", body).onclick = () => { if (cur) { putV(layer, "sticker", ent + ":" + slot, "sticker-" + cur.def); renderModal(); } };
  $("#stkCopy", body).onclick = () => {
    if (!cur) return toast("本槽还没有印花", "bad");
    for (let i = 0; i < 5; i++) if (i !== slot) putV(layer, "sticker", ent + ":" + i, getV(layer, "sticker", ent + ":" + slot));
    toast("已复制到所有槽位", "ok"); renderModal();
  };
  $("#stkPick", body).onclick = () => { E.wing = { view: "stickerPick", from: E.wing }; E.wq = ""; E.stkYear = ""; E.stkType = ""; E.wpage = 0; renderModal(); };
  imgWire(body);
  /* 画布:每个已贴印花 = 可拖拽元素;位置即数值行 X/Y 的可视化 */
  const cv = $("#stkCv", body);
  if (cv) {
    vals.forEach((v, i) => {
      const p = stkParse(v); if (!p || !p.def) return;
      const el = document.createElement("div");
      el.className = "stkitem" + (i === slot ? " on" : "");
      el.dataset.slot2 = String(i);
      const L = 50 + (p.x || 0) * 8, T = 50 - (p.y || 0) * 8;
      el.style.left = L + "%"; el.style.top = T + "%";
      el.style.transform = "translate(-50%,-50%) rotate(" + (p.rot * 360) + "deg) scale(" + (p.scale || 1) + ")";
      el.innerHTML = '<img src="' + esc(imgUrl("sticker-" + p.def + ".png", STKU.get(p.def) || "")) + '" draggable="false">';
      cv.appendChild(el);
      el.addEventListener("pointerdown", ev => {
        ev.preventDefault();
        E.stkSlot = i;
        $$(".stkitem", cv).forEach(x => x.classList.toggle("on", x === el));
        const rect = cv.getBoundingClientRect();
        const move = mv => {
          const px = Math.min(96, Math.max(4, ((mv.clientX - rect.left) / rect.width) * 100));
          const py = Math.min(96, Math.max(4, ((mv.clientY - rect.top) / rect.height) * 100));
          el.style.left = px + "%"; el.style.top = py + "%";
          el.dataset.nx = String(Math.round(((px - 50) / 8) * 20) / 20);
          el.dataset.ny = String(Math.round(((50 - py) / 8) * 20) / 20);
        };
        const up = () => {
          document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
          const nx = parseFloat(el.dataset.nx), ny = parseFloat(el.dataset.ny);
          if (!isNaN(nx) && !isNaN(ny)) {
            putV(layer, "sticker", ent + ":" + i, stkSer({ def: p.def, wear: p.wear, scale: p.scale, rot: p.rot, x: nx, y: ny }));
            const xN = $("#sxN", body), yN = $("#syN", body); if (xN) xN.value = nx; if (yN) yN.value = ny;
          }
        };
        document.addEventListener("pointermove", move); document.addEventListener("pointerup", up, { once: true });
      });
    });
    const hint = document.createElement("span");
    hint.className = "stkhint"; hint.textContent = "拖动贴纸调位置 · 缩放/角度用下方数值微调";
    cv.appendChild(hint);
  }
}
async function wingStickerPick(w, it, layer, E) {
  const slot = Math.min(E.stkSlot || 0, 4);
  w.innerHTML = wingHead("选择印花 → 槽 " + (slot + 1), true);
  const body = $("#wbody");
  body.innerHTML = searchBox("输入印花名称或 ID 搜索") + '<div id="stkFacets"></div><div class="wgrid" id="stkGrid"><div class="empty">加载中…</div></div>';
  wireSearch();
  const qs = "/api/stickers?q=" + encodeURIComponent(E.wq || "") + "&size=60&page=" + E.wpage +
    (E.stkYear > 0 ? "&year=" + E.stkYear : E.stkYear === -1 ? "&year=none" : "") + (E.stkType ? "&type=" + E.stkType : "");
  const j = await api(qs);
  if (!S.edit || S.edit.wing.view !== "stickerPick") return;
  const f = j.facets || { years: [], types: [], yearNone: 0 };
  $("#stkFacets", body).innerHTML =
    '<div class="chips"><span class="hint" style="color:var(--dim2)">年份</span><span class="chip' + (E.stkYear ? "" : " on") + '" data-y="0">全部</span>' +
    f.years.map(y => '<span class="chip' + (E.stkYear === y.y ? " on" : "") + '" data-y="' + y.y + '">' + y.y + ' <i style="background:transparent">' + y.n + "</i></span>").join("") +
    (f.yearNone ? '<span class="chip' + (E.stkYear === -1 ? " on" : "") + '" data-y="-1">无赛季 <i style="background:transparent">' + f.yearNone + "</i></span>" : "") + "</div>" +
    '<div class="chips"><span class="hint" style="color:var(--dim2)">类型</span><span class="chip' + (E.stkType ? "" : " on") + '" data-t="">全部</span>' +
    f.types.map(x => '<span class="chip' + (E.stkType === x.k ? " on" : "") + '" data-t="' + x.k + '">' + x.zh + " <i style=\"background:transparent\">" + x.n + "</i></span>").join("") + "</div>";
  const items = j.items || [];
  for (const x of items) if (x.url) STKU.set(String(x.def), x.url);
  $("#stkGrid", body).innerHTML = items.map((x, i) =>
    '<div class="pick" data-i="' + i + '" style="--rc:' + (x.color || "transparent") + '"><div class="im">' + imgTag(x.img, x.url) + '</div><span class="nm">' + esc(x.zh) + '</span><span class="en">' + esc((x.groupZh || x.group || x.typeZh || "").slice(0, 14)) + '</span><span class="rt"></span></div>').join("") +
    (j.total > (E.wpage + 1) * 60 ? '<div class="loadmore"><button class="mini" id="wmore">加载更多(命中 ' + j.total + ")</button></div>" : "");
  $$("#stkFacets [data-y]", body).forEach(c => c.onclick = () => { E.stkYear = +c.dataset.y; E.wpage = 0; wingStickerPick(w, it, layer, E); });
  $$("#stkFacets [data-t]", body).forEach(c => c.onclick = () => { E.stkType = c.dataset.t; E.wpage = 0; wingStickerPick(w, it, layer, E); });
  $$("#stkGrid [data-i]", body).forEach(el => el.onclick = () => {
    const x = items[+el.dataset.i];
    putV(layer, "sticker", it.ent + ":" + slot, "sticker-" + x.def);
    E.wing = { view: "stickers" };
    renderModal();
  });
  wirePickMore(body);
  imgWire(body);
}
function wingKeychain(w, it, layer, E) {
  const ent = it.ent;
  const cur = getV(layer, "keychain", ent);
  const q = (E.wq || "").trim().toLowerCase();
  const list = KEYCH.filter(k => !q || (k.zh + " " + k.en + " " + k.group).toLowerCase().includes(q));
  w.innerHTML = wingHead("挂件 · " + it.zh, true);
  const body = $("#wbody");
  body.innerHTML = searchBox("搜索挂件") +
    '<div class="row" style="margin-bottom:10px">' + (cur ? '<span class="tag">当前:' + esc((KEYCH.find(k => "keychain-" + k.def === String(cur)) || {}).zh || cur) + '</span><button class="mini danger" id="kcRm">移除挂件</button>' : '<span class="hint">每件物品 1 个挂件</span>') + "</div>" +
    '<div class="wgrid">' + list.map((k, i) =>
      '<div class="pick' + (String("keychain-" + k.def) === String(cur) ? " on" : "") + '" data-i="' + i + '" style="--rc:' + (k.color || "transparent") + '"><div class="im">' + imgTag(k.img, k.url) + '</div><span class="nm">' + esc(k.zh) + '</span><span class="en">' + esc((k.group || "").slice(0, 12)) + "</span><span class='rt'></span></div>").join("") + "</div>";
  wireSearch();
  if ($("#kcRm", body)) $("#kcRm", body).onclick = () => { putV(layer, "keychain", ent, null); renderModal(); };
  $$("#wbody [data-i]", body).forEach(el => el.onclick = () => { putV(layer, "keychain", ent, "keychain-" + list[+el.dataset.i].def); renderModal(); });
  imgWire(body);
}
/* ---------- 手套型号:通过皮肤行携带(model:paint);加一个型号切换弹层 ---------- */
/* ---------- 探员 / 音乐盒:双列弹层(左列表右预览,参考站同款) ---------- */
function openSimpleModal(kind) {
  const side = kind === "ct" || kind === "t" ? kind : null;
  const list = side ? CAT.agents.filter(a2 => a2.team === "both" || a2.team === side) : CAT.music;
  const cur = side ? getV("any", "agent", side) : String(getV("any", "music_kit", "music") || "");
  let ovl = $("#ovl");
  if (!ovl) { ovl = document.createElement("div"); ovl.className = "ovl"; ovl.id = "ovl"; ovl.innerHTML = '<div class="mask"></div><div class="modal" id="modal" style="width:min(96vw,640px)"></div>'; document.body.appendChild(ovl); ovl.querySelector(".mask").onclick = closeModal; closeModalOnEsc(); }
  const modal = $("#modal");
  const previewOf = x => x ? (side ? imgTag(x.img, x.url) : imgTag(x.img, "")) : "";
  const render = q => {
    const f = list.filter(x => !q || ((x.zh || "") + " " + (x.en || "")).toLowerCase().includes(q.toLowerCase()));
    const sel = side ? f.find(x => x.id === cur) : f.find(x => String(x.kit) === cur);
    modal.innerHTML = '<div class="dual"><div class="lcol"><div class="whead" style="border:0"><h4>' + (side ? (side === "ct" ? "CT 探员" : "T 探员") + " " + f.length : "音乐盒 " + f.length) + '</h4><button class="mclose" id="mx2" style="position:static">✕</button></div>' +
      '<div class="wbody custom-scrollbar"><span class="searchwrap" style="display:flex;margin-bottom:10px"><input id="sq" placeholder="搜索名称" value="' + esc(q || "") + '"></span>' +
      (side ? '<button class="mixbtn" data-none="1">清除探员(默认模型)</button>' : '<button class="mixbtn" data-none="1">不使用音乐盒</button>') +
      '<div class="wgrid">' + f.map((x, i) =>
        '<div class="pick' + (String(side ? x.id : x.kit) === cur ? " on" : "") + '" data-i="' + i + '"><div class="im" style="height:86px">' + previewOf(x) + '</div><span class="nm">' + esc(x.zh) + "</span></div>").join("") + "</div></div></div>" +
      '<div class="rcol" id="pvcol"><div class="pvbox" id="pvImg">' + (sel ? previewOf(sel) : '<span class="hint" style="color:rgba(255,255,255,.3)">选择物品查看预览</span>') + "</div>" +
      '<div style="text-align:center"><div style="font-weight:700;font-size:14px" id="pvNm">' + esc(sel ? sel.zh : "—") + '</div><div style="font-size:11px;color:rgba(255,255,255,.45)" id="pvEn">' + esc(sel ? sel.en || "" : "") + "</div>" +
      '<div style="margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap" id="pvTags">' + (sel ? (side ? '<span class="tag">' + (sel.team === "ct" ? "CT" : sel.team === "t" ? "T" : "双阵营") + "</span>" + (sel.group ? '<span class="tag">' + esc(sel.group.slice(0, 14)) + "</span>" : "") : '<span class="tag">编号 ' + esc(String(sel.kit)) + "</span>") : "") + "</div>" +
      '<div style="font-size:11px;color:rgba(255,255,255,.4);margin-top:8px" id="pvState">' + (sel ? (String(side ? sel.id : sel.kit) === cur ? "● 使用中" : "点击左侧物品即可选中") : "") + "</div></div></div></div>";
    imgWire(modal);
    $("#mx2").onclick = closeModal;
    const sq = $("#sq", modal);
    sq.oninput = debounce(() => { const c = $("#pvcol") && null; render(sq.value); const ni = $("#sq", modal); if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); } }, 200);
    $$("[data-none]", modal).forEach(b => b.onclick = () => {
      if (side) putV("any", "agent", side, null); else putV("any", "music_kit", "music", null);
      closeModal(); renderBagSummary(); toast("已恢复默认", "ok");
    });
    const showPv = x => {
      $("#pvImg").innerHTML = previewOf(x);
      $("#pvNm").textContent = x.zh; $("#pvEn").textContent = x.en || "";
      $("#pvTags").innerHTML = side ? '<span class="tag">' + (x.team === "ct" ? "CT" : x.team === "t" ? "T" : "双阵营") + "</span>" + (x.group ? '<span class="tag">' + esc(x.group.slice(0, 14)) + "</span>" : "") : '<span class="tag">编号 ' + x.kit + "</span>";
      imgWire($("#pvImg"));
    };
    $$(".pick[data-i]", modal).forEach(el => {
      const x = f[+el.dataset.i];
      el.onmouseenter = () => showPv(x);
      el.onclick = () => {
        if (side) putV("any", "agent", side, x.id); else putV("any", "music_kit", "music", String(x.kit));
        closeModal(); renderBagSummary(); toast(side ? "探员已更新" : "音乐盒已更新(下局 MVP 音乐生效)", "ok");
      };
    });
  };
  render("");
}
/* ---------- 混搭搜索(前端钻取) ---------- */


/* ============ 用户管理(三级权限;判断点全部走 isAdm/isSuper) ============ */
const ROLE_ZH = { user: "普通用户", admin: "管理员", superadmin: "最高管理员" };
const ROLE_CLS = { user: "", admin: "ad-role-admin", superadmin: "ad-role-super" };
async function adminView() {
  mount("t-admin");
  const load = async () => {
    const q = ($("#adq").value || "").trim();
    const j = await api("/api/admin/users" + (q ? "?q=" + encodeURIComponent(q) : ""));
    if (!j.ok) { $("#adBody").innerHTML = '<p class="hint">无权限或加载失败</p>'; return; }
    const st = j.stats || {};
    $("#adCount").innerHTML =
      '<span class="adtag">共 ' + (st.total || 0) + " 个账号</span>" +
      '<span class="adtag">已绑定 ' + (st.bound || 0) + "</span>" +
      '<span class="adtag">管理员 ' + ((st.admins || 0) + (st.superadmins || 0)) + "</span>" +
      (st.superadmins ? '<span class="adtag super">最高管理员 ' + st.superadmins + "</span>" : "") +
      (st.banned ? '<span class="adtag bad">已封禁 ' + st.banned + "</span>" : "");
    const meRole = (j.me || {}).role || "admin";
    $("#adBody").innerHTML = "<table><tr><th>ID</th><th>账号</th><th>Steam</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr>" +
      j.users.map(u => {
        const can = u.manageable;
        const roleTag = '<span class="tag ' + (ROLE_CLS[u.role] || "") + '">' + (ROLE_ZH[u.role] || u.role) + "</span>";
        let roleSel = "";
        if (can) {
          const opts = ["user", "admin"].concat(meRole === "superadmin" ? ["superadmin"] : [])
            .map(r => '<option value="' + r + '"' + (r === u.role ? " selected" : "") + ">" + ROLE_ZH[r] + "</option>").join("");
          roleSel = '<select class="mini" data-role="' + u.id + '">' + opts + "</select>";
        } else roleSel = '<span class="hint">' + (u.id === j.me.uid ? "本人" : "—") + "</span>";
        const steamCell = u.steamids
          ? '<span class="hint" style="max-width:170px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(u.steamids) + '">' + esc(u.personas || u.steamids) + "</span>"
          : '<span class="hint">未绑定</span>';
        return "<tr>" +
          "<td>" + u.id + "</td>" +
          "<td><b>" + esc(u.username) + "</b><br><span class='hint'>" + esc(u.email || "-") + "</span></td>" +
          "<td>" + steamCell + "</td>" +
          "<td>" + roleTag + "<br>" + roleSel + "</td>" +
          "<td>" + (u.status === "banned" ? '<span class="tag" style="color:var(--bad)">已封禁</span>' : '<span class="tag" style="color:var(--ok)">正常</span>') + "</td>" +
          "<td class='hint'>" + esc((u.last_login_at || "").slice(0, 16) || "从未") + "</td>" +
          "<td>" +
            (can ? '<button class="mini" data-pw="' + u.id + '" data-nm="' + esc(u.username) + '">重置密码</button> ' : "") +
            (can ? '<button class="mini ' + (u.status === "banned" ? "" : "danger") + '" data-ban="' + u.id + '" data-cur="' + u.status + '">' + (u.status === "banned" ? "解封" : "封禁") + "</button> " : "") +
            (can && meRole === "superadmin" ? '<button class="mini danger" data-del="' + u.id + '" data-nm="' + esc(u.username) + '">删除</button>' : "") +
          "</td></tr>";
      }).join("") + "</table>";
    const msg = async (r, okText) => {
      if (r.ok) { toast(okText, "ok"); load(); return; }
      const m = { self: "不能修改自己的角色/状态", higher_or_equal: "不能操作同级或更高级别的账号", need_superadmin: "需要最高管理员权限", not_found: "账号不存在", bad_password: "密码至少 8 位" };
      toast(m[r.error] || ("操作失败:" + r.error), "bad");
    };
    $$("#adBody [data-role]").forEach(sel => sel.onchange = async () => {
      const r = await api("/api/admin/role", { method: "POST", body: { id: +sel.dataset.role, role: sel.value } });
      await msg(r, "角色已更新为 " + (ROLE_ZH[sel.value] || sel.value));
    });
    $$("#adBody [data-ban]").forEach(b => b.onclick = async () => {
      const id = +b.dataset.ban, cur = b.dataset.cur;
      const next = cur === "banned" ? "active" : "banned";
      if (next === "banned" && !confirm("确定封禁该账号?被封禁后无法登录和使用面板。")) return;
      const r = await api("/api/admin/status", { method: "POST", body: { id, status: next } });
      await msg(r, next === "banned" ? "已封禁" : "已解封");
    });
    $$("#adBody [data-pw]").forEach(b => b.onclick = async () => {
      const id = +b.dataset.pw, nm = b.dataset.nm;
      const np = prompt("为「" + nm + "」设置新密码(至少 8 位):");
      if (np == null) return;
      if (np.length < 8) return toast("密码至少 8 位", "bad");
      const r = await api("/api/admin/password", { method: "POST", body: { id, newPassword: np } });
      await msg(r, "已重置「" + nm + "」的密码");
    });
    $$("#adBody [data-del]").forEach(b => b.onclick = async () => {
      const id = +b.dataset.del, nm = b.dataset.nm;
      if (!confirm("确定删除账号「" + nm + "」?\n将同时解除其 Steam 绑定,该操作不可恢复!")) return;
      const r = await api("/api/admin/delete", { method: "POST", body: { id } });
      await msg(r, "已删除「" + nm + "」");
    });
  };
  $("#adGo").onclick = load;
  $("#adq").onkeydown = e => { if (e.key === "Enter") load(); };
  await load();
}

/* ============ 服务器状态卡(A2S) ============ */
function copyText(txt, okMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => toast(okMsg || ("已复制:" + txt), "ok")).catch(() => fallbackCopy(txt, okMsg));
  } else fallbackCopy(txt, okMsg);
}
function fallbackCopy(txt, okMsg) {
  try {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let done = false;
    try { done = document.execCommand("copy"); } catch {}
    ta.remove();
    if (done) toast(okMsg || ("已复制:" + txt), "ok");
    else toast("请手动复制:" + txt);
  } catch { toast("请手动复制:" + txt); }
}
/* ===== 服务器卡片(参考 zscsgo.com/room 同款:全幅地图背景 + 悬浮信息层 + 网格/列表)===== */
let SRV_DATA = [];
let SRV_Q = "";
let SRV_VIEW = localStorage.getItem("howl_srv_view") || "";
function mapAssets(map) {
  const m = String(map || "").replace(/_fps$/, "") || "de_mirage";
  return { bg: "/img/maps/bg-cs2-" + m + ".webp", icon: "/img/maps/map_icon_" + m + ".png" };
}
function svgI(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">' + p + "</svg>"; }
const SRV_IC = {
  copy: svgI('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  check: svgI('<path d="M20 6 9 17l-5-5"/>'),
  users: svgI('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'),
  hash: svgI('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'),
  grid: svgI('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  list: svgI('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  refresh: svgI('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
};
function srvState(s) {
  const full = s.online && Number(s.players) >= Number(s.maxPlayers);
  const empty = s.online && Number(s.players) === 0;
  return full ? "房间已满" : empty ? "空房间" : "剩余 " + (Number(s.maxPlayers) - Number(s.players)) + " 个空位";
}
function srvCardHTML(s) {
  const up = !!s.online;
  const hi = String(s.map || "").includes("_fps");
  const A = mapAssets(s.map);
  const addr = s.addr || (s.host + ":" + s.port);
  const cmd = s.connectCmd || ("connect " + addr);
  return '<div class="srvcard' + (up ? "" : " off") + '" data-srv="' + esc(s.id) + '" title="' + esc(s.name || s.label) + '">' +
    '<div class="scbg"><img src="' + A.bg + '" alt="" onerror="this.onerror=null;this.src=&quot;' + A.icon + '&quot;"><div class="sgrad"></div></div>' +
    '<span class="cor tl"></span><span class="cor tr"></span><span class="cor bl"></span><span class="cor br"></span>' +
    '<div class="stop"><div class="sname">' + esc(s.label) + '</div><div class="ssub"><span>' + esc(up ? (s.mapZh || s.map || "—") : "离线") + '</span>' +
      (hi ? '<span class="cdot"></span><span class="hifps" title="精简贴图地图,能提高帧数">高帧</span>' : "") +
      (up ? '<span class="cdot"></span><span class="mchip">' + esc((s.map || "").replace(/_fps$/, "")) + "</span>" : "") + "</div></div>" +
    '<span class="sbadge ' + (up ? "on" : "off") + '"><i></i><span>' + (up ? "Online" : "Offline") + "</span>" +
      (up ? '<b class="mono">' + Number(s.players) + "/" + Number(s.maxPlayers) + "</b>" : "") + "</span>" +
    '<div class="sovl">' +
      '<div class="spills">' +
        '<span class="spill"><span class="ic">' + SRV_IC.users + "</span><b class=\"mono\">" + (up ? Number(s.players) + "/" + Number(s.maxPlayers) : "-") + "</b></span>" +
        '<span class="spill"><span class="ic">' + SRV_IC.hash + '</span><span class="mono">' + esc(addr) + "</span></span>" +
      "</div>" +
      '<div class="sslots">' + (up ? srvState(s) : "服务器离线,无法加入") + "</div>" +
      '<div class="sacts">' +
        '<button class="scpy" data-copy="' + esc(cmd) + '" title="复制连接指令">' + SRV_IC.copy + "</button>" +
        '<a class="sjoin" href="' + esc(s.join || "#") + '" data-join="' + esc(cmd) + '"' + (s.join ? "" : ' onclick="return false"') + '>加入服务器</a>' +
      "</div>" +
    "</div></div>";
}
function srvRowHTML(s) {
  const up = !!s.online;
  const A = mapAssets(s.map);
  const addr = s.addr || (s.host + ":" + s.port);
  const cmd = s.connectCmd || ("connect " + addr);
  return '<div class="srvrow' + (up ? "" : " off") + '" data-srv="' + esc(s.id) + '">' +
    '<span class="ric"><img src="' + A.icon + '" onerror="this.onerror=null;this.style.opacity=.25"></span>' +
    '<div class="rn"><b>' + esc(s.label) + '</b><span>' + esc(up ? (s.mapZh || s.map) : "离线") + (String(s.map||"").includes("_fps") ? " · 高帧" : "") + "</span></div>" +
    '<span class="rpill mono"><span class="ic">' + SRV_IC.users + "</span>" + (up ? Number(s.players) + "/" + Number(s.maxPlayers) : "-") + "</span>" +
    '<span class="rpill mono">' + esc(addr) + "</span>" +
    '<span class="sbadge sm ' + (up ? "on" : "off") + '"><i></i><span>' + (up ? "Online" : "Offline") + "</span></span>" +
    '<div class="sacts"><button class="scpy" data-copy="' + esc(cmd) + '" title="复制连接指令">' + SRV_IC.copy + "</button>" +
    '<a class="sjoin sm" href="' + esc(s.join || "#") + '" data-join="' + esc(cmd) + '"' + (s.join ? "" : ' onclick="return false"') + '>加入</a></div></div>';
}
function srvFiltered() {
  const q = SRV_Q.trim().toLowerCase();
  if (!q) return SRV_DATA;
  return SRV_DATA.filter(s => ((s.label || "") + " " + (s.map || "") + " " + (s.mapZh || "") + " " + (s.addr || s.host + ":" + s.port)).toLowerCase().includes(q));
}
function srvRender() {
  const box = document.getElementById("srvbar"); if (!box) return;
  const list = srvFiltered();
  const onlineN = SRV_DATA.filter(s => s.online).length;
  box.className = "srvbar " + (SRV_VIEW === "list" ? "listmode" : "");
  box.innerHTML =
    '<div class="srvbar-hd">' +
      '<div class="srvtitle"><span class="tip">' + (SRV_DATA.length ? "已发现 " + onlineN + " 个在线服务器" : "暂无服务器") + "</span></div>" +
      '<div class="srvtools">' +
        '<span class="searchwrap"><input id="srvQ" placeholder="搜索服务器 / 地图 / IP" value="' + esc(SRV_Q) + '"></span>' +
        '<button class="srvtool" id="srvRefresh" title="刷新服务器列表">' + SRV_IC.refresh + "</button>" +
        '<span class="srvseg">' +
          '<button class="srvtool' + (SRV_VIEW !== "list" ? " on" : "") + '" id="srvGrid" title="网格模式">' + SRV_IC.grid + "</button>" +
          '<button class="srvtool' + (SRV_VIEW === "list" ? " on" : "") + '" id="srvList" title="列表模式">' + SRV_IC.list + "</button>" +
        "</span>" +
      "</div>" +
    "</div>" +
    (list.length ? '<div class="srvgrid">' + list.map(SRV_VIEW === "list" ? srvRowHTML : srvCardHTML).join("") + "</div>"
      : '<div class="srvload">' + (SRV_DATA.length ? "没有符合条件的服务器" : "暂无服务器配置") + "</div>") +
    '<div class="livebox" id="liveBox"></div>';
  bindSrvEvents();
  loadSrvStats();
}
function bindSrvEvents() {
  const box = document.getElementById("srvbar"); if (!box) return;
  const qi = document.getElementById("srvQ");
  if (qi) { qi.oninput = debounce(() => { SRV_Q = qi.value; const c = document.getElementById("srvbar"); srvRender(); const n = document.getElementById("srvQ"); if (n) { n.focus(); const v = n.value; n.setSelectionRange(v.length, v.length); } }, 250); }
  const rf = document.getElementById("srvRefresh");
  if (rf) rf.onclick = () => { rf.classList.add("spin"); loadServers(box).finally(() => setTimeout(() => rf.classList.remove("spin"), 500)); };
  const g = document.getElementById("srvGrid"), l = document.getElementById("srvList");
  if (g) g.onclick = () => { SRV_VIEW = "grid"; localStorage.setItem("howl_srv_view", "grid"); srvRender(); };
  if (l) l.onclick = () => { SRV_VIEW = "list"; localStorage.setItem("howl_srv_view", "list"); srvRender(); };
  box.querySelectorAll("[data-copy]").forEach(b => b.onclick = e => {
    e.stopPropagation();
    copyText(b.dataset.copy, "已复制连接指令,可在游戏控制台粘贴:" + b.dataset.copy);
    b.innerHTML = SRV_IC.check; b.classList.add("done");
    setTimeout(() => { b.innerHTML = SRV_IC.copy; b.classList.remove("done"); }, 1400);
  });
  box.querySelectorAll("[data-join]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    if (!b.getAttribute("href") || b.getAttribute("href") === "#") { e.preventDefault(); toast("该服务器地址不可用", "bad"); return; }
    // 原生 a[href^=steam://] 由浏览器直接交给 Steam;1.6 秒后页面仍在前台视为未唤起,给兜底指引
      if (!document.hidden) { toast("Steam 若无响应:请在游戏控制台输入「" + b.dataset.join + "」(已为你复制)", "ok", 5200); copyText(b.dataset.join, "已复制:" + b.dataset.join); }
  }));
}
async function loadSrvStats() {
  const el = document.getElementById("liveBox"); if (!el) return;
  let j = null;
  try { j = await api("/api/stats"); } catch {}
  if (!j || !j.ok || !j.hours || !j.hours.length) { el.innerHTML = '<div class="livehd"><div><div class="livemon">LIVE TELEMETRY</div><div class="livetzh">实时在线人数</div></div><span class="live24">last 24h</span></div><div class="livetip">采集中,稍后显示(每小时一个柱)</div>'; return; }
  const hours = j.hours.slice(-24);
  const ids = SRV_DATA.map(s => s.addr || (s.host + ":" + s.port));
  const colors = ["#4d8aff", "#34d399", "#f59e0b", "#c084fc", "#f472b6"];
  const maxT = Math.max(1, ...hours.map(h => h.total));
  el.innerHTML = '<div class="livehd"><div><div class="livemon">Live Telemetry</div><div class="livetzh">实时在线人数</div></div>' +
    '<div class="livelg">' + SRV_DATA.map((s, i) => '<span><i style="background:' + colors[i % 5] + '"></i>' + esc(s.label) + "</span>").join("") + "</div></div>" +
    '<div class="livebars">' + hours.map(h => {
      const lab = h.k.slice(8, 10) + ':00 · ' + h.total + ' 人在线';
      let bars = '';
      ids.forEach((id, ix) => { const v = (h.per || {})[id] || 0; bars += '<span style="height:' + Math.round(v / maxT * 100) + '%;background:' + colors[ix % 5] + '"></span>'; });
      return '<div class="lbar" title="' + esc(lab) + '">' + bars + '</div>';
    }).join('') + '</div>';
}
function firstSrvDialog() {
  if (SRV_VIEW) return;
  const box = document.createElement("div"); box.className = "ovl"; box.id = "ovl";
  box.innerHTML = '<div class="mask"></div><div class="modal" style="width:min(92vw,520px)"><div class="mhead"><h4>选择服务器列表展示方式</h4><button class="mclose" id="dvX">✕</button></div>' +
    '<p class="hint" style="padding:0 20px">选择你偏好的服务器显示模式,之后可随时在列表右上角切换</p><div class="dvopts">' +
    '<button class="dopt" data-v="grid"><span class="dvic">' + SRV_IC.grid + '</span><b>网格模式</b><span class="hint">以卡片形式展示服务器,更加直观美观</span></button>' +
    '<button class="dopt" data-v="list"><span class="dvic">' + SRV_IC.list + '</span><b>列表模式</b><span class="hint">以列表形式展示,信息密度更高</span></button></div></div>';
  document.body.appendChild(box);
  const close = () => box.remove();
  box.querySelector(".mask").onclick = close;
  document.getElementById("dvX").onclick = close;
  box.querySelectorAll("[data-v]").forEach(b => b.onclick = () => { SRV_VIEW = b.dataset.v; localStorage.setItem("howl_srv_view", SRV_VIEW); close(); srvRender(); });
}
function serversView() {
  const v = $("#view"); v.innerHTML = "";
  const head = document.createElement("div");
  head.className = "pagehead";
  head.innerHTML = '<div class="eyebrow">社区</div><h1>服务器<em>状态</em></h1>' +
    '<div class="desc">实时 A2S 查询在线状态与地图,支持一键加入与复制连接指令;悬停卡片查看详细信息。</div><div class="wm">LIVE</div>';
  v.appendChild(head);
  const srv = document.createElement("section"); srv.id = "srvbar"; srv.className = "srvbar"; v.appendChild(srv);
  loadServers(srv);
  S.srvTimer = setInterval(() => { if (document.getElementById("srvbar")) loadServers(document.getElementById("srvbar")); }, 15000);
}
async function loadServers(box) {
  if (!box) return;
  if (!SRV_DATA.length) box.innerHTML = '<div class="srvload">正在获取服务器状态…</div>';
  try {
    const j = await api("/api/servers");
    SRV_DATA = (j.ok && j.servers) || [];
    srvRender();
  } catch { box.innerHTML = '<div class="srvload">服务器状态获取失败</div>'; }
}

/* ============ 启动 ============ */
$("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); ME = null; refreshNav(); location.hash = "#/skins"; nav(); };
(async () => {
  try { const m = await api("/api/meta"); if (m.ok) { S.meta = m; renderNotice(); } } catch { }
  await loadMe();
  nav();
  setInterval(async () => {
    try {
      const m = await api("/api/meta");
      if (!m.ok) return;
      const changed = S.meta && m.version && S.meta.version && m.version !== S.meta.version;
      S.meta = m; renderNotice();
      if (changed) {
        CAT = null;
        toast("换肤数据已更新,正在重载目录…", "ok");
        if (ME && hash() === "skins") nav();
      }
    } catch { }
  }, 60000);
})();
