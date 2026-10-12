using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Howl;

/// <summary>一款皮肤(按 实体+paint_index 聚合,StatTrak/Souvenir 变体合并)。</summary>
public sealed class SkinDef
{
    public string SkinId = "";        // "<实体>:<paint>",数据库 value
    public string OwnerEntity = "";   // 皮肤所属标准实体(混搭时≠目标武器)
    public int Paint;                 // paint_index(注入 "set item texture prefab")
    public int DefIndex;              // 所属实体 def_index
    public string Zh = "";            // 中文名
    public string En = "";            // 英文名
    public string RarityKey = "";     // common/uncommon/rare/mythical/legendary/ancient/contraband
    public string RarityZh = "";      // 隐秘级 等(上游中文)
    public string Color = "#3a4250";  // 稀有度色值
    public bool Legacy;               // legacy_model(bodygroup body,1)
    public float MinF = -1f, MaxF = -1f;
    public string Category = "weapon";// weapon / knife / glove
    public string ImageFile = "";     // 本地图片文件名约定
}

public sealed class WeaponDef
{
    public string Entity = ""; public int Def; public string Zh = ""; public string En = "";
    public string Category = "rifles"; // rifles / pistols / smgs / heavy
    public bool CanCt, CanT;
    public readonly List<SkinDef> Skins = new();
    public bool IsSniper => HowlCatalog.Snipers.Contains(Entity);
}

public sealed class KnifeDef
{
    public string Entity = ""; public int Def; public string Zh = ""; public string En = "";
    public readonly List<SkinDef> Skins = new();
}

public sealed class GloveDef
{
    public string Model = ""; public int Def; public string Zh = ""; public string En = "";
    public readonly List<SkinDef> Skins = new();
}

public sealed class AgentDef
{
    public string Id = ""; public int Def; public string Zh = ""; public string En = "";
    public string Team = "both";      // ct / t / both
    public string Model = "";         // model_player
    public string ImageFile = "";
    public string Group = "";
}

public sealed class MusicDef { public int Kit; public string Zh = ""; public string En = ""; public string ImageFile = ""; }

public sealed class StickerDef
{
    public string Id = ""; public int Def; public string Zh = ""; public string En = "";
    public string Group = ""; public string Capsule = "";
    public int Year;                  // 0 = 无赛季
    public string TypeKey = "normal"; // normal/gold/holo/foil/glitter/lenticular
    public string TypeZh = "普通";
    public string RarityZh = ""; public string Color = "#4b69ff";
    public string ImageFile = "";
}

public sealed class KeychainDef
{
    public string Id = ""; public int Def; public string Zh = ""; public string En = "";
    public string Group = ""; public string Color = "#4b69ff"; public string RarityZh = "";
    public string ImageFile = "";
}

/// <summary>
/// Howl 目录:直接以 CSGO-API(ByMykel/CSGO-API)原始 JSON 为数据源("CSGO-API 数据格式"),
/// 解析→归一化→建索引;自动更新后整体换新实例热重载。归一化规则与线上验证过的 auto-update 对齐:
///   · 过滤宙斯/补给/裸刀/无皮肤手套等 AstraSkins 系不支持的实体;
///   · 刀的 sfui_wpnhud_* 与 weapon_* 双份条目按 def_index 归一为标准实体名;
///   · 音乐盒按 def_index 去重(StatTrak™ 版与普版同 def);
///   · 中英双语名分别取自 zh-CN 与 en 目录。
/// </summary>
public sealed class HowlCatalog
{
    public readonly List<WeaponDef> Weapons = new();
    public readonly Dictionary<string, WeaponDef> WeaponByEntity = new(StringComparer.OrdinalIgnoreCase);
    public readonly List<KnifeDef> Knives = new();
    public readonly Dictionary<string, KnifeDef> KnifeByEntity = new(StringComparer.OrdinalIgnoreCase);
    public readonly List<GloveDef> Gloves = new();
    public readonly Dictionary<string, GloveDef> GloveByModel = new(StringComparer.OrdinalIgnoreCase);
    public readonly Dictionary<string, SkinDef> SkinById = new(StringComparer.OrdinalIgnoreCase);
    public readonly List<SkinDef> AllSkins = new();               // 混搭搜索用
    public readonly List<AgentDef> Agents = new();
    public readonly List<MusicDef> Music = new();
    public readonly List<StickerDef> Stickers = new();
    public readonly List<KeychainDef> Keychains = new();
    public string Fingerprint = "";
    public DateTime LoadedAt = DateTime.Now;

