"use strict";
/* Howl 目录构建器:直接读 CSGO-API(ByMykel)原始 JSON(zh-CN + en),产出 Web 前端所需的分组结构。
 * 归一化规则与插件端 Catalog.cs 完全一致:
 *   · 刀的 sfui_wpnhud_* / weapon_* 双份条目按 def_index 归一;
 *   · 过滤宙斯/道具/裸刀/无皮肤手套;音乐盒按 def 去重(StatTrak™ 合并);
 *   · 中英名分别取自 en/zh;图片文件名约定 = <实体>-<paint>.png 等(与本地素材库/参考站兼容)。 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const SKIP = new Set(["weapon_taser", "weapon_healthshot", "t_gloves", "ct_gloves", "weapon_knife", "weapon_knife_t", "weapon_c4"]);
const SNIPERS = new Set(["weapon_awp", "weapon_ssg08", "weapon_scar20", "weapon_g3sg1"]);
const CATS = { csgo_inventory_weapon_category_rifles: "rifles", csgo_inventory_weapon_category_pistols: "pistols", csgo_inventory_weapon_category_smgs: "smgs", csgo_inventory_weapon_category_heavy: "heavy" };
const TEAM_DEFAULT = {
  weapon_ak47: "t", weapon_galilar: "t", weapon_ssg08: "t", weapon_g3sg1: "t", weapon_mac10: "t", weapon_tec9: "t", weapon_glock: "t", weapon_sawedoff: "t",
  weapon_m4a1: "ct", weapon_m4a1_silencer: "ct", weapon_aug: "ct", weapon_scar20: "ct", weapon_famas: "ct", weapon_hkp2000: "ct", weapon_usp_silencer: "ct", weapon_fiveseven: "ct", weapon_mag7: "ct", weapon_mp9: "ct",
};
const RAR_ZH = { common: "消费级", uncommon: "工业级", rare: "军规级", mythical: "受限", legendary: "保密", ancient: "隐秘", contraband: "违禁" };
const RAR_COLOR = { common: "#b0c3d9", uncommon: "#5e98d9", rare: "#4b69ff", mythical: "#8847ff", legendary: "#d32ce6", ancient: "#eb4b4b", contraband: "#e4ae39" };
const WEAR_TIERS = [
  { zh: "崭新出厂", key: "FN", max: 0.07, v: 0.01, color: "#22c55e" },
  { zh: "略有磨损", key: "MW", max: 0.15, v: 0.10, color: "#84cc16" },
  { zh: "久经沙场", key: "FT", max: 0.38, v: 0.25, color: "#eab308" },
  { zh: "破损不堪", key: "WW", max: 0.45, v: 0.40, color: "#f97316" },
  { zh: "战痕累累", key: "BS", max: 1.0, v: 0.65, color: "#ef4444" },
];

const num = v => (typeof v === "string" ? (v.match(/^-?\d+(\.\d+)?$/) ? Number(v) : NaN) : (typeof v === "number" ? v : NaN));
const stripName = n => { let s = String(n || "").trim(); if (s.startsWith("★")) s = s.slice(1).trim(); const i = s.indexOf("|"); return (i >= 0 ? s.slice(i + 1) : s).trim(); };
const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
function rarityKey(id) { return String(id || "").replace("rarity_", "").replace("_weapon", "").replace("_character", ""); }

function build(dataDir) {
  const zh = path.join(dataDir, "zh-CN"), en = path.join(dataDir, "en");
  const enName = f => (fs.existsSync(path.join(en, f)) ? read(path.join(en, f)) : null);

  // ---- base_weapons ----
  const bwZh = read(path.join(zh, "base_weapons.json"));
  const bwEn = enName("base_weapons.json") || [];
  const enByDef = new Map(bwEn.map(w => [num(w.def_index), w.name]));
  const knifeByDef = new Map(), gloveBase = new Map(), gunBase = [];
  for (const w of bwZh) {
    const id = String(w.id || "").replace(/^base_weapon-/, "");
    const def = num(w.def_index);
    const catId = (w.category && w.category.id) || "";
    if (SKIP.has(id)) continue;
    if (CATS[catId]) gunBase.push({ entity: id, def, zh: w.name, catKey: CATS[catId] });
    else if (catId.includes("melee") || id.startsWith("weapon_knife") || id === "weapon_bayonet") knifeByDef.set(def, { entity: id, zh: w.name, img: w.image || "" });
    else if (catId.includes("gloves") || id.endsWith("_gloves") || id === "leather_handwraps") gloveBase.set(id, { def, zh: w.name });
  }
  const normKnife = (wid, wdef) => {
    if (!wid.startsWith("sfui_") && /^(weapon_|.*_gloves$|leather_handwraps)/.test(wid)) return wid;
    const k = knifeByDef.get(wdef); return k ? k.entity : wid;
  };

  // ---- skins ----
  const skinsZh = read(path.join(zh, "skins.json"));
  const skinsEn = enName("skins.json") || [];
  const enSkin = new Map();
  for (const s of skinsEn) enSkin.set(normKnife((s.weapon && s.weapon.id) || "", num(s.weapon && s.weapon.weapon_id)) + ":" + num(s.paint_index), stripName(s.name));

  // 皮肤 image URL 映射(std:paint → steam CDN),刀图必用(素材库缺刀)
  const skinImgUrl = new Map();
  const baseGunImg = new Map(gunBase.map(g => [g.entity, (bwZh.find(w => w.id === "base_weapon-" + g.entity) || {}).image || ""]));
  const guns = new Map(gunBase.map(g => [g.entity, { entity: g.entity, def: g.def, zh: g.zh, en: enByDef.get(g.def) || g.entity, cat: g.catKey, sniper: SNIPERS.has(g.entity), ct: true, t: true, url: baseGunImg.get(g.entity) || "", skins: [] }]));
  for (const g of guns.values()) { const d = TEAM_DEFAULT[g.entity]; if (d === "ct") g.t = false; else if (d === "t") g.ct = false; }
  const knives = new Map(), gloves = new Map(), seen = new Set(), allSkins = [];
  for (const s of skinsZh) {
    const wid = (s.weapon && s.weapon.id) || "";
    const wdef = num(s.weapon && s.weapon.weapon_id);
    const paint = num(s.paint_index);
    const catId = (s.category && s.category.id) || "";
    if (!wid || !(paint > 0) || SKIP.has(wid)) continue;
    const std = normKnife(wid, wdef);
    if (SKIP.has(std)) continue;
    const team = (s.team && s.team.id) || "";
    const key = std + ":" + paint;
    if (seen.has(key)) continue;
    const rk = rarityKey(s.rarity && s.rarity.id);
    const sd = {
      id: key, paint, zh: stripName(s.name) || ((s.pattern && s.pattern.name) || stripName(s.name)),
      en: enSkin.get(key) || stripName(s.name),
      rar: rk, rarZh: (s.rarity && s.rarity.name) || (RAR_ZH[rk] || ""), color: (s.rarity && s.rarity.color) || RAR_COLOR[rk] || "#3a4250",
      legacy: !!s.legacy_model, minF: num(s.min_float), maxF: num(s.max_float),
      img: std + "-" + paint + ".png",
      url: s.image || "",
    };
    seen.add(key); allSkins.push(sd);
    if (catId.includes("melee") || knifeByDef.has(wdef) || (std.startsWith("weapon_knife") && std !== "weapon_knife")) {
      if (!knives.has(std)) knives.set(std, { entity: std, def: wdef, zh: (knifeByDef.get(wdef) || {}).zh || std, en: enByDef.get(wdef) || std, url: (knifeByDef.get(wdef) || {}).img || "", baseImg: std + ".png", skins: [] });
      knives.get(std).skins.push(sd);
    } else if (gloveBase.has(std)) {
      if (!gloves.has(std)) gloves.set(std, { model: std, def: gloveBase.get(std).def, zh: gloveBase.get(std).zh, en: enByDef.get(gloveBase.get(std).def) || std, skins: [] });
      gloves.get(std).skins.push(sd);
    } else if (guns.has(std)) {
      const g = guns.get(std);
      g.skins.push(sd);
      if (team === "terrorists") g.t = true; else if (team === "counter-terrorists") g.ct = true;
    }
  }
  for (const g of guns.values()) g.skins.sort((a, b) => a.paint - b.paint);
  for (const k of knives.values()) k.skins.sort((a, b) => a.paint - b.paint);
  for (const gl of gloves.values()) gl.skins.sort((a, b) => a.paint - b.paint);

  // ---- agents ----
  const agEn = new Map((enName("agents.json") || []).map(a => [num(a.def_index), a.name]));
  const agents = (read(path.join(zh, "agents.json"))).filter(a => a.model_player).map(a => ({
    id: "agent-" + num(a.def_index), def: num(a.def_index), zh: a.name, en: agEn.get(num(a.def_index)) || a.name,
    team: a.team && String(a.team.id).includes("counter") ? "ct" : (a.team && String(a.team.id).includes("terrorist") ? "t" : "both"),
    model: a.model_player, img: "agent-" + num(a.def_index) + ".png", url: a.image || "",
  })).sort((x, y) => x.def - y.def);

  // ---- music(去重,优先普版) ----
  const mkEn = new Map((enName("music_kits.json") || []).map(m => [num(m.def_index), m.name]));
  const byKit = new Map();
  for (const m of read(path.join(zh, "music_kits.json"))) {
    const kit = num(m.def_index);
    const zhName = String(m.name || "");
    const enM = mkEn.get(kit) || zhName;
    const st = /^StatTrak/.test(zhName) || /^StatTrak/.test(enM);
    const entry = { kit, zh: zhName.replace(/^StatTrak™?\s?/, ""), en: enM.replace(/^StatTrak™?\s?/, ""), img: "music-" + kit + ".png", url: m.image || "" };
    if (!byKit.get(kit) || !st) byKit.set(kit, entry);
  }
  const music = [...byKit.values()].sort((a, b) => a.kit - b.kit);

  // ---- stickers ----
  const stEn = new Map((enName("stickers.json") || []).map(x => [num(x.def_index), x.name]));
  const TYPE_RULES = [["gold", /\(Gold\)/i, "金色"], ["holo", /\(Holo\)/i, "全息"], ["foil", /\(Foil\)/i, "闪亮"], ["glitter", /\(Glitter\)/i, "闪耀"], ["lenticular", /\(Lenticular\)/i, "3D 立体"]];
  let stickers = [];
  const stFile = path.join(zh, "stickers.json");
  if (fs.existsSync(stFile)) stickers = read(stFile).map(x => {
    const def = num(x.def_index);
    const enN = stEn.get(def) || x.name || "";
    const group = ((x.collections && x.collections[0] && x.collections[0].name) || (x.crates && x.crates[0] && x.crates[0].name) || "");
    const capsule = (x.crates && x.crates[0] && x.crates[0].name) || "";
    const ym = (group + " " + capsule + " " + enN).match(/(19|20)\d{2}/);
    let year = ym ? +ym[0] : 0; if (year < 2013 || year > 2028) year = 0;
    let tk = "normal", tz = "普通";
    for (const [k, re, zh2] of TYPE_RULES) if (re.test(enN)) { tk = k; tz = zh2; break; }
    return {
      id: "sticker-" + def, def, zh: x.name || ("sticker-" + def), en: enN,
      group, capsule, year, type: tk, typeZh: tz,
      rar: rarityKey(x.rarity && x.rarity.id), color: (x.rarity && x.rarity.color) || "#4b69ff",
      img: "sticker-" + def + ".png", url: x.image || "",
    };
  });

  // ---- keychains ----
  const kcEn = new Map((enName("keychains.json") || []).map(x => [num(x.def_index), x.name]));
  const keychains = (read(path.join(zh, "keychains.json"))).map(x => ({
    id: "keychain-" + num(x.def_index), def: num(x.def_index), zh: x.name, en: kcEn.get(num(x.def_index)) || x.name,
    group: ((x.collections && x.collections[0] && x.collections[0].name) || ""),
    rar: rarityKey(x.rarity && x.rarity.id), color: (x.rarity && x.rarity.color) || "#4b69ff",
    img: "keychain-" + num(x.def_index) + ".png", url: x.image || "",
  }));

  // ---- 武器基础图与原皮肤图 URL 回填(供图片增量下载) ----
  const baseImgUrl = new Map(gunBase.map(g => [g.entity, (bwZh.find(w => w.id === "base_weapon-" + g.entity) || {}).image || ""]));
  for (const g of guns.values()) g.url = baseImgUrl.get(g.entity) || "";
  const skinUrl = new Map();
  for (const s of skinsZh) skinUrl.set(normKnife((s.weapon && s.weapon.id) || "", num(s.weapon && s.weapon.weapon_id)) + ":" + num(s.paint_index), s.image || "");
  for (const sd of allSkins) sd.url = skinUrl.get(sd.id) || "";
  const baseImgs = [
    ...gunBase.map(g => ({ file: g.entity + ".png", url: baseImgUrl.get(g.entity) || "" })),
    ...[...knifeByDef.values()].map(k => ({ file: k.entity + ".png", url: k.img || "" })),
  ];

  // ---- 指纹(与插件端同口径) ----
  const sha = crypto.createHash("sha256");
  for (const f of ["zh-CN/skins.json", "en/skins.json", "zh-CN/base_weapons.json", "zh-CN/agents.json", "zh-CN/music_kits.json", "zh-CN/keychains.json", "zh-CN/stickers.json"]) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) sha.update(fs.readFileSync(p)).update(";");
  }
  const fingerprint = sha.digest("hex");

  return {
    fingerprint, loadedAt: new Date().toISOString(),
    guns: [...guns.values()], knives: [...knives.values()], gloves: [...gloves.values()],
    agents, music, stickers, keychains, allSkins, baseImgs,
    wearTiers: WEAR_TIERS, rarZh: RAR_ZH, rarColor: RAR_COLOR,
  };
}

module.exports = { build, WEAR_TIERS };
