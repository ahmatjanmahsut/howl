
"use strict";
/* 「热门全家桶」生成规则(注册默认背包与手动发放共用,单一事实源)。
 * 分层:CT 专属枪→ct;T 专属→t;双方枪→ct+t 各一行;刀型/刀皮肤/手套/音乐盒=any。 */
const GUNS = {
  weapon_ak47: 801, weapon_aug: 455, weapon_awp: 1026, weapon_bizon: 542, weapon_cz75a: 270,
  weapon_deagle: 962, weapon_elite: 747, weapon_famas: 1184, weapon_fiveseven: 427, weapon_g3sg1: 511,
  weapon_galilar: 1038, weapon_glock: 38, weapon_hkp2000: 389, weapon_m249: 902, weapon_m4a1: 255,
  weapon_m4a1_silencer: 984, weapon_mac10: 38, weapon_mag7: 737, weapon_mp5sd: 810, weapon_mp7: 752,
  weapon_mp9: 1134, weapon_negev: 763, weapon_nova: 537, weapon_p250: 551, weapon_p90: 359,
  weapon_revolver: 522, weapon_sawedoff: 256, weapon_scar20: 597, weapon_sg556: 1084, weapon_ssg08: 222,
  weapon_tec9: 889, weapon_ump45: 879, weapon_usp_silencer: 705, weapon_xm1014: 1046,
};
const KNIVES = {
  weapon_bayonet: 38, weapon_knife_butterfly: 38, weapon_knife_canis: 38, weapon_knife_cord: 38,
  weapon_knife_css: 38, weapon_knife_falchion: 38, weapon_knife_flip: 38, weapon_knife_gut: 38,
  weapon_knife_gypsy_jackknife: 38, weapon_knife_karambit: 38, weapon_knife_kukri: 38, weapon_knife_m9_bayonet: 38,
  weapon_knife_outdoor: 38, weapon_knife_push: 38, weapon_knife_skeleton: 38, weapon_knife_stiletto: 38,
  weapon_knife_survival_bowie: 38, weapon_knife_tactical: 38, weapon_knife_ursus: 38, weapon_knife_widowmaker: 38,
};
const GLOVE = ["sporty_gloves", 1405];
const KNIFE_EQUIP = "weapon_knife_butterfly";
const STICKERS = [49, 53, 56, 58, 60];
const KEYCHAIN = 17;
const MUSIC = 35;
const NAME = "热门全家桶";

/* cat = catalog.js build() 的结果;返回 rows 数组(带校验,paint 不存在会抛错) */
function build(cat) {
  const have = new Set();
  for (const g of cat.guns) for (const s of g.skins) have.add(g.entity + ":" + Number(s.paint));
  for (const k of cat.knives) for (const s of k.skins) have.add(k.entity + ":" + Number(s.paint));
  for (const gl of cat.gloves) for (const s of gl.skins) have.add(gl.model + ":" + Number(s.paint));
  for (const [e, p] of Object.entries({ ...GUNS, ...KNIVES })) if (!have.has(e + ":" + p)) throw new Error("全家桶映射失效: " + e + ":" + p);
  if (!have.has(GLOVE[0] + ":" + GLOVE[1])) throw new Error("全家桶手套映射失效");
  const sideOf = {};
  for (const g of cat.guns) sideOf[g.entity] = g.ct && g.t ? ["ct", "t"] : (g.ct ? ["ct"] : ["t"]);
  const rows = [];
  const add = (s, t, a, v) => rows.push({ s, t, a, v });
  for (const [e, p] of Object.entries(GUNS)) {
    if (!cat.guns.some(g => g.entity === e)) continue;   // 上游删枪则跳过,不炸注册
    const sides = sideOf[e] || ["any"];
    for (const sd of sides) {
      add(sd, "weapon", e, e + ":" + p);
      STICKERS.forEach((sid, i) => add(sd, "sticker", e + ":" + i, "sticker-" + sid));
      add(sd, "keychain", e, "keychain-" + KEYCHAIN);
    }
  }
  add("any", "glove", "glove", GLOVE[0] + ":" + GLOVE[1]);
  add("any", "knife_type", "knife", KNIFE_EQUIP);
  for (const [e, p] of Object.entries(KNIVES)) { add("any", "knife", e, e + ":" + p); add("any", "keychain", e, "keychain-" + KEYCHAIN); }
  add("any", "music_kit", "music", String(MUSIC));
  return rows;
}
module.exports = { build, NAME, GUNS, KNIVES };
