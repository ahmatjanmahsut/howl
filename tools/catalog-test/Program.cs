using Microsoft.Extensions.Logging.Abstractions;
using Howl;

// Howl 数据层离线测试:1) CSGO-API 样本解析;2) CT/T 行协议合并;3) 混搭/搜索
// 数据目录:优先命令行参数,否则按 csgo-api/ 相对本仓库位置推导
var dataDir = args.Length > 0
    ? args[0]
    : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "reference", "csgo-api"));
var cat = HowlCatalog.Load(dataDir, NullLogger.Instance);
Console.WriteLine($"指纹 {cat.Fingerprint[..12]}");
Console.WriteLine($"枪 {cat.Weapons.Count}(有皮肤 {cat.Weapons.Count(w => w.Skins.Count > 0)}) 皮肤 {cat.Weapons.Sum(w => w.Skins.Count)}");
Console.WriteLine($"刀 {cat.Knives.Count} 型 皮肤 {cat.Knives.Sum(k => k.Skins.Count)}");
Console.WriteLine($"手套 {cat.Gloves.Count} 型 皮肤 {cat.Gloves.Sum(g => g.Skins.Count)}");
Console.WriteLine($"探员 {cat.Agents.Count} 音乐 {cat.Music.Count} 贴纸 {cat.Stickers.Count} 挂件 {cat.Keychains.Count}");
Console.WriteLine($"总皮肤(平铺) {cat.AllSkins.Count}");
var ak = cat.WeaponByEntity["weapon_ak47"];
Console.WriteLine($"AK-47: {ak.Zh}/{ak.En} def={ak.Def} ct={ak.CanCt} t={ak.CanT} 皮肤 {ak.Skins.Count}");
var howl = ak.Skins.Find(s => s.Paint == 180);
Console.WriteLine($"火蛇: {(howl is null ? "未找到!" : $"{howl.Zh} 稀有={howl.RarityZh} legacy={howl.Legacy} float={howl.MinF}-{howl.MaxF} 图={howl.ImageFile}")}");
var bf = cat.KnifeByEntity.TryGetValue("weapon_knife_butterfly", out var bfk) ? bfk : null;
Console.WriteLine($"蝴蝶刀: {(bfk is null ? "未找到!" : $"{bfk.Zh} def={bfk.Def} 皮肤 {bfk.Skins.Count}")}");
var sp = cat.GloveByModel.TryGetValue("sporty_gloves", out var g1) ? g1 : null;
Console.WriteLine($"运动手套: {(g1 is null ? "未找到!" : $"{g1.Zh} def={g1.Def} 皮肤 {g1.Skins.Count}")}");
Console.WriteLine($"AWP 阵营: ct={cat.WeaponByEntity["weapon_awp"].CanCt}/t={cat.WeaponByEntity["weapon_awp"].CanT}; AUG: {cat.WeaponByEntity["weapon_aug"].CanCt}/{cat.WeaponByEntity["weapon_aug"].CanT}; MP9: {cat.WeaponByEntity["weapon_mp9"].CanCt}/{cat.WeaponByEntity["weapon_mp9"].CanT}");
Console.WriteLine($"搜索“火蛇”: {cat.SearchSkins("火蛇", 50).Count} 条;“awp | hyper beast”: {cat.SearchSkins("hyper beast", 50).Count} 条");

// ---- 行协议合并测试 ----
var rows = new List<HowlRow>
{
    new("any", "agent", "ct", "agent-4619"),
    new("any", "agent", "t", "agent-4613"),
    new("any", "music_kit", "music", "102"),
    new("any", "weapon", "weapon_ak47", "weapon_ak47:180"),
    new("any", "sticker", "weapon_ak47:0", "sticker-60"),
    new("ct", "weapon", "weapon_m4a1", "weapon_m4a1:3495"),
    new("t", "wear", "weapon_ak47", "0.25"),
    new("ct", "sticker", "weapon_ak47:0", "sticker-61"),
    new("ct", "knife_type", "knife", "weapon_knife_butterfly"),
    new("ct", "knife", "knife", "weapon_knife_butterfly:615"),
    new("any", "keychain", "weapon_awp", "keychain-8"),
    new("any", "knife", "weapon_knife_butterfly", "weapon_knife_butterfly:415"),   // 型号专属行(蝴蝶刀415)
};
var look = PlayerLook.Parse(rows, cat);
Console.WriteLine("\n-- 合并结果 --");
Console.WriteLine($"T 边 AK47 paint={look.T.Get("weapon_ak47").Paint} wear={look.T.Get("weapon_ak47").Wear} 贴纸0={string.Join(",", look.T.Get("weapon_ak47").Stickers.Select(kv => kv.Key + ":" + kv.Value.Def))} 挂件awp={look.T.Get("weapon_awp").KeychainId}");
Console.WriteLine($"CT 边 AK47 paint={look.Ct.Get("weapon_ak47").Paint} 贴纸0={string.Join(",", look.Ct.Get("weapon_ak47").Stickers.Select(kv => kv.Key + ":" + kv.Value.Def))} M4A1={look.Ct.Get("weapon_m4a1").SkinId} legacy={look.Ct.Get("weapon_m4a1").Legacy}");
Console.WriteLine($"CT 刀型={look.Ct.KnifeType} def={look.Ct.KnifeTypeDef} 刀皮={look.Ct.Knife.SkinId} paint={look.Ct.Knife.Paint}; T 刀型={look.T.KnifeType}");
Console.WriteLine($"音乐={look.MusicKit} 探员ct={look.AgentCt} t={look.AgentT} 火蛇legacy={look.T.Get("weapon_ak47").Legacy}");

// 断言
int fails = 0;
void Assert(bool ok, string name) { Console.WriteLine((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) fails++; }
Assert(look.T.Get("weapon_ak47").Paint == 180, "any 武器行铺到 T 边");
Assert(Math.Abs(look.T.Get("weapon_ak47").Wear - 0.25f) < 0.001f, "t 边 wear 覆盖");
Assert(look.Ct.Get("weapon_ak47").Stickers[0].Def == 61, "ct 贴纸覆盖 any");
Assert(look.T.Get("weapon_ak47").Stickers[0].Def == 60, "t 贴纸继承 any");
Assert(look.Ct.KnifeTypeDef == 515, "刀型 def(蝴蝶刀 515)");
Assert(look.Ct.Knife.Paint == 415, "刀皮肤 paint(型号专属行 415 优先于兜底 615)");
Assert(look.T.Get("weapon_awp").KeychainId == 8, "any 挂件铺两边");
Assert(look.MusicKit == 102, "音乐盒");
Assert(look.Ct.Get("weapon_m4a1").Paint == 3495 && look.T.Get("weapon_m4a1").Paint < 0, "ct 专属行不污染 t");
Assert(look.Ct.Knife.Paint == 415 && look.Ct.Knife.SkinId == "weapon_knife_butterfly:415", "型号专属刀行优先于 target=knife 兜底(佩戴蝴蝶刀→415)");
Console.WriteLine(fails == 0 ? "\n全部断言通过" : $"\n{fails} 个断言失败!");
Environment.Exit(fails == 0 ? 0 : 1);
