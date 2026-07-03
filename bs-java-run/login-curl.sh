#!/bin/bash
# ============================================================
# SAAS Industry 登录脚本 (curl 版)
#
# ⚠️ 注意：登录接口参数经过前端加密，无法直接用明文调用。
# 本脚本仅作为参考，实际登录请使用 login-script.cjs (Playwright 版)。
#
# 登录接口请求体格式（加密后）:
#   {
#     "captchaUuid": null,
#     "captchaCode": null,
#     "code": "<加密的用户名>",
#     "agencyMainAccount": "<加密的主账号>",
#     "password": "<加密的密码>",
#     "sign": null
#   }
# ============================================================

echo '{"success": false, "error": "登录接口参数经过前端加密，请使用 login-script.cjs (Playwright 版本)"}'
exit 1
