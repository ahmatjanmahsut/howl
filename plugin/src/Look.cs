using Microsoft.Extensions.Logging;

namespace Howl;

/// <summary>一枚印花的槽位数值(Web 端序列化:sticker-def|wear|scale|rot|x|y)。</summary>
public sealed class StkSlotV
{
    public int Def;
    public float Wear;
    public float Scale = 1f;
    public float Rot;
    public float X;
    public float Y;
}

/// <summary>一件物品(某武器/刀/手套)的外观条目;字段 -1/null 表示未设置。</summary>
public sealed class HowlEntry
{
    public string Entity = "";
    public int Paint = -1;              // paint_index
    public string SkinId = "";          // "<来源实体>:<paint>"(混搭时来源≠Entity)
    public int Seed = -1;
    public float Wear = -1f;
    public bool Legacy;
    public bool StatTrak;
    public string Nametag = "";
    public int KeychainId = -1;
    public readonly Dictionary<int, StkSlotV> Stickers = new();
    public int StickerWearSteps;
    public int KnifeDefIndex;           // 仅刀
    public bool HasAnything => Paint > 0 || Stickers.Count > 0 || KeychainId > 0 || StatTrak || Nametag.Length > 0;
}

/// <summary>一侧(CT 或 T)的外观集合。</summary>
public sealed class SideLook
{
    public bool Base;   // true=any 基线层
    public readonly Dictionary<string, HowlEntry> Weapons = new(StringComparer.OrdinalIgnoreCase); // key=实体名;刀归一到 "knife"
    public HowlEntry Knife { get; } = new() { Entity = "knife" };
    public HowlEntry Gloves { get; } = new() { Entity = "glove" };
    public string KnifeType = "weapon_knife";       // 当前佩戴刀型实体
    public int KnifeTypeDef;                        // 刀型 def_index
    public string GloveModel = "";                  // 手套型号(sporty_gloves 等)
    // 每种刀型独立的皮肤行(knife|weapon_knife_butterfly → 该型号的 paint);切刀型即切行
    public readonly Dictionary<string, (string SkinId, int Paint, bool Legacy)> KnifeByModel = new(StringComparer.OrdinalIgnoreCase);
    public string KnifeBaseSkinId = "";             // 传统 target="knife" 行(对所有型号生效的兜底)
    public int KnifeBasePaint = -1;
    public bool KnifeBaseLegacy;

    /// <summary>解析完成时调用:当前佩戴型号的皮肤行优先于 target=knife 的兜底行。</summary>
    public void ResolveKnife()
    {
        int paint = -1; string skinId = ""; bool legacy = false;
        if (KnifeBasePaint > 0) { paint = KnifeBasePaint; skinId = KnifeBaseSkinId; legacy = KnifeBaseLegacy; }
        if (KnifeByModel.TryGetValue(KnifeType, out var km) && km.Paint > 0) { paint = km.Paint; skinId = km.SkinId; legacy = km.Legacy; }
        if (paint > 0) { Knife.Paint = paint; Knife.SkinId = skinId; Knife.Legacy = legacy; }
        else { Knife.Paint = -1; Knife.SkinId = ""; Knife.Legacy = false; }
    }

    /// <summary>取某实体的条目;刀类归一到 Knife。</summary>
    public HowlEntry Get(string entityName)
    {
        if (entityName.Contains("knife") || entityName.Contains("bayonet") || entityName.Contains("flip")
            || entityName.Contains("gut") || entityName.Contains("karambit") || entityName.Contains("m9")
            || entityName.Contains("tactical") || entityName.Contains("navaja") || entityName.Contains("classic")
            || entityName.Contains("stiletto") || entityName.Contains("wagon") || entityName.Contains("ursus")
            || entityName.Contains("talon") || entityName.Contains("butterfly") || entityName.Contains("skeleton")
            || entityName.Contains("nomad") || entityName.Contains("paracord") || entityName.Contains("survival")
            || entityName.Contains("crypt"))
            return Knife;
        if (Weapons.TryGetValue(entityName, out var e)) return e;
        var fresh = new HowlEntry { Entity = entityName };
        Weapons[entityName] = fresh;
        return fresh;
    }
}

/// <summary>玩家完整外观:any 基线 + CT/T 覆盖层。</summary>
public sealed class PlayerLook
{
    public SideLook Any { get; } = new() { Base = true };
    public SideLook Ct { get; } = new();
    public SideLook T { get; } = new();

