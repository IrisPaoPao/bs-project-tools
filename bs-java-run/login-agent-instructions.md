# SAAS Industry 登录 - Agent 操作说明

## 概述

本文档说明 Agent 如何完成 SAAS Industry 系统登录并获取 Authorization Token。

## 登录参数

通过 `JAVARUN.md` / `JAVARUN.local.md` 的「登录环境」和「登录账户」表配置（支持多环境、多账户）。账户通过「环境」列引用环境别名。

```bash
# 推荐：用共享脚本登录（交互选择账户，无头模式）
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-java-run
npm install
./login.sh --headless

# 指定账户
./login.sh --account dev-001 --headless

# 快速获取 token（用上次账户，免交互）
node bin/bs-java-run.js token --quiet
```

脚本执行成功后会直接输出登录 Token，复制使用即可。

### 备用方式：Playwright MCP 浏览器登录

如果脚本方式不可用，可使用 Playwright MCP 进行浏览器登录。由于页面元素选择器是动态生成的，**请勿使用硬编码的假选择器**，需按以下流程操作：

1. **导航到登录页**：调用 `browser_navigate` 打开登录地址
2. **识别真实输入框**：调用 `browser_snapshot` 获取当前页面的真实元素快照
3. **填写表单**：根据 snapshot 返回的真实元素引用，依次调用 `browser_type` 填入主账号、用户名、密码
4. **提交登录**：根据 snapshot 识别"马上登录"按钮，调用 `browser_click` 提交
5. **获取 Token**：调用 `browser_network_requests` 监听网络请求，找到 `privatizationLogin` 接口响应
6. **提取 Token**：从该接口的 response-body 中提取 `token` 字段

## 获取 Authorization

登录成功后，从登录接口响应中获取 Token：

```
接口: POST /saas-industry/saas/identity/industry/privatizationLogin
响应字段: response.token
Authorization 格式: 直接使用 Token，无 Bearer 前缀
请求头: authorization: <token>
```

## 注意事项

1. ⚠️ 登录接口参数经过前端加密，无法用 curl 直接调用
2. 主账号和用户名如果勾选了「记住账号」会自动填充
3. Token 有效期约 7.5 小时（JWT exp 字段）
4. 后续请求携带 `authorization: <token>` 头即可
