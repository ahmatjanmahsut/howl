using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CS2MenuManager.API.Class;
using CS2MenuManager.API.Enum;
using CS2MenuManager.API.Interface;
using CS2MenuManager.API.Menu;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace Howl;

/// <summary>
/// Howl 游戏内全中文菜单。交互仿 AstraSkins(类别 → 武器 → 皮肤 → 磨损/贴纸/挂件/名称暗金),
/// 加入 CT/T 分边编辑(主菜单一键换边,所有配置按边保存)与跨武器混搭(!howlfind 搜索任意皮肤)。
/// 菜单选项只负责"选",落库 + 实时生效统一走 HowlPlugin.Set/Del。
/// </summary>
public sealed class HowlMenu
{
    private readonly HowlPlugin _hp;

    private sealed class Nav
    {
        public string Side = "ct";     // 当前编辑边
        public string Cat = "rifles";
        public string? Weapon;         // 正在编辑的武器实体 / "knife" / "glove"
        public int Page;
        public int StkSlot;
        public string? StkEnt;
        public string? StkGroup;
        public string? GloveSel;       // 本次会话选中的手套型号(未选皮肤前的临时态)
    }

    private readonly Dictionary<int, Nav> _nav = new();
    public HowlMenu(HowlPlugin hp) { _hp = hp; }

    private Nav Get(CCSPlayerController p)
    {
        if (!_nav.TryGetValue(p.Slot, out var n)) { n = new Nav(); _nav[p.Slot] = n; }
        return n;
    }

    public void Forget(int slot) => _nav.Remove(slot);

    /// <summary>当前正在编辑的武器实体(皮肤/磨损/名称命令的目标)。</summary>
    public string? CurrentEnt(CCSPlayerController p) => Get(p).Weapon;
    /// <summary>当前编辑边。</summary>
    public string CurrentSide(CCSPlayerController p) => Get(p).Side;
    /// <summary>最近一次进入的贴纸目标与槽。</summary>
    public (string Ent, int Slot) CurrentSticker(CCSPlayerController p)
    {
        var n = Get(p);
        var ent = n.StkEnt ?? n.Weapon;
        if (string.IsNullOrEmpty(ent)) return ("", 0);
        return (ent, n.StkSlot);
    }

    // CS2MenuManager 屏幕菜单(现网 CS2Suite 验证过的用法):构造函数 (标题, 插件)
    WasdMenu New(string title) => new WasdMenu(title, _hp) { ExitButton = true, MenuTime = 0 };
    static string Cut(string s, int max = 30) => s.Length <= max ? s : s[..(max - 1)] + "…";
    void Tell(CCSPlayerController p, string msg) { try { p.PrintToChat(" [Howl] \x01" + msg); } catch { } }
    void Close(CCSPlayerController p) { /* PostSelectAction.Close:选择后自动关闭 */ }
    string SideZh(Nav n) => n.Side == "ct" ? "CT" : "T";

    PlayerLook? LookOf(CCSPlayerController p) => p.SteamID == 0 ? null : _hp.EngineOf.Cached((ulong)p.SteamID);
    SideLook? CurSide(CCSPlayerController p, Nav n)
    {
        var lk = LookOf(p);
        if (lk is null) { _hp.RequestLoad(p); }   // 异步补读库,菜单先按空档案展示
        return lk?.For(n.Side == "ct");
    }
    string CurKnifeEntity(CCSPlayerController p, Nav n) => CurSide(p, n)?.KnifeType ?? "weapon_knife";
    string CurGloveModel(CCSPlayerController p, Nav n) => n.GloveSel ?? CurSide(p, n)?.GloveModel ?? "";