    /// <summary>把基线层字段级填入目标层(目标已设置的字段不被覆盖)。</summary>
    static void MergeInto(SideLook target, SideLook baseL)
    {
        foreach (var (k, v) in baseL.Weapons)
        {
            if (target.Weapons.TryGetValue(k, out var tv))
            {
                if (tv.Paint < 0 && v.Paint > 0) { tv.Paint = v.Paint; tv.SkinId = v.SkinId; tv.Legacy = v.Legacy; }
                if (tv.Seed < 0 && v.Seed >= 0) tv.Seed = v.Seed;
                if (tv.Wear < 0 && v.Wear >= 0) tv.Wear = v.Wear;
                if (string.IsNullOrEmpty(tv.Nametag) && !string.IsNullOrEmpty(v.Nametag)) tv.Nametag = v.Nametag;
                if (!tv.StatTrak && v.StatTrak) tv.StatTrak = true;
                if (tv.KeychainId < 0 && v.KeychainId > 0) tv.KeychainId = v.KeychainId;
                foreach (var (slot, sv) in v.Stickers) tv.Stickers.TryAdd(slot, sv);
            }
            else target.Weapons[k] = v;
        }
        if (string.IsNullOrEmpty(target.KnifeType) || target.KnifeType == "weapon_knife") { target.KnifeType = baseL.KnifeType; target.KnifeTypeDef = baseL.KnifeTypeDef; }
        foreach (var (m, v) in baseL.KnifeByModel) target.KnifeByModel.TryAdd(m, v);
        if (string.IsNullOrEmpty(target.KnifeBaseSkinId) && baseL.KnifeBasePaint > 0) { target.KnifeBasePaint = baseL.KnifeBasePaint; target.KnifeBaseSkinId = baseL.KnifeBaseSkinId; target.KnifeBaseLegacy = baseL.KnifeBaseLegacy; }
        if (target.Gloves.Paint <= 0 && baseL.Gloves.Paint > 0) { target.Gloves.Paint = baseL.Gloves.Paint; target.Gloves.SkinId = baseL.Gloves.SkinId; target.Gloves.Legacy = baseL.Gloves.Legacy; }
        if (string.IsNullOrEmpty(target.GloveModel) && !string.IsNullOrEmpty(baseL.GloveModel)) target.GloveModel = baseL.GloveModel;
    }
    public int MusicKit;                      // 0=未选
    public string AgentCt = "", AgentT = "";
    public SideLook For(bool isCt) => isCt ? Ct : T;

    public static PlayerLook Parse(IEnumerable<HowlRow> rows, HowlCatalog cat, ILogger? log = null)
    {
        var look = new PlayerLook();
        // 三层收集(any/ct/t 各自独立应用),再按"ct>t→any、t>any"优先级合并
        foreach (var (type, side, target, value) in rows.Select(r => (r.Type, r.Side, r.Target, r.Value)))
        {
            var sl = side switch { "t" => look.T, "ct" => look.Ct, _ => look.Any };
            switch (type)
            {
                case "agent":
                    if (target.Equals("ct", StringComparison.OrdinalIgnoreCase)) look.AgentCt = value;
                    else if (target.Equals("t", StringComparison.OrdinalIgnoreCase)) look.AgentT = value;
                    break;
                case "music_kit":
                    if (int.TryParse(value, out var mk) && mk > 0) look.MusicKit = mk;
                    else if (value == "off") look.MusicKit = 0;
                    break;
            }
            ApplyItem(sl, type, target, value, cat);
        }
        // 合并:T 侧 = any 基线 + t 覆盖;CT 侧 = any 基线 + ct 覆盖(按字段合并:目标已设置的字段优先,未设置的才吃基线)
        MergeInto(look.T, look.Any);
        MergeInto(look.Ct, look.Any);
        // 两遍(any → 具体边)合并完成后:按各边当前佩戴型号解析刀皮肤
        foreach (var sl in new[] { look.Ct, look.T })
        {
            sl.ResolveKnife();
            sl.Knife.Entity = "knife";
            sl.Knife.KnifeDefIndex = sl.KnifeTypeDef;
        }
        return look;
    }

