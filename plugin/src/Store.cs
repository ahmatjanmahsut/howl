using System.Text;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using MySqlConnector;

namespace Howl;

/// <summary>一行外观选择(side/type/target/value)。</summary>
public readonly record struct HowlRow(string Side, string Type, string Target, string Value);

/// <summary>
/// Howl 数据库层:howl_selection(外观)/howl_data_meta(版本)/绑定码表。
/// 只用 MySqlConnector,所有方法为异步,调用方负责不碰游戏线程。
/// </summary>
public sealed class Store
{
    private readonly string _cs;
    private readonly ILogger _log;

    public Store(HowlConfig cfg, ILogger log)
    {
        _cs = $"Server={cfg.Database.Host};Port={cfg.Database.Port};User={cfg.Database.User};Password={cfg.Database.Password};Database={cfg.Database.Database};SslMode=Preferred;ConnectionTimeout=8;";
        _log = log;
    }

    private async Task<MySqlConnection> OpenAsync()
    {
        var c = new MySqlConnection(_cs);
        await c.OpenAsync();
        return c;
    }

    /// <summary>启动时幂等建表(表结构同 db/schema.sql)。</summary>
    public async Task EnsureSchemaAsync()
    {
        using var c = await OpenAsync();
        await using (var x = c.CreateCommand())
        {
            x.CommandText = """
                CREATE TABLE IF NOT EXISTS howl_selection (
                  steam_id   BIGINT UNSIGNED NOT NULL,
                  side       ENUM('ct','t','any') NOT NULL DEFAULT 'any',
                  sel_type   VARCHAR(24)  NOT NULL,
                  target     VARCHAR(64)  NOT NULL,
                  value      VARCHAR(128) NOT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (steam_id, side, sel_type, target),
                  KEY idx_steam (steam_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
                CREATE TABLE IF NOT EXISTS howl_data_meta (
                  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
                  fingerprint CHAR(64) NULL, game_updated_at TIMESTAMP NULL, game_version VARCHAR(32) NULL,
                  web_updated_at TIMESTAMP NULL, web_version VARCHAR(32) NULL, counts_json JSON NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
                INSERT IGNORE INTO howl_data_meta (id) VALUES (1);
                """;
            await x.ExecuteNonQueryAsync();
        }
        // 绑定码表(web 端同表;插件只写码)
        await using (var x = c.CreateCommand())
        {
            x.CommandText = """
                CREATE TABLE IF NOT EXISTS howl_bind_codes (
                  code CHAR(6) NOT NULL, steamid64 VARCHAR(20) NOT NULL, persona VARCHAR(64) NULL,
                  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
                  used_by INT UNSIGNED NULL, used_at TIMESTAMP NULL,
                  PRIMARY KEY (code), KEY idx_sid (steamid64)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
                CREATE TABLE IF NOT EXISTS howl_steam (
                  steamid64 VARCHAR(20) NOT NULL, user_id INT UNSIGNED NOT NULL, persona VARCHAR(64) NULL,
                  is_primary TINYINT(1) NOT NULL DEFAULT 1, bound_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (steamid64), KEY idx_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
                """;
            await x.ExecuteNonQueryAsync();
        }
    }

    public async Task<List<HowlRow>> LoadRowsAsync(ulong steam)
    {
        var rows = new List<HowlRow>();
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        q.CommandText = "SELECT side,sel_type,target,value FROM howl_selection WHERE steam_id=@s";
        q.Parameters.AddWithValue("@s", steam);
        await using var rd = await q.ExecuteReaderAsync();
        while (await rd.ReadAsync())
            rows.Add(new HowlRow(rd.GetString(0), rd.GetString(1), rd.GetString(2), rd.GetString(3)));
        return rows;
    }

    /// <summary>在线玩家外观指纹(count@maxUpdatedAt),变化即触发即时生效。</summary>
    public async Task<Dictionary<ulong, string>> FingerprintAsync(IEnumerable<ulong> steams)
    {
        var map = new Dictionary<ulong, string>();
        var ids = steams.ToList();
        if (ids.Count == 0) return map;
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        q.CommandText = $"SELECT steam_id, COUNT(*) n, MAX(UNIX_TIMESTAMP(updated_at)) t FROM howl_selection WHERE steam_id IN ({string.Join(",", ids)}) GROUP BY steam_id";
        await using var rd = await q.ExecuteReaderAsync();
        while (await rd.ReadAsync())
        {
            if (await rd.IsDBNullAsync(1)) continue;
            map[rd.GetFieldValue<ulong>(0)] = rd.GetInt64(1) + "@" + rd.GetFieldValue<ulong>(2);
        }
        return map;
    }

    public async Task SetRowAsync(ulong steam, string side, string type, string target, string value)
    {
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        q.CommandText = "INSERT INTO howl_selection (steam_id,side,sel_type,target,value) VALUES (@s,@d,@t,@g,@v) ON DUPLICATE KEY UPDATE value=VALUES(value)";
        q.Parameters.AddWithValue("@s", steam); q.Parameters.AddWithValue("@d", side);
        q.Parameters.AddWithValue("@t", type); q.Parameters.AddWithValue("@g", target); q.Parameters.AddWithValue("@v", value);
        await q.ExecuteNonQueryAsync();
    }

    public async Task DeleteRowAsync(ulong steam, string side, string type, string target)
    {
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        q.CommandText = "DELETE FROM howl_selection WHERE steam_id=@s AND side=@d AND sel_type=@t AND target=@g";
        q.Parameters.AddWithValue("@s", steam); q.Parameters.AddWithValue("@d", side);
        q.Parameters.AddWithValue("@t", type); q.Parameters.AddWithValue("@g", target);
        await q.ExecuteNonQueryAsync();
    }