    // ================= 主菜单 =================
    public void OpenMain(CCSPlayerController p)
    {
        var n = Get(p);
        n.Side = p.Team == CsTeam.Terrorist ? "t" : "ct";   // 打开菜单默认对齐当前阵营(可在菜单切换)
        var cat = _hp.Catalog;
        var m = New("Howl 换肤 · 主菜单");
        
        m.AddItem($"编辑阵营:{ChatColors.Yellow}{SideZh(n)} 边{ChatColors.Default}(点击切换 {(n.Side == "ct" ? "T" : "CT")})", (pl, _) =>
        {
            n.Side = n.Side == "ct" ? "t" : "ct";
            n.Weapon = null; n.Page = 0;
            OpenMain(pl);
        });
        foreach (var (key, zh) in new[]
        {
            ("rifles", "步枪"), ("snipers", "狙击步枪"), ("pistols", "手枪"), ("smgs", "微型冲锋枪"), ("heavy", "重型武器"),
            ("knife", "匕首"), ("glove", "手套"), ("agent", "探员"), ("music", "音乐盒(全局)")
        })
        {
            if (key == "glove" && !_hp.Config.Features.Gloves) continue;
            if (key == "agent" && !_hp.Config.Features.Agents) continue;
            if (key == "music" && !_hp.Config.Features.MusicKits) continue;
            var k = key;
            m.AddItem(zh + (key == "music" ? "" : $" [{SideZh(n)}]"), (pl, _) =>
            {
                n.Cat = k; n.Page = 0;
                switch (k)
                {
                    case "knife": OpenKnifeTypes(pl); break;
                    case "glove": OpenGloveModels(pl); break;
                    case "agent": OpenAgents(pl); break;
                    case "music": OpenMusic(pl); break;
                    default: n.Weapon = null; OpenWeaponList(pl); break;
                }
            });
        }
        m.AddItem("跨武器混搭皮肤(搜索任意皮肤)", (pl, _) => OpenMixHelp(pl));
        m.AddItem("清除 / 重置外观", (pl, _) => OpenReset(pl));
        m.AddItem("使用说明", (pl, _) => OpenHelp(pl));
        m.AddItem($"目录:{ChatColors.Grey}{(cat is null ? "未加载(稍后自动更新)" : $"皮肤 {cat.AllSkins.Count} · 贴纸 {cat.Stickers.Count} · 版本 {cat.Fingerprint[..8]}")}{ChatColors.Default}", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("关闭菜单", (pl, _) => Close(pl));
        m.Display(p, 0);
    }

    // ================= 武器列表 =================
    void OpenWeaponList(CCSPlayerController p)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Tell(p, "目录未加载,稍后再试(或控制台执行 howl_update 立即更新)。"); Close(p); return; }
        var lk = LookOf(p);
        var sl = lk?.For(n.Side == "ct");
        IEnumerable<WeaponDef> list = cat.Weapons.Where(w => n.Cat switch
        {
            "rifles" => w.Category == "rifles" && !w.IsSniper,
            "snipers" => w.Category == "rifles" && w.IsSniper,
            "pistols" => w.Category == "pistols",
            "smgs" => w.Category == "smgs",
            "heavy" => w.Category == "heavy",
            _ => false
        });
        if (_hp.Config.TeamSpecificLoadouts)
            list = n.Side == "ct" ? list.Where(w => w.CanCt) : list.Where(w => w.CanT);
        var m = New($"选择武器 · {CatZh(n.Cat)} [{SideZh(n)}]");
        