    static void ApplyItem(SideLook sl, string type, string target, string value, HowlCatalog cat)
    {
        switch (type)
        {
            case "weapon":
            {
                var e = sl.Get(target);
                e.Paint = TailPaint(value); e.SkinId = value;
                if (cat.SkinById.TryGetValue(value, out var sd)) { e.Legacy = sd.Legacy; }
                break;
            }
            case "knife_type":
            {
                sl.KnifeType = value;
                sl.KnifeTypeDef = cat.KnifeByEntity.TryGetValue(value, out var k) ? k.Def : 0;
                break;
            }
            case "knife":
            {
                var paint = TailPaint(value);
                if (target == "knife" || string.IsNullOrEmpty(target))
                {
                    if (paint > 0) { sl.KnifeBasePaint = paint; sl.KnifeBaseSkinId = value; sl.KnifeBaseLegacy = cat.SkinById.TryGetValue(value, out var sd0) && sd0.Legacy; }
                }
                else if (paint > 0)
                {
                    var lg = cat.SkinById.TryGetValue(value, out var sd) && sd.Legacy;
                    sl.KnifeByModel[target] = (value, paint, lg);   // 型号专属皮肤行
                }
                break;
            }
            case "glove":
            {
                sl.Gloves.Paint = TailPaint(value); sl.Gloves.SkinId = value;
                var ix = value.IndexOf(':');
                sl.GloveModel = ix > 0 ? value[..ix] : value;
                if (cat.SkinById.TryGetValue(value, out var sd)) sl.Gloves.Legacy = sd.Legacy;
                break;
            }
            case "sticker":
            {
                var ix = target.LastIndexOf(':');
                if (ix > 0 && int.TryParse(target[(ix + 1)..], out var slot) && slot >= 0 && slot <= 4)
                {
                    var sv = ParseSticker(value);
                    if (sv is not null && sv.Def > 0) sl.Get(BaseTarget(target[..ix])).Stickers[slot] = sv;
                }
                break;
            }
            case "keychain":
            {
                var id = TailNum(value);
                if (id > 0) sl.Get(BaseTarget(target)).KeychainId = id;
                break;
            }
            case "seed":
            {
                if (int.TryParse(value, out var sd)) sl.Get(BaseTarget(target)).Seed = sd;
                break;
            }
            case "wear":
            {
                if (float.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, out var w)) sl.Get(BaseTarget(target)).Wear = w;
                break;
            }
            case "nametag":
            {
                sl.Get(BaseTarget(target)).Nametag = value == "off" ? "" : value;
                break;
            }
            case "stattrak":
            {
                sl.Get(BaseTarget(target)).StatTrak = value != "off" && value != "false" && value != "0";
                break;
            }
            case "sticker_wear":
            {
                if (int.TryParse(value, out var st)) sl.Get(BaseTarget(target)).StickerWearSteps = st;
                break;
            }
        }
    }

    static string BaseTarget(string t) => t;

    /// <summary>解析印花 value:"sticker-<def>[|wear|scale|rot|x|y|seedsteps]"(后段可空,兼容纯 id)。</summary>
    public static StkSlotV? ParseSticker(string value)
    {
        var parts = value.Split('|');
        var def = TailNum(parts[0]);
        if (def <= 0) return null;
        var sv = new StkSlotV { Def = def };
        if (parts.Length > 1 && float.TryParse(parts[1], System.Globalization.CultureInfo.InvariantCulture, out var w)) sv.Wear = Math.Clamp(w, 0f, 1f);
        if (parts.Length > 2 && float.TryParse(parts[2], System.Globalization.CultureInfo.InvariantCulture, out var sc)) sv.Scale = sc;
        if (parts.Length > 3 && float.TryParse(parts[3], System.Globalization.CultureInfo.InvariantCulture, out var ro)) sv.Rot = ro;
        if (parts.Length > 4 && float.TryParse(parts[4], System.Globalization.CultureInfo.InvariantCulture, out var xx)) sv.X = xx;
        if (parts.Length > 5 && float.TryParse(parts[5], System.Globalization.CultureInfo.InvariantCulture, out var yy)) sv.Y = yy;
        return sv;
    }

    static int TailPaint(string cid)
    {
        var ix = cid.LastIndexOf(':');
        if (ix >= 0 && int.TryParse(cid[(ix + 1)..], out var p)) return p;
        return int.TryParse(cid, out var q) ? q : -1;
    }
    static int TailNum(string cid)
    {
        var dash = cid.LastIndexOf('-');
        if (dash >= 0 && int.TryParse(cid[(dash + 1)..], out var n)) return n;
        return int.TryParse(cid, out var m) ? m : -1;
    }
}