    /// <summary>清一把枪的全部外观(含贴纸/挂件/磨损等附属行);side 传 null 清三侧。</summary>
    public async Task ClearWeaponAsync(ulong steam, string? side, string entity)
    {
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        var sideCond = side == null ? "" : " AND side=@d";
        q.CommandText = $"DELETE FROM howl_selection WHERE steam_id=@s{sideCond} AND ((sel_type='weapon' AND target=@g) OR (sel_type='sticker' AND target LIKE CONCAT(@g,':%')) OR (sel_type IN ('keychain','seed','wear','nametag','stattrak') AND target=@g))";
        q.Parameters.AddWithValue("@s", steam);
        if (side != null) q.Parameters.AddWithValue("@d", side);
        q.Parameters.AddWithValue("@g", entity);
        await q.ExecuteNonQueryAsync();
    }

    /// <summary>清一类:knife / glove / agent / music / weapons-all / all。</summary>
    public async Task ClearCategoryAsync(ulong steam, string? side, string category)
    {
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        var sideCond = side == null ? "" : " AND side=@d";
        string cond = category switch
        {
            "knife" => "(sel_type IN ('knife','knife_type') OR (sel_type IN ('seed','wear','nametag','stattrak','keychain') AND target='knife') OR (sel_type='sticker' AND target LIKE 'knife:%'))",
            "glove" => "(sel_type='glove' OR (sel_type IN ('seed','wear','nametag','stattrak','keychain') AND target='glove') OR (sel_type='sticker' AND target LIKE 'glove:%'))",
            "agent" => "sel_type='agent'",
            "music" => "sel_type='music_kit'",
            _ => "1=1",
        };
        if (category == "all") { q.CommandText = "DELETE FROM howl_selection WHERE steam_id=@s"; q.Parameters.AddWithValue("@s", steam); await q.ExecuteNonQueryAsync(); return; }
        if (category == "weapons_all")
            cond = "(sel_type='weapon' OR sel_type='sticker' OR (sel_type IN ('keychain','seed','wear','nametag','stattrak') AND target NOT IN ('knife','glove')))";
        q.CommandText = $"DELETE FROM howl_selection WHERE steam_id=@s{sideCond} AND {cond}";
        q.Parameters.AddWithValue("@s", steam);
        if (side != null) q.Parameters.AddWithValue("@d", side);
        await q.ExecuteNonQueryAsync();
    }

    /// <summary>记录游戏服数据版本(供 Web 展示"两侧是否一致")。</summary>
    public async Task UpdateGameMetaAsync(string fingerprint, string countsJson)
    {
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        q.CommandText = "UPDATE howl_data_meta SET fingerprint=@f, game_updated_at=NOW(), game_version=@v, counts_json=@c WHERE id=1";
        q.Parameters.AddWithValue("@f", fingerprint);
        q.Parameters.AddWithValue("@v", fingerprint.Length >= 12 ? fingerprint[..12] : fingerprint);
        q.Parameters.AddWithValue("@c", countsJson);
        await q.ExecuteNonQueryAsync();
    }

    /// <summary>生成绑定码(!howlbind)。</summary>
    public async Task<string?> CreateBindCodeAsync(ulong steam, string persona, int ttlMinutes)
    {
        const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        using var c = await OpenAsync();
        await using (var q = c.CreateCommand())
        {
            q.CommandText = "SELECT 1 FROM howl_steam WHERE steamid64=@s";
            q.Parameters.AddWithValue("@s", steam.ToString());
            if (await q.ExecuteScalarAsync() is not null) return null;   // 已绑定
        }
        for (var att = 0; att < 8; att++)
        {
            var sb = new StringBuilder(6);
            for (var i = 0; i < 6; i++) sb.Append(Alphabet[Random.Shared.Next(Alphabet.Length)]);
            var code = sb.ToString();
            await using (var chk = c.CreateCommand())
            {
                chk.CommandText = "SELECT 1 FROM howl_bind_codes WHERE code=@c AND used_by IS NULL";
                chk.Parameters.AddWithValue("@c", code);
                if (await chk.ExecuteScalarAsync() is not null) continue;
            }
            await using var ins = c.CreateCommand();
            ins.CommandText = "INSERT INTO howl_bind_codes (code,steamid64,persona,expires_at) VALUES (@c,@s,@p,DATE_ADD(NOW(),INTERVAL @m MINUTE))";
            ins.Parameters.AddWithValue("@c", code); ins.Parameters.AddWithValue("@s", steam.ToString());
            ins.Parameters.AddWithValue("@p", persona); ins.Parameters.AddWithValue("@m", Math.Clamp(ttlMinutes, 1, 240));
            await ins.ExecuteNonQueryAsync();
            return code;
        }
        return null;
    }

    public async Task<bool> IsSteamBoundAsync(ulong steam)
    {
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        q.CommandText = "SELECT 1 FROM howl_steam WHERE steamid64=@s";
        q.Parameters.AddWithValue("@s", steam.ToString());
        return await q.ExecuteScalarAsync() is not null;
    }

    public async Task CleanupCodesAsync()
    {
        using var c = await OpenAsync();
        await using var q = c.CreateCommand();
        q.CommandText = "DELETE FROM howl_bind_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 3 DAY)";
        await q.ExecuteNonQueryAsync();
    }
}