        foreach (var w in list)
        {
            var ent = w.Entity;
            var sel = sl is not null && sl.Weapons.TryGetValue(ent, out var e0) && e0.Paint > 0;
            m.AddItem((sel ? "✓ " : "") + Cut(w.Zh) + $" {ChatColors.Grey}({Cut(w.En, 18)}){ChatColors.Default}", (pl, _) =>
            {
                n.Weapon = ent; n.Page = 0;
                OpenWeaponHub(pl);
            });
        }
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }

    string CatZh(string k) => k switch
    {
        "rifles" => "步枪", "snipers" => "狙击步枪", "pistols" => "手枪", "smgs" => "微型冲锋枪", "heavy" => "重型武器", _ => k
    };

    // ================= 单武器功能页 =================
    void OpenWeaponHub(CCSPlayerController p)
    {
        var n = Get(p);
        var ent = n.Weapon ?? "weapon_ak47";
        var m = New($"{SkinName(p, n, ent)} · 功能 [{SideZh(n)}]");
        
        m.AddItem("皮肤", (pl, _) => { Get(pl).Page = 0; OpenSkins(pl, ent); });
        m.AddItem("磨损与模板", (pl, _) => OpenWear(pl, ent));
        if (_hp.Config.Features.Stickers)
            m.AddItem($"贴纸(最多 {_hp.Config.MaxStickersPerWeapon} 张)", (pl, _) => OpenStickerSlots(pl, ent));
        if (_hp.Config.Features.Keychains)
            m.AddItem("挂件", (pl, _) => { Get(pl).Page = 0; OpenKeychains(pl, ent); });
        if (_hp.Config.Features.Nametags || _hp.Config.Features.StatTrak)
            m.AddItem("名称牌 / 暗金", (pl, _) => OpenNameTag(pl, ent));
        m.AddItem("清除这件外观", (pl, _) => { _hp.ClearWeapon(pl, ent); OpenWeaponList(pl); });
        m.AddItem("◀ 返回武器列表", (pl, _) => OpenWeaponList(pl));
        m.Display(p, 0);
    }

    string SkinName(CCSPlayerController p, Nav n, string ent)
    {
        var cat = _hp.Catalog;
        if (cat is null) return ent;
        if (ent == "knife")
            return cat.KnifeByEntity.TryGetValue(CurKnifeEntity(p, n), out var k) ? k.Zh : "匕首";
        if (ent == "glove")
        {
            var gm = CurGloveModel(p, n);
            return gm.Length > 0 && cat.GloveByModel.TryGetValue(gm, out var g) ? g.Zh : "手套";
        }
        return cat.WeaponByEntity.TryGetValue(ent, out var w) ? w.Zh : ent;
    }

    private bool cur2Legacy(string ent, SideLook? sl)
    {
        if (sl is null) return false;
        var id = ent == "knife" ? sl.Knife.SkinId : ent == "glove" ? sl.Gloves.SkinId : (sl.Weapons.TryGetValue(ent, out var e) ? e.SkinId : "");
        return id.Length > 0 && _hp.Catalog?.SkinById.TryGetValue(id, out var s) == true && s.Legacy;
    }

    static string SkinTypeOf(string ent) => ent == "knife" ? "knife" : ent == "glove" ? "glove" : "weapon";
    static string TypeName(string ent) => ent == "knife" ? "刀" : ent == "glove" ? "手套" : "枪";

    // ================= 皮肤页 =================
    void OpenSkins(CCSPlayerController p, string ent)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        List<SkinDef> skins = ent switch
        {
            "knife" => cat.KnifeByEntity.TryGetValue(CurKnifeEntity(p, n), out var kn) ? kn.Skins : new(),
            "glove" => cat.GloveByModel.TryGetValue(CurGloveModel(p, n), out var gl) ? gl.Skins : new(),
            _ => cat.WeaponByEntity.TryGetValue(ent, out var w) ? w.Skins : new()
        };
        var st = SkinTypeOf(ent);
        var curId = CurSide(p, n)?.Get(ent).SkinId ?? "";
        int per = Math.Clamp(_hp.Config.MenuPageSize, 10, 60);
        int pages = Math.Max(1, (int)Math.Ceiling(skins.Count / (double)per));
        n.Page = Math.Clamp(n.Page, 0, pages - 1);

        var m = New($"{SkinName(p, n, ent)} · 皮肤 [{SideZh(n)}] {n.Page + 1}/{pages}");
        
        m.AddItem((curId.Length == 0 ? "✓ " : "  ") + "原皮(清除皮肤)", (pl, _) => { _hp.Del(pl, st, ent); n.Page = 0; OpenSkins(pl, ent); });
        foreach (var s in skins.Skip(n.Page * per).Take(per))
        {
            var owner = ent == "knife" ? CurKnifeEntity(p, n) : ent == "glove" ? CurGloveModel(p, n) : ent;
            var mixed = !string.Equals(s.OwnerEntity, owner, StringComparison.OrdinalIgnoreCase);
            m.AddItem((curId == s.SkinId ? "✓ " : "") + Cut(s.Zh) + $" {ChatColors.Grey}[{s.RarityZh}{(mixed ? "|混搭自 " + Cut(s.OwnerEntity.Replace("weapon_", ""), 12) : "")}]{ChatColors.Default}",
                (pl, _) =>
                {
                    // 手套:先记住型号再写皮肤行
                    if (ent == "glove" && n.GloveSel is not null) { }
                    _hp.Set(pl, st, ent == "knife" ? CurKnifeEntity(pl, n) : ent, s.SkinId, rebuild: true, global: ent == "glove");
                    if (ent == "knife") _hp.Del(pl, st, "knife", true);   // 型号专属行生效,清掉旧兜底行避免歧义
                    Tell(pl, $"已应用:{s.Zh}({s.RarityZh})");
                    OpenSkins(pl, ent);
                });
        }
        if (n.Page + 1 < pages) m.AddItem($"▶ 下一页({n.Page + 2}/{pages},共 {skins.Count} 款)", (pl, _) => { n.Page++; OpenSkins(pl, ent); });
        if (n.Page > 0) m.AddItem("◀ 上一页", (pl, _) => { n.Page--; OpenSkins(pl, ent); });
        m.AddItem($"混搭其他武器皮肤:聊天输入 {ChatColors.Yellow}!howlfind 关键词{ChatColors.Default} → 应用到本{TypeName(ent)}", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("◀ 返回", (pl, _) =>
        {
            switch (ent)
            {
                case "knife": OpenKnifeTypes(pl); break;
                case "glove": OpenGloveModels(pl); break;
                default: OpenWeaponHub(pl); break;
            }
        });
        m.Display(p, 0);
    }

    // ================= 刀型 =================
    void OpenKnifeTypes(CCSPlayerController p)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        var cur = CurSide(p, n)?.KnifeType;
        var m = New($"选择刀型 [{SideZh(n)}]");
        
        m.AddItem("清除刀的外观", (pl, _) => { _hp.Del(pl, "knife_type", "knife"); _hp.Del(pl, "knife", "knife"); OpenKnifeTypes(pl); });
        foreach (var k in cat.Knives)
            m.AddItem((cur == k.Entity ? "✓ " : "") + Cut(k.Zh) + $" {ChatColors.Grey}({k.Skins.Count} 皮肤){ChatColors.Default}", (pl, _) =>
            {
                _hp.Set(pl, "knife_type", "knife", k.Entity, rebuild: true, global: true);
                n.Weapon = "knife"; n.Page = 0;
                OpenSkins(pl, "knife");
            });
        m.AddItem("已选刀型 → 皮肤/磨损/贴纸/挂件", (pl, _) => { n.Weapon = "knife"; OpenWeaponHub(pl); });
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }

    // ================= 手套 =================
    void OpenGloveModels(CCSPlayerController p)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        var cur = CurGloveModel(p, n);
        var m = New($"选择手套 [{SideZh(n)}]");
        
        m.AddItem("清除手套外观", (pl, _) => { _hp.Del(pl, "glove", "glove"); n.GloveSel = null; OpenGloveModels(pl); });
        foreach (var g in cat.Gloves)
            m.AddItem((cur == g.Model ? "✓ " : "") + Cut(g.Zh) + $" {ChatColors.Grey}({g.Skins.Count} 皮肤){ChatColors.Default}", (pl, _) =>
            {
                n.GloveSel = g.Model;
                n.Weapon = "glove"; n.Page = 0;
                OpenSkins(pl, "glove");
            });
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }

    // ================= 磨损 =================
    void OpenWear(CCSPlayerController p, string ent)
    {
        var n = Get(p);
        var e = CurSide(p, n)?.Get(ent);
        var m = New($"磨损 · {SkinName(p, n, ent)} [{SideZh(n)}]");
        
        (string zh, float v)[] tiers =
        [
            ("崭新出厂", 0.01f), ("略有磨损", 0.10f), ("久经沙场", 0.25f), ("破损不堪", 0.40f), ("战痕累累", 0.65f),
        ];
        var curWear = e?.Wear ?? -1f;
        foreach (var (zh, v) in tiers)
            m.AddItem((Math.Abs(curWear - v) < 0.005f ? "✓ " : "") + $"{zh}({v:0.00})", (pl, _) => { _hp.Set(pl, "wear", ent, v.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture), rebuild: false); OpenWear(pl, ent); });
        m.AddItem("跟随默认(磨损 0)", (pl, _) => { _hp.Del(pl, "wear", ent); OpenWear(pl, ent); });
        m.AddItem($"当前 Seed:{(e?.Seed >= 0 ? e.Seed : "默认")} 精确设置:聊天 {ChatColors.Yellow}!howlseed 0~8192{ChatColors.Default}", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem($"精确磨损:聊天 {ChatColors.Yellow}!howlwear 0.1234{ChatColors.Default}", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("◀ 返回", (pl, _) => OpenWeaponHub(pl));
        m.Display(p, 0);
    }

    // ================= 名称/暗金 =================
    void OpenNameTag(CCSPlayerController p, string ent)
    {
        var n = Get(p);
        var e = CurSide(p, n)?.Get(ent);
        var m = New($"名称与暗金 · {SkinName(p, n, ent)}");
        
        if (_hp.Config.Features.Nametags)
        {
            m.AddItem($"当前名称牌:{(e?.Nametag?.Length > 0 ? e.Nametag : "无")}", (_, _) => { }, DisableOption.DisableShowNumber);
            m.AddItem($"设置:聊天 {ChatColors.Yellow}!howlname 文字{ChatColors.Default}(清除 !howlname off)", (_, _) => { }, DisableOption.DisableShowNumber);
        }
        if (_hp.Config.Features.StatTrak)
            m.AddItem($"{(e?.StatTrak == true ? "✓ " : "")}暗金 StatTrak:{(e?.StatTrak == true ? "开" : "关")}(点击切换)",
                (pl, _) => { _hp.Set(pl, "stattrak", ent, e?.StatTrak == true ? "off" : "1", rebuild: true); OpenNameTag(pl, ent); });
        m.AddItem("◀ 返回", (pl, _) => OpenWeaponHub(pl));
        m.Display(p, 0);
    }

    // ================= 贴纸 =================
    void OpenStickerSlots(CCSPlayerController p, string ent)
    {
        var n = Get(p);
        var e = CurSide(p, n)?.Get(ent);
        var m = New($"贴纸 · {SkinName(p, n, ent)} [{SideZh(n)}]");
        
        for (int i = 0; i < Math.Clamp(_hp.Config.MaxStickersPerWeapon, 1, 5); i++)
        {
            var slot = i;
            var sid = e is not null && e.Stickers.TryGetValue(slot, out var v0) ? v0.Def : 0;
            var name = sid > 0 ? (_hp.Catalog?.Stickers.FirstOrDefault(x => x.Def == sid)?.Zh ?? $"贴纸 {sid}") : "未选择";
            m.AddItem($"槽 {slot + 1}:{Cut(name, 22)}{(sid > 0 ? "(点击移除)" : "")}", (pl, _) =>
            {
                if (sid > 0) { _hp.Del(pl, "sticker", ent + ":" + slot); OpenStickerSlots(pl, ent); return; }
                n.StkEnt = ent; n.StkSlot = slot;
                OpenStickerGroups(pl);
            });
        }
        m.AddItem($"快速搜索:聊天 {ChatColors.Yellow}!howlstkfind 关键词{ChatColors.Default}", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("◀ 返回", (pl, _) => OpenWeaponHub(pl));
        m.Display(p, 0);
    }

    void OpenStickerGroups(CCSPlayerController p)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        n.Page = 0;
        var groups = cat.Stickers.GroupBy(s => s.Group.Length > 0 ? s.Group : "其他")
            .Select(g => (name: g.Key, count: g.Count(), year: g.Max(s => s.Year)))
            .OrderByDescending(x => x.year).ThenByDescending(x => x.count).Take(30).ToList();
        var m = New($"贴纸分组 · 目标 {SkinName(p, n, n.StkEnt ?? "weapon_ak47")} 槽 {n.StkSlot + 1}");
        
        foreach (var g in groups)
            m.AddItem($"{Cut(g.name, 26)} {ChatColors.Grey}({g.count}){ChatColors.Default}", (pl, _) =>
            {
                Get(pl).StkGroup = g.name; Get(pl).Page = 0;
                OpenStickersInGroup(pl);
            });
        m.AddItem("◀ 返回槽位", (pl, _) => OpenStickerSlots(pl, Get(pl).StkEnt ?? "weapon_ak47"));
        m.Display(p, 0);
    }

    void OpenStickersInGroup(CCSPlayerController p)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        var list = cat.Stickers.Where(s => (s.Group.Length > 0 ? s.Group : "其他") == n.StkGroup).OrderBy(s => s.Def).ToList();
        int per = Math.Clamp(_hp.Config.MenuPageSize, 10, 60);
        int pages = Math.Max(1, (int)Math.Ceiling(list.Count / (double)per));
        n.Page = Math.Clamp(n.Page, 0, pages - 1);
        var m = New($"贴纸 · {Cut(n.StkGroup ?? "", 18)} {n.Page + 1}/{pages} → 槽 {n.StkSlot + 1}");
        
        foreach (var s in list.Skip(n.Page * per).Take(per))
            m.AddItem(Cut(s.Zh, 26), (pl, _) =>
            {
                _hp.Set(pl, "sticker", (n.StkEnt ?? "weapon_ak47") + ":" + n.StkSlot, s.Id, rebuild: true);
                OpenStickerSlots(pl, n.StkEnt ?? "weapon_ak47");
            });
        if (n.Page + 1 < pages) m.AddItem($"▶ 下一页({n.Page + 2}/{pages})", (pl, _) => { n.Page++; OpenStickersInGroup(pl); });
        if (n.Page > 0) m.AddItem("◀ 上一页", (pl, _) => { n.Page--; OpenStickersInGroup(pl); });
        m.AddItem("◀ 返回分组", (pl, _) => OpenStickerGroups(pl));
        m.Display(p, 0);
    }

    // ================= 挂件 =================
    void OpenKeychains(CCSPlayerController p, string ent)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        int per = Math.Clamp(_hp.Config.MenuPageSize, 10, 60);
        int pages = Math.Max(1, (int)Math.Ceiling(cat.Keychains.Count / (double)per));
        n.Page = Math.Clamp(n.Page, 0, pages - 1);
        var cur = CurSide(p, n)?.Get(ent).KeychainId ?? 0;
        var m = New($"挂件 · {SkinName(p, n, ent)} {n.Page + 1}/{pages}");
        
        m.AddItem((cur <= 0 ? "✓ " : "") + "不挂(移除挂件)", (pl, _) => { _hp.Del(pl, "keychain", ent); OpenKeychains(pl, ent); });
        foreach (var k in cat.Keychains.Skip(n.Page * per).Take(per))
            m.AddItem((cur == k.Def ? "✓ " : "") + Cut(k.Zh, 26) + $" {ChatColors.Grey}({k.RarityZh}){ChatColors.Default}", (pl, _) =>
            {
                _hp.Set(pl, "keychain", ent, k.Id, rebuild: true);
                OpenKeychains(pl, ent);
            });
        if (n.Page + 1 < pages) m.AddItem($"▶ 下一页({n.Page + 2}/{pages})", (pl, _) => { n.Page++; OpenKeychains(pl, ent); });
        if (n.Page > 0) m.AddItem("◀ 上一页", (pl, _) => { n.Page--; OpenKeychains(pl, ent); });
        m.AddItem("◀ 返回", (pl, _) => OpenWeaponHub(pl));
        m.Display(p, 0);
    }

    // ================= 探员 =================
    void OpenAgents(CCSPlayerController p)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        var lk = LookOf(p);
        var cur = n.Side == "ct" ? lk?.AgentCt : lk?.AgentT;
        var list = cat.Agents.Where(a => a.Team == "both" || a.Team == n.Side).ToList();
        int per = Math.Clamp(_hp.Config.MenuPageSize, 10, 60);
        int pages = Math.Max(1, (int)Math.Ceiling(list.Count / (double)per));
        n.Page = Math.Clamp(n.Page, 0, pages - 1);
        var m = New($"探员 [{SideZh(n)}] {n.Page + 1}/{pages}");
        
        m.AddItem("清除探员(默认模型)", (pl, _) => { _hp.Del(pl, "agent", n.Side); OpenAgents(pl); });
        foreach (var a in list.Skip(n.Page * per).Take(per))
            m.AddItem((cur == a.Id ? "✓ " : "") + Cut(a.Zh, 30), (pl, _) =>
            {
                _hp.Set(pl, "agent", n.Side, a.Id, rebuild: false);
                OpenAgents(pl);
            });
        if (n.Page + 1 < pages) m.AddItem($"▶ 下一页({n.Page + 2}/{pages})", (pl, _) => { n.Page++; OpenAgents(pl); });
        if (n.Page > 0) m.AddItem("◀ 上一页", (pl, _) => { n.Page--; OpenAgents(pl); });
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }

    // ================= 音乐盒 =================
    void OpenMusic(CCSPlayerController p)
    {
        var n = Get(p);
        var cat = _hp.Catalog;
        if (cat is null) { Close(p); return; }
        var cur = LookOf(p)?.MusicKit ?? 0;
        int per = Math.Clamp(_hp.Config.MenuPageSize, 10, 60);
        int pages = Math.Max(1, (int)Math.Ceiling(cat.Music.Count / (double)per));
        n.Page = Math.Clamp(n.Page, 0, pages - 1);
        var m = New($"音乐盒(全局) {n.Page + 1}/{pages}");
        
        m.AddItem((cur <= 0 ? "✓ " : "") + "不使用音乐盒", (pl, _) => { _hp.Del(pl, "music_kit", "music"); OpenMusic(pl); });
        foreach (var mu in cat.Music.Skip(n.Page * per).Take(per))
            m.AddItem((cur == mu.Kit ? "✓ " : "") + Cut(mu.Zh, 30), (pl, _) =>
            {
                _hp.Set(pl, "music_kit", "music", mu.Kit.ToString(), rebuild: false);
                OpenMusic(pl);
            });
        if (n.Page + 1 < pages) m.AddItem($"▶ 下一页({n.Page + 2}/{pages})", (pl, _) => { n.Page++; OpenMusic(pl); });
        if (n.Page > 0) m.AddItem("◀ 上一页", (pl, _) => { n.Page--; OpenMusic(pl); });
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }

    // ================= 混搭搜索 =================
    public void OpenFind(CCSPlayerController p, string kw)
    {
        var n = Get(p);
        var ent = n.Weapon;
        if (string.IsNullOrWhiteSpace(ent))
        {
            Tell(p, "先在 !howl 菜单选好要编辑的武器/刀/手套(进入它的皮肤页),再输入 !howlfind 关键词。");
            return;
        }
        var cat = _hp.Catalog;
        if (cat is null) { Tell(p, "目录未加载。"); return; }
        var hits = cat.SearchSkins(kw, 120);
        if (hits.Count == 0) { Tell(p, $"没有匹配「{kw}」的皮肤。"); return; }
        int per = Math.Clamp(_hp.Config.MenuPageSize, 10, 60);
        var m = New($"混搭「{Cut(kw, 12)}」→ {SkinName(p, n, ent)}(共 {hits.Count} 条,显示 {Math.Min(per, hits.Count)} 条)");
        
        foreach (var s in hits.Take(per))
            m.AddItem($"{Cut(s.Zh, 24)} {ChatColors.Grey}[{s.RarityZh}|{Cut(s.OwnerEntity.Replace("weapon_", ""), 12)}]{ChatColors.Default}", (pl, _) =>
            {
                _hp.Set(pl, SkinTypeOf(ent), ent, s.SkinId, rebuild: true);
                Tell(pl, $"已把「{s.Zh}」混搭到 {SkinName(pl, Get(pl), ent)}");
            });
        m.AddItem("▶ 换更精确的关键词再搜", (pl, _) => Tell(pl, "用法:!howlfind 关键词"));
        m.AddItem("◀ 返回皮肤页", (pl, _) => OpenSkins(pl, ent));
        m.Display(p, 0);
    }

    // ================= 贴纸搜索 =================
    public void OpenStickerFind(CCSPlayerController p, string kw)
    {
        var n = Get(p);
        if (string.IsNullOrWhiteSpace(n.StkEnt))
        {
            if (string.IsNullOrWhiteSpace(n.Weapon)) { Tell(p, "先 !howl 菜单选武器(或武器→贴纸→槽位),再 !howlstkfind 关键词。"); return; }
            n.StkEnt = n.Weapon; n.StkSlot = 0;
        }
        var cat = _hp.Catalog;
        if (cat is null) { Tell(p, "目录未加载。"); return; }
        var hits = cat.SearchStickers(kw, 90);
        if (hits.Count == 0) { Tell(p, $"没有匹配「{kw}」的贴纸。"); return; }
        int per = Math.Clamp(_hp.Config.MenuPageSize, 10, 60);
        var m = New($"贴纸「{Cut(kw, 12)}」→ {SkinName(p, n, n.StkEnt!)} 槽 {n.StkSlot + 1}(共 {hits.Count})");
        
        foreach (var s in hits.Take(per))
            m.AddItem($"{Cut(s.Zh, 26)} {ChatColors.Grey}[{s.TypeZh}]{ChatColors.Default}", (pl, _) =>
            {
                _hp.Set(pl, "sticker", n.StkEnt + ":" + n.StkSlot, s.Id, rebuild: true);
                Tell(pl, $"已贴「{s.Zh}」");
            });
        m.AddItem("◀ 返回槽位", (pl, _) => OpenStickerSlots(pl, Get(pl).StkEnt ?? "weapon_ak47"));
        m.Display(p, 0);
    }

    // ================= 重置 =================
    void OpenReset(CCSPlayerController p)
    {
        var n = Get(p);
        var m = New("清除 / 重置外观");
        
        m.AddItem($"清除当前武器({(n.Weapon is null ? "未选择" : SkinName(p, n, n.Weapon))})", (pl, _) =>
        {
            if (Get(pl).Weapon is null) { Tell(pl, "先在菜单里选一把武器。"); return; }
            _hp.ClearWeapon(pl, Get(pl).Weapon!);
            OpenReset(pl);
        });
        m.AddItem($"清除 {SideZh(n)} 边全部枪械外观", (pl, _) => { _hp.ClearCategory(pl, "weapons_all"); OpenReset(pl); });
        m.AddItem("清除刀", (pl, _) => { _hp.ClearCategory(pl, "knife"); OpenReset(pl); });
        m.AddItem("清除手套", (pl, _) => { _hp.ClearCategory(pl, "glove"); OpenReset(pl); });
        m.AddItem("清除探员(两边)", (pl, _) => { _hp.ClearCategory(pl, "agent"); OpenReset(pl); });
        m.AddItem("清除音乐盒", (pl, _) => { _hp.ClearCategory(pl, "music"); OpenReset(pl); });
        m.AddItem($"{ChatColors.Red}清除本账号全部外观{ChatColors.Default}", (pl, _) => { _hp.ClearCategory(pl, "all"); Tell(pl, "已全部清除,回到默认外观。"); Close(pl); });
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }

    void OpenMixHelp(CCSPlayerController p)
    {
        var m = New("跨武器混搭");
        
        m.AddItem("1) 先用菜单选一把武器(进入它的皮肤页)", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem($"2) 聊天输入 {ChatColors.Yellow}!howlfind 皮肤名{ChatColors.Default},例:!howlfind 火蛇", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("3) 从结果里点选,即把该皮肤混搭到当前武器", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("提示:跨武器涂装部分图案可能显示异常,属正常现象", (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("▶ 现在就去选武器", (pl, _) => OpenWeaponList(pl));
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }

    public void OpenHelp(CCSPlayerController p)
    {
        var n = Get(p);
        var m = New("Howl 使用说明");
        
        foreach (var line in new[]
        {
            "!howl 打开换肤菜单",
            "!howlfind 关键词 → 跨武器混搭皮肤",
            "!howlstkfind 关键词 → 搜索贴纸贴到当前槽",
            "!howlname 文字(off 清除)→ 名称牌",
            "!howlwear 0~1 / !howlseed 数字 → 磨损与模板",
            "!howlstattrak on|off → 暗金",
            $"!howlbind 获取网页绑定码(面板:{_hp.Config.WebUrl})",
            "网页改完约 3 秒内游戏内自动生效;换边/重生后自动按数据库恢复",
            $"当前编辑边:{SideZh(n)}(主菜单第一项可切换)"
        })
            m.AddItem(line, (_, _) => { }, DisableOption.DisableShowNumber);
        m.AddItem("◀ 返回主菜单", (pl, _) => OpenMain(pl));
        m.Display(p, 0);
    }
}
