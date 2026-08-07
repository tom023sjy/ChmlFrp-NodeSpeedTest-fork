/**
 * API 端点集中管理
 *
 * 所有对外服务的地址统一在此维护，方便后续变更。
 * 修改时只需调整本文件，无需改动各业务服务。
 *
 * 命名规范：`<系统名>_<用途>`
 */

// ===== ChmlFrp 官方 API（节点、隧道、用户信息） =====
export const CHMLFRP_API_BASE_URL = "https://cf-v2.uapis.cn";

// ===== qzhua OAuth（账号授权） =====
export const QZHUA_OAUTH_ISSUER = "https://account-api.qzhua.net";
export const QZHUA_OAUTH_CLIENT_ID = "019d5ce39a9b728fa1b5565be72d84ca";
export const QZHUA_OAUTH_CLIENT_SECRET = "";

// ===== 自建后端 API（使用量统计、登录、问题上报） =====
// 官方部署地址，如需变更仅修改此处
export const BACKEND_API_BASE_URL = "https://api.cct.zdzz.top";

// ===== 应用更新源 =====
export const UPDATE_API_URL = "https://u.zdzz.top/api/node-selector.json";

// ===== 官方链接 =====
export const OFFICIAL_LINKS = {
  chmlfrp: "https://www.chmlfrp.net",
  historyVersions: "https://u.zdzz.top/app/node-selector",
  github: "https://github.com/zhengddzz/ChmlFrp-Community-Toolbox",
  chmlfrpLauncher: "https://github.com/TechCat-Team/ChmlFrpLauncher",
} as const;