    /// <summary>狙击枪按实体细分(AWP / SSG08 / SCAR-20 / G3SG1)。</summary>
    public static readonly HashSet<string> Snipers = new(StringComparer.OrdinalIgnoreCase)
        { "weapon_awp", "weapon_ssg08", "weapon_scar20", "weapon_g3sg1" };

    /// <summary>不支持的实体(与 AstraSkins/auto-update 实测一致)。</summary>
    static readonly HashSet<string> SkipEntities = new(StringComparer.OrdinalIgnoreCase)
        { "weapon_taser", "weapon_healthshot", "t_gloves", "ct_gloves", "weapon_knife", "weapon_knife_t", "weapon_c4" };

    public static string RarityKeyOf(string? rarityId)
        => (rarityId ?? "").Replace("rarity_", "").Replace("_weapon", "").Replace("_character", "");

    static string StripSkinName(string full)
    {
        var s = full.Trim();
        if (s.StartsWith("★")) s = s[1..].Trim();
        var i = s.IndexOf('|');
        return (i >= 0 ? s[(i + 1)..] : s).Trim();
    }

    static string? GetStr(JsonElement o, string p) =>
        o.TryGetProperty(p, out var v) ? v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        } : null;
    static int GetInt(JsonElement o, string p) { var s = GetStr(o, p); return int.TryParse(s, out var v) ? v : int.MinValue; }
    static float GetFloat(JsonElement o, string p) { var s = GetStr(o, p); return float.TryParse(s, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : -1f; }
    static bool GetBool(JsonElement o, string p) => string.Equals(GetStr(o, p), "true", StringComparison.OrdinalIgnoreCase);
    static JsonElement? Sub(JsonElement o, string p) => o.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;
    static string FirstArrName(JsonElement o, string p) =>
        o.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.Array && v.GetArrayLength() > 0 ? GetStr(v[0], "name") ?? "" : "";
    static string ReadAll(string path) => File.ReadAllText(path);

    /// <summary>CS2 购买表阵营限制(skins.json 的 team 字段为主,内置表兜底)。</summary>
    static (bool ct, bool t) TeamDefaults(string entity) => entity switch
    {
        "weapon_ak47" or "weapon_galilar" or "weapon_ssg08" or "weapon_g3sg1" or "weapon_mac10"
            or "weapon_tec9" or "weapon_glock" or "weapon_sawedoff" => (false, true),
        "weapon_m4a1" or "weapon_m4a1_silencer" or "weapon_aug" or "weapon_scar20" or "weapon_famas"
            or "weapon_hkp2000" or "weapon_usp_silencer" or "weapon_fiveseven" or "weapon_mag7" or "weapon_mp9" => (true, false),
        _ => (true, true),
    };

    static (string key, string zh) StickerTypeOf(string en)
    {
        if (System.Text.RegularExpressions.Regex.IsMatch(en, @"\(Gold\)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return ("gold", "金色");
        if (System.Text.RegularExpressions.Regex.IsMatch(en, @"\(Holo\)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return ("holo", "全息");
        if (System.Text.RegularExpressions.Regex.IsMatch(en, @"\(Foil\)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return ("foil", "闪亮");
        if (System.Text.RegularExpressions.Regex.IsMatch(en, @"\(Glitter\)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return ("glitter", "闪耀");
        if (System.Text.RegularExpressions.Regex.IsMatch(en, @"\(Lenticular\)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return ("lenticular", "3D 立体");
        return ("normal", "普通");
    }

    static string NormalizeKnifeEntity(string wid, int wdef, Dictionary<int, string> knifeDefToStd)
    {
        if (wid.StartsWith("weapon_") || wid.EndsWith("_gloves") || wid == "leather_handwraps") return wid;
        if (knifeDefToStd.TryGetValue(wdef, out var std)) return std;   // sfui_* → weapon_*
        return wid;
    }

    public static HowlCatalog Load(string dataDir, ILogger log)
    {
        var zhDir = Path.Combine(dataDir, "zh-CN");
        var enDir = Path.Combine(dataDir, "en");
        var cat = new HowlCatalog();

        // ---------- 1) base_weapons(中文):实体/中文名/def/分类 ----------
        var enNameByDef = new Dictionary<int, string>();
        if (File.Exists(Path.Combine(enDir, "base_weapons.json")))
            foreach (var w in JsonDocument.Parse(ReadAll(Path.Combine(enDir, "base_weapons.json"))).RootElement.EnumerateArray())
                enNameByDef[GetInt(w, "def_index")] = GetStr(w, "name") ?? "";

        var knifeDefToStd = new Dictionary<int, string>();   // 刀 def → 标准实体
        var knifeZhByDef = new Dictionary<int, string>();
        var gloveInfo = new Dictionary<string, (int def, string zh)>(StringComparer.OrdinalIgnoreCase);
        var gunBase = new List<(string entity, int def, string zh, string catKey)>();
        foreach (var w in JsonDocument.Parse(ReadAll(Path.Combine(zhDir, "base_weapons.json"))).RootElement.EnumerateArray())
        {
            var id = (GetStr(w, "id") ?? "").Replace("base_weapon-", "");
            var def = GetInt(w, "def_index");
            var zh = GetStr(w, "name") ?? id;
            var catId = Sub(w, "category") is { } c ? GetStr(c, "id") ?? "" : "";
            if (SkipEntities.Contains(id)) continue;
            if (catId.Contains("rifles") || catId.Contains("pistols") || catId.Contains("smgs") || catId.Contains("heavy"))
                gunBase.Add((id, def, zh, catId.Contains("rifles") ? "rifles" : catId.Contains("pistols") ? "pistols" : catId.Contains("smgs") ? "smgs" : "heavy"));
            else if (catId.Contains("melee") || id.StartsWith("weapon_knife") || id == "weapon_bayonet")
            { knifeDefToStd[def] = id; knifeZhByDef[def] = zh; }
            else if (catId.Contains("gloves") || id.EndsWith("_gloves") || id == "leather_handwraps")
                gloveInfo[id] = (def, zh);
        }
        foreach (var (entity, def, zh, catKey) in gunBase)
        {
            var wp = new WeaponDef { Entity = entity, Def = def, Zh = zh, En = enNameByDef.TryGetValue(def, out var en) ? en : entity, Category = catKey };
            (wp.CanCt, wp.CanT) = TeamDefaults(entity);
            cat.WeaponByEntity[entity] = wp; cat.Weapons.Add(wp);
        }

        // ---------- 2) skins.json:按标准实体分组挂载 ----------
        var zhSkinsDoc = JsonDocument.Parse(ReadAll(Path.Combine(zhDir, "skins.json")));
        var enSkinName = new Dictionary<string, string>();   // "std:paint" → en
        if (File.Exists(Path.Combine(enDir, "skins.json")))
            foreach (var s in JsonDocument.Parse(ReadAll(Path.Combine(enDir, "skins.json"))).RootElement.EnumerateArray())
            {
                var wid = Sub(s, "weapon") is { } wo ? GetStr(wo, "id") ?? "" : "";
                var wdef = Sub(s, "weapon") is { } w2 ? GetInt(w2, "weapon_id") : int.MinValue;
                var std = NormalizeKnifeEntity(wid, wdef, knifeDefToStd);
                enSkinName[$"{std}:{GetInt(s, "paint_index")}"] = StripSkinName(GetStr(s, "name") ?? "");
            }

        void Attach(string stdEntity, string category, JsonElement s, int paint, int wdef, string team)
        {
            var key = stdEntity + ":" + paint;
            if (cat.SkinById.ContainsKey(key)) return;    // 双份刀条目/变体去重
            var rarity = Sub(s, "rarity");
            var zhFull = GetStr(s, "name") ?? "";
            var sd = new SkinDef
            {
                SkinId = key, OwnerEntity = stdEntity, Paint = paint, DefIndex = wdef,
                Zh = StripSkinName(zhFull).Length > 0 ? StripSkinName(zhFull) : (Sub(s, "pattern") is { } pt ? GetStr(pt, "name") ?? zhFull : zhFull),
                En = enSkinName.TryGetValue(key, out var en) && en.Length > 0 ? en : StripSkinName(zhFull),
                RarityKey = RarityKeyOf(rarity is { } r ? GetStr(r, "id") : null),
                RarityZh = rarity is { } r2 ? GetStr(r2, "name") ?? "" : "",
                Color = rarity is { } r3 ? GetStr(r3, "color") ?? "#3a4250" : "#3a4250",
                Legacy = GetBool(s, "legacy_model"),
                MinF = GetFloat(s, "min_float"), MaxF = GetFloat(s, "max_float"),
                Category = category,
                ImageFile = stdEntity + "-" + paint + ".png",
            };
            cat.SkinById[key] = sd; cat.AllSkins.Add(sd);
            if (category == "weapon" && cat.WeaponByEntity.TryGetValue(stdEntity, out var wp))
            {
                wp.Skins.Add(sd);
                if (team == "terrorists") wp.CanT = true;
                else if (team == "counter-terrorists") wp.CanCt = true;
            }
            else if (category == "knife")
            {
                if (!cat.KnifeByEntity.TryGetValue(stdEntity, out var kn))
                {
                    kn = new KnifeDef { Entity = stdEntity, Def = wdef, Zh = knifeZhByDef.TryGetValue(wdef, out var kz) ? kz : stdEntity, En = enNameByDef.TryGetValue(wdef, out var ke) ? ke : stdEntity };
                    cat.KnifeByEntity[stdEntity] = kn; cat.Knives.Add(kn);
                }
                kn.Skins.Add(sd);
            }
            else if (category == "glove")
            {
                if (!cat.GloveByModel.TryGetValue(stdEntity, out var gl))
                {
                    var gi = gloveInfo.TryGetValue(stdEntity, out var g) ? g : (def: wdef, zh: stdEntity);
                    gl = new GloveDef { Model = stdEntity, Def = gi.def != int.MinValue ? gi.def : wdef, Zh = gi.zh, En = enNameByDef.TryGetValue(wdef, out var ge) ? ge : stdEntity };
                    cat.GloveByModel[stdEntity] = gl; cat.Gloves.Add(gl);
                }
                gl.Skins.Add(sd);
            }
        }

        foreach (var s in zhSkinsDoc.RootElement.EnumerateArray())
        {
            var wid = Sub(s, "weapon") is { } wo ? GetStr(wo, "id") ?? "" : "";
            var wdef = Sub(s, "weapon") is { } w2 ? GetInt(w2, "weapon_id") : int.MinValue;
            var catId = Sub(s, "category") is { } c ? GetStr(c, "id") ?? "" : "";
            var paint = GetInt(s, "paint_index");
            var team = Sub(s, "team") is { } t ? GetStr(t, "id") ?? "" : "";
            if (wid.Length == 0 || paint <= 0 || SkipEntities.Contains(wid)) continue;
            var std = NormalizeKnifeEntity(wid, wdef, knifeDefToStd);
            if (SkipEntities.Contains(std)) continue;
            string kind;
            if (knifeDefToStd.ContainsKey(wdef) || catId.Contains("melee") || std.StartsWith("weapon_knife") || std == "weapon_bayonet") kind = "knife";
            else if (catId.Contains("gloves") || gloveInfo.ContainsKey(std)) kind = "glove";
            else if (catId.Contains("equipment")) continue;                       // 宙斯皮肤等
            else kind = "weapon";
            if (kind == "weapon" && !cat.WeaponByEntity.ContainsKey(std)) continue; // 四分类之外(如装备)不展示
            Attach(std, kind, s, paint, wdef, team);
        }
        foreach (var wp in cat.Weapons) wp.Skins.Sort((a, b) => a.Paint.CompareTo(b.Paint));
        foreach (var kn in cat.Knives) kn.Skins.Sort((a, b) => a.Paint.CompareTo(b.Paint));
        foreach (var gl in cat.Gloves) gl.Skins.Sort((a, b) => a.Paint.CompareTo(b.Paint));
        cat.Knives.Sort((a, b) => string.CompareOrdinal(a.Zh, b.Zh));
        cat.Gloves.Sort((a, b) => string.CompareOrdinal(a.Zh, b.Zh));

        // ---------- 3) agents ----------
        var agEn = new Dictionary<int, string>();
        if (File.Exists(Path.Combine(enDir, "agents.json")))
            foreach (var a in JsonDocument.Parse(ReadAll(Path.Combine(enDir, "agents.json"))).RootElement.EnumerateArray())
                agEn[GetInt(a, "def_index")] = GetStr(a, "name") ?? "";
        foreach (var a in JsonDocument.Parse(ReadAll(Path.Combine(zhDir, "agents.json"))).RootElement.EnumerateArray())
        {
            var def = GetInt(a, "def_index");
            var team = Sub(a, "team") is { } t ? GetStr(t, "id") ?? "" : "";
            var model = GetStr(a, "model_player") ?? "";
            if (model.Length == 0) continue;
            cat.Agents.Add(new AgentDef
            {
                Id = "agent-" + def, Def = def, Zh = GetStr(a, "name") ?? ("agent-" + def),
                En = agEn.TryGetValue(def, out var ae) ? ae : (GetStr(a, "name") ?? ""),
                Team = team.Contains("counter") ? "ct" : team.Contains("terrorist") ? "t" : "both",
                Model = model, ImageFile = "agent-" + def + ".png",
                Group = FirstArrName(a, "collections"),
            });
        }
        cat.Agents.Sort((a, b) => a.Def.CompareTo(b.Def));

        // ---------- 4) music_kits(def 去重,优先普版) ----------
        var mkEn = new Dictionary<int, string>();
        if (File.Exists(Path.Combine(enDir, "music_kits.json")))
            foreach (var m in JsonDocument.Parse(ReadAll(Path.Combine(enDir, "music_kits.json"))).RootElement.EnumerateArray())
                mkEn[GetInt(m, "def_index")] = GetStr(m, "name") ?? "";
        var byKit = new Dictionary<int, MusicDef>();
        foreach (var m in JsonDocument.Parse(ReadAll(Path.Combine(zhDir, "music_kits.json"))).RootElement.EnumerateArray())
        {
            var def = GetInt(m, "def_index");
            var zhName = GetStr(m, "name") ?? ("音乐盒 " + def);
            var enName = mkEn.TryGetValue(def, out var e) ? e : zhName;
            var isSt = zhName.StartsWith("StatTrak") || enName.StartsWith("StatTrak");
            if (byKit.TryGetValue(def, out var ex)) { if (!isSt) { ex.Zh = zhName; ex.En = enName; } continue; }
            byKit[def] = new MusicDef
            {
                Kit = def,
                Zh = isSt ? zhName.Replace("StatTrak™ ", "").Replace("StatTrak™", "").Trim() : zhName,
                En = isSt ? enName.Replace("StatTrak™ ", "").Replace("StatTrak™", "").Trim() : enName,
                ImageFile = "music-" + def + ".png",
            };
        }
        cat.Music.AddRange(byKit.Values.OrderBy(x => x.Kit));

        // ---------- 5) stickers ----------
        var stEn = new Dictionary<int, string>();
        if (File.Exists(Path.Combine(enDir, "stickers.json")))
            foreach (var x in JsonDocument.Parse(ReadAll(Path.Combine(enDir, "stickers.json"))).RootElement.EnumerateArray())
                stEn[GetInt(x, "def_index")] = GetStr(x, "name") ?? "";
        var stPath = Path.Combine(zhDir, "stickers.json");
        if (File.Exists(stPath))
            foreach (var x in JsonDocument.Parse(ReadAll(stPath)).RootElement.EnumerateArray())
            {
                var def = GetInt(x, "def_index");
                var zhName = GetStr(x, "name") ?? ("sticker-" + def);
                var enName = stEn.TryGetValue(def, out var ee) ? ee : zhName;
                var group = FirstArrName(x, "collections");
                var capsule = FirstArrName(x, "crates");
                if (string.IsNullOrEmpty(group)) group = capsule;
                var yrM = System.Text.RegularExpressions.Regex.Match(group + " " + capsule + " " + enName, @"(19|20)\d{2}");
                var year = yrM.Success ? int.Parse(yrM.Value) : 0;
                if (year is < 2013 or > 2028) year = 0;
                var (tk, tz) = StickerTypeOf(enName);
                var rarity = Sub(x, "rarity");
                cat.Stickers.Add(new StickerDef
                {
                    Id = "sticker-" + def, Def = def, Zh = zhName, En = enName, Group = group, Capsule = capsule,
                    Year = year, TypeKey = tk, TypeZh = tz,
                    RarityZh = rarity is { } r ? GetStr(r, "name") ?? "" : "", Color = rarity is { } r2 ? GetStr(r2, "color") ?? "#4b69ff" : "#4b69ff",
                    ImageFile = "sticker-" + def + ".png",
                });
            }

        // ---------- 6) keychains ----------
        var kcEn = new Dictionary<int, string>();
        if (File.Exists(Path.Combine(enDir, "keychains.json")))
            foreach (var x in JsonDocument.Parse(ReadAll(Path.Combine(enDir, "keychains.json"))).RootElement.EnumerateArray())
                kcEn[GetInt(x, "def_index")] = GetStr(x, "name") ?? "";
        var kcPath = Path.Combine(zhDir, "keychains.json");
        if (File.Exists(kcPath))
            foreach (var x in JsonDocument.Parse(ReadAll(kcPath)).RootElement.EnumerateArray())
            {
                var def = GetInt(x, "def_index");
                var rarity = Sub(x, "rarity");
                cat.Keychains.Add(new KeychainDef
                {
                    Id = "keychain-" + def, Def = def, Zh = GetStr(x, "name") ?? ("keychain-" + def),
                    En = kcEn.TryGetValue(def, out var ke) ? ke : (GetStr(x, "name") ?? ""),
                    Group = FirstArrName(x, "collections"),
                    RarityZh = rarity is { } r ? GetStr(r, "name") ?? "" : "", Color = rarity is { } r2 ? GetStr(r2, "color") ?? "#4b69ff" : "#4b69ff",
                    ImageFile = "keychain-" + def + ".png",
                });
            }

        // ---------- 7) 指纹(内容级,插件与 Web 各自计算可互相对齐) ----------
        // 指纹:七个核心文件"字节流拼接 + 分号分隔"整体 SHA-256 —— 与 Web 端 catalog.js 完全同算法(两侧版本可比对)
        using var msFp = new MemoryStream();
        foreach (var f in new[] { "zh-CN" + Path.DirectorySeparatorChar + "skins.json", "en" + Path.DirectorySeparatorChar + "skins.json", "zh-CN" + Path.DirectorySeparatorChar + "base_weapons.json", "zh-CN" + Path.DirectorySeparatorChar + "agents.json", "zh-CN" + Path.DirectorySeparatorChar + "music_kits.json", "zh-CN" + Path.DirectorySeparatorChar + "keychains.json", "zh-CN" + Path.DirectorySeparatorChar + "stickers.json" })
        {
            var p = Path.Combine(dataDir, f);
            if (!File.Exists(p)) continue;
            msFp.Write(File.ReadAllBytes(p));
            msFp.WriteByte((byte)';');
        }
        cat.Fingerprint = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(msFp.ToArray())).ToLowerInvariant();

        log.LogInformation($"[Howl] 目录就绪:枪 {cat.Weapons.Count} 把/皮肤 {cat.Weapons.Sum(x => x.Skins.Count)} 款、刀 {cat.Knives.Count} 型/{cat.Knives.Sum(k => k.Skins.Count)} 款、手套 {cat.Gloves.Count} 型/{cat.Gloves.Sum(g => g.Skins.Count)} 款、探员 {cat.Agents.Count}、音乐盒 {cat.Music.Count}、贴纸 {cat.Stickers.Count}、挂件 {cat.Keychains.Count}");
        return cat;
    }

    /// <summary>混搭搜索:关键词命中(中/英名、所属实体、paint)。</summary>
    public List<SkinDef> SearchSkins(string kw, int max)
    {
        kw = kw.Trim().ToLowerInvariant();
        var outp = new List<SkinDef>();
        if (kw.Length == 0) return outp;
        foreach (var s in AllSkins)
        {
            if (outp.Count >= max) break;
            if (s.Zh.ToLowerInvariant().Contains(kw) || s.En.ToLowerInvariant().Contains(kw)
                || s.OwnerEntity.Contains(kw, StringComparison.OrdinalIgnoreCase) || s.Paint.ToString() == kw)
                outp.Add(s);
        }
        return outp;
    }

    public List<StickerDef> SearchStickers(string kw, int max)
    {
        kw = kw.Trim().ToLowerInvariant();
        var outp = new List<StickerDef>();
        if (kw.Length == 0) return outp;
        foreach (var s in Stickers)
        {
            if (outp.Count >= max) break;
            if (s.Zh.ToLowerInvariant().Contains(kw) || s.En.ToLowerInvariant().Contains(kw) || s.Group.ToLowerInvariant().Contains(kw) || s.Def.ToString() == kw)
                outp.Add(s);
        }
        return outp;
    }

    /// <summary>注入层用:按 skinId 查 legacy。</summary>
    public bool SkinLegacy(string skinId) => SkinById.TryGetValue(skinId, out var s) && s.Legacy;
}
