using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace Howl;

/// <summary>
/// Howl 注入引擎:直接给武器/手套实体写经济属性并触发状态同步。
/// 属性写法沿用线上验证过的 AstraBind 注入实现(与 AstraSkins 的 EconAttributeApplicator 同源):
///   set item texture prefab / seed / wear → AttributeList + NetworkedDynamicAttributes 双写;
///   StatTrak → kill eater 属性 + bodygroup;贴纸 sticker slot N;挂件 keychain slot 0。
/// 换肤必须"实体重建 + 新实体最后上漆",原地改属性客户端不会重渲染(见 Engine.Reequip)。
/// </summary>
public sealed class HowlInjector
{
    private const string SignatureKey = "Howl_CAttributeList_SetOrAddAttributeValueByName";
    private readonly ILogger _log;
    private readonly MemoryFunctionVoid<nint, string, float>? _setAttr;
    private readonly BasePlugin _plugin;
    private ulong _nextItemId = 2_000_000UL;
    private HowlCatalog _cat;

    public bool Available => _setAttr is not null;
    public void UseCatalog(HowlCatalog cat) => _cat = cat;

    public HowlInjector(BasePlugin plugin, ILogger log, HowlCatalog cat)
    {
        _plugin = plugin; _log = log; _cat = cat;
        try
        {
            var sig = GameData.GetSignature(SignatureKey);
            if (string.IsNullOrWhiteSpace(sig))
            {
                _log.LogWarning("[Howl] 缺少 gamedata/howl.json 签名(应放至 addons/counterstrikesharp/gamedata/howl.json),注入引擎不可用");
                return;
            }
            _setAttr = new MemoryFunctionVoid<nint, string, float>(sig);
        }
        catch (Exception ex) { _log.LogWarning("[Howl] 签名加载失败: " + ex.Message); }
    }

    private static float F(int unsignedBits) => BitConverter.Int32BitsToSingle(unsignedBits);

    private void WriteBoth(CEconItemView item, Action<nint> apply)
    {
        item.AttributeList.Attributes.RemoveAll();
        item.NetworkedDynamicAttributes.Attributes.RemoveAll();
        apply(item.AttributeList.Handle);
        apply(item.NetworkedDynamicAttributes.Handle);
    }

    private void NextItemId(CEconItemView item)
    {
        var id = _nextItemId++;
        item.ItemID = id;
        item.ItemIDLow = (uint)(id & 0xFFFFFFFF);
        item.ItemIDHigh = (uint)(id >> 32);
    }

    /// <summary>对一把武器实体注入(皮肤/刀型/贴纸/挂饰/StatTrak/改名)。返回是否动了它。</summary>
    public bool InjectWeapon(CCSPlayerController player, CBasePlayerWeapon weapon, HowlEntry e)
    {
        if (!Available || weapon?.IsValid != true || player is not { IsValid: true }) return false;
        try
        {
            var item = weapon.AttributeManager?.Item;
            if (item is null || item.Handle == IntPtr.Zero) return false;

            bool isKnife = e.Entity == "knife" || (weapon.DesignerName ?? "").Contains("knife");
            bool hasSkin = e.Paint > 0;
            bool hasExtras = e.Stickers.Count > 0 || e.KeychainId > 0 || e.StatTrak || !string.IsNullOrWhiteSpace(e.Nametag);
            if (!hasSkin && !hasExtras && !isKnife) return false;   // 这件没配置,别碰

            if (isKnife)
            {
                var wantDef = e.KnifeDefIndex;
                if (wantDef > 0 && item.ItemDefinitionIndex != (ushort)wantDef)
                    weapon.AcceptInput("ChangeSubclass", value: wantDef.ToString());
                if (wantDef > 0) item.ItemDefinitionIndex = (ushort)wantDef;
                item.EntityQuality = e.StatTrak ? 9 : 3;
            }
            else item.EntityQuality = e.StatTrak ? 9 : 0;

            item.AccountID = (uint)player.SteamID;
            NextItemId(item);

            var h1 = item.AttributeList.Handle;
            var h2 = item.NetworkedDynamicAttributes.Handle;

            if (!hasSkin)
            {
                WriteBoth(item, _ => { });
                item.CustomName = e.Nametag;
                item.CustomNameOverride = e.Nametag;
                WriteExtras(item, weapon, e, h1, h2);
                Utilities.SetStateChanged(weapon, "CEconEntity", "m_pAttributeManager");
                return true;
            }

            var seed = e.Seed >= 0 ? e.Seed : 0;
            var wear = Math.Clamp(e.Wear >= 0 ? e.Wear : 0f, 0f, 1f);   // Howl 磨损默认 0
            weapon.FallbackPaintKit = e.Paint;
            weapon.FallbackSeed = seed;
            weapon.FallbackWear = wear;
            WriteBoth(item, h =>
            {
                _setAttr!.Invoke(h, "set item texture prefab", e.Paint);
                _setAttr.Invoke(h, "set item texture seed", seed);
                _setAttr.Invoke(h, "set item texture wear", wear);
            });
            weapon.AcceptInput("SetBodygroup", value: $"body,{(e.Legacy ? 1 : 0)}");
            item.CustomName = e.Nametag;
            item.CustomNameOverride = e.Nametag;
            WriteExtras(item, weapon, e, h1, h2);
            Utilities.SetStateChanged(weapon, "CEconEntity", "m_pAttributeManager");
            _log.LogInformation($"[Howl] 注入 {weapon.DesignerName} paint={e.Paint} wear={wear:0.####} seed={seed} legacy={e.Legacy} ST={e.StatTrak} 贴纸[{string.Join(",", e.Stickers.Select(kv => kv.Key + ":" + kv.Value.Def + (kv.Value.Wear > 0 ? "/w" + kv.Value.Wear : "")))}] 挂件={e.KeychainId}");
            return true;
        }
        catch (Exception ex) { _log.LogWarning("[Howl] InjectWeapon " + weapon.DesignerName + " 异常: " + ex.Message); return false; }
    }

