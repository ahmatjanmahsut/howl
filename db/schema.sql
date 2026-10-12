-- ============================================================
-- Howl 换肤系统 · MySQL 表结构(库名 howl,MySQL 8.0+)
-- 插件端启动时自动建表(EnsureSchema),本文件用于手工部署与审阅。
-- 行式协议(插件注入引擎与 Web 端三方一致):
--   howl_selection 每行 = 一个外观项:
--     side     : 'ct' | 't' | 'any'(any = 全局项,如音乐盒/探员)
--     sel_type : weapon | knife_type | knife | glove | agent | music_kit
--                | sticker | keychain | seed | wear | nametag | stattrak | sticker_wear
--     target   : 武器实体名(weapon_ak47)/ 'knife' / 'glove'
--                / 贴纸槽 'weapon_ak47:2' / 探员阵营 'ct'|'t' / 音乐盒 'music'
--     value    : 皮肤类 '<皮肤所属武器实体>:<paint_index>'(混搭时前缀可为他枪)
--                knife_type '<weapon_knife_*>'; glove '<手套型号>:<paint>';
--                agent 'agent-<def_index>'; music_kit '<def_index>';
--                sticker 'sticker-<def_index>'; keychain 'keychain-<def_index>';
--                seed 整数 / wear 小数 / stattrak '1'|'off' / nametag 文本 / sticker_wear 步数
--   读取优先级:同 key 时 side='ct'/'t' 的行覆盖 side='any' 的行。
-- ============================================================

CREATE DATABASE IF NOT EXISTS howl DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE howl;

-- 玩家外观选择(AstraSkins 同源协议 + CT/T 分边)
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

-- 目录数据版本元信息(游戏服插件与 Web 各自写自己那一列,展示/排障用)
CREATE TABLE IF NOT EXISTS howl_data_meta (
  id              TINYINT UNSIGNED NOT NULL PRIMARY KEY,       -- 恒为 1
  fingerprint     CHAR(64)      NULL,                          -- 最近一次同步的 CSGO-API 指纹
  game_updated_at TIMESTAMP NULL,                              -- 游戏服插件侧最近自动更新时间
  game_version    VARCHAR(32)  NULL,                            -- 游戏服侧数据版本(指纹前 12 位)
  web_updated_at  TIMESTAMP NULL,                              -- Web 侧最近自动更新时间
  web_version     VARCHAR(32)  NULL,                            -- Web 侧数据版本
  counts_json     JSON          NULL                            -- 各目录条目数快照
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO howl_data_meta (id) VALUES (1);

-- Web 账号(Cookie 会话;角色三级:user < admin < superadmin)
CREATE TABLE IF NOT EXISTS howl_users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32)  NOT NULL,
  email         VARCHAR(190) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('user','admin','superadmin') NOT NULL DEFAULT 'user',
  status        ENUM('active','banned') NOT NULL DEFAULT 'active',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_username (username),
  UNIQUE KEY uq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SteamID 与 账号绑定
CREATE TABLE IF NOT EXISTS howl_steam (
  steamid64  VARCHAR(20) NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  persona    VARCHAR(64) NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 1,
  bound_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (steamid64),
  KEY idx_user (user_id),
  CONSTRAINT fk_howl_steam_user FOREIGN KEY (user_id) REFERENCES howl_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 游戏内 !howlbind 生成的 6 位绑定码
CREATE TABLE IF NOT EXISTS howl_bind_codes (
  code       CHAR(6) NOT NULL,
  steamid64  VARCHAR(20) NOT NULL,
  persona    VARCHAR(64) NULL,
  issued_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  used_by    INT UNSIGNED NULL,
  used_at    TIMESTAMP NULL,
  PRIMARY KEY (code),
  KEY idx_sid (steamid64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 授权建议:
-- CREATE USER 'howl'@'%' IDENTIFIED BY '<密码>';
-- GRANT SELECT,INSERT,UPDATE,DELETE,CREATE ON howl.* TO 'howl'@'%';