    private void WriteExtras(CEconItemView item, CBasePlayerWeapon weapon, HowlEntry e, nint h1, nint h2)
    {
        if (e.StatTrak)
        {
            weapon.AcceptInput("SetBodygroup", value: "stattrak,1");
            foreach (var h in new[] { h1, h2 })
            {
                _setAttr!.Invoke(h, "kill eater", F(0));
                _setAttr.Invoke(h, "kill eater score type", 0);
            }
        }
        // 对齐 AstraSkins 生产验证的"最小写入":贴纸只写 id;
        // wear/scale/rotation/offset 仅当用户显式设置过才写(缺省属性=出厂位置,兼容性最好)
        foreach (var (slot, sv) in e.Stickers)
        {
            var isDefaultLayout = Math.Abs(sv.Scale - 1f) < 0.001f && Math.Abs(sv.Rot) < 0.001f && Math.Abs(sv.X) < 0.001f && Math.Abs(sv.Y) < 0.001f;
            var wearF = Math.Clamp(sv.Wear > 0 ? sv.Wear : e.StickerWearSteps / 10f, 0f, 1f);
            foreach (var h in new[] { h1, h2 })
            {
                _setAttr!.Invoke(h, $"sticker slot {slot} id", F(sv.Def));
                if (wearF > 0f) _setAttr.Invoke(h, $"sticker slot {slot} wear", wearF);
                if (!isDefaultLayout)
                {
                    _setAttr.Invoke(h, $"sticker slot {slot} offset x", sv.X);
                    _setAttr.Invoke(h, $"sticker slot {slot} offset y", sv.Y);
                    _setAttr.Invoke(h, $"sticker slot {slot} rotation", sv.Rot);
                    _setAttr.Invoke(h, $"sticker slot {slot} scale", sv.Scale);
                }
            }
        }
        if (e.KeychainId > 0)
            foreach (var h in new[] { h1, h2 })
                _setAttr!.Invoke(h, "keychain slot 0 id", F(e.KeychainId));   // 与 AstraSkins 一致:挂件只写 id
    }

    /// <summary>手套:写 pawn.EconGloves + lastinv 刷新 + 第一/三人称 bodygroup 翻转。</summary>
    public void InjectGloves(CCSPlayerController player, SideLook sl)
    {
        if (!Available || sl.Gloves.Paint <= 0 || sl.GloveModel.Length == 0) return;
        if (player.PlayerPawn?.Value is not CCSPlayerPawn pawn || !pawn.IsValid) return;
        try
        {
            var item = pawn.EconGloves;
            if (item.Handle == IntPtr.Zero) return;
            item.AccountID = (uint)player.SteamID;
            NextItemId(item);
            if (_cat.GloveByModel.TryGetValue(sl.GloveModel, out var gd) && gd.Def > 0) item.ItemDefinitionIndex = (ushort)gd.Def;
            item.EntityQuality = sl.Gloves.StatTrak ? 9 : 3;
            item.Initialized = true;
            var seed = sl.Gloves.Seed >= 0 ? sl.Gloves.Seed : 0;
            var wear = Math.Clamp(sl.Gloves.Wear >= 0 ? sl.Gloves.Wear : 0f, 0f, 1f);
            WriteBoth(item, h =>
            {
                _setAttr!.Invoke(h, "set item texture prefab", sl.Gloves.Paint);
                _setAttr.Invoke(h, "set item texture seed", seed);
                _setAttr.Invoke(h, "set item texture wear", wear);
            });
            player.ExecuteClientCommand("lastinv");
            pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,0");
            _plugin.AddTimer(0.2f, () =>
            {
                if (player.IsValid && pawn.IsValid) pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,1");
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        catch (Exception ex) { _log.LogDebug("[Howl] InjectGloves: " + ex.Message); }
    }

    /// <summary>音乐盒:写 MusicKitID 并广播状态。</summary>
    public void ApplyMusic(CCSPlayerController player, int kitId)
    {
        if (kitId <= 0 || player.IsBot) return;
        try
        {
            player.MusicKitID = kitId;
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_iMusicKitID");
        }
        catch { }
    }

    /// <summary>探员:SetModel(pawn)。agentId 形如 "agent-4619"。</summary>
    public void ApplyAgent(CCSPlayerController player, string agentId)
    {
        if (agentId.Length == 0) return;
        var ag = _cat.Agents.FirstOrDefault(a => a.Id == agentId);
        if (ag is null || ag.Model.Length == 0) return;
        if (player.PlayerPawn?.Value is not CCSPlayerPawn pawn || !pawn.IsValid) return;
        Server.NextFrame(() =>
        {
            try { if (pawn.IsValid) pawn.SetModel(ag.Model); } catch { }
        });
    }

    /// <summary>按刀型实体找到其 def(ChangeSubclass 用)。</summary>
    public int KnifeDefOf(string knifeEntity) => _cat.KnifeByEntity.TryGetValue(knifeEntity, out var k) ? k.Def : 0;
}
