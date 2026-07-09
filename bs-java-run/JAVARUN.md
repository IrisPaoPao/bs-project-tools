# JAVARUN.md

## java 环境地址

/Users/zhangzhengqing/Library/Java/JavaVirtualMachines/corretto-1.8.0_492/Contents/Home

## nacos 配置参数

NACOS_HOST=172.18.163.52:30003
NACOS_NAMESPACE=saas-industry-dev

## JVM 参数

每行一个 JVM 参数，启动时自动拼接（`-D` / `-XX` / `-X` 均可，`JAVARUN.local.md` 里同名块会覆盖此处）。

本地对账调用链路：
- 所有本地服务统一使用 `/saas-industry` 作为服务端上下文路径和 Feign 调用前缀。
- `saas-reconciliation-assembly-server` 路由到本地 `saas-data-gateway`：`http://127.0.0.1:81/saas-industry`
- `saas-industry-assembly-server` 直接路由到远端行业网关：`http://172.18.163.52:30000/saas-industry`

```jvm-opts
-Dsaas.feign.context-path=/saas-industry
-Dserver.servlet.context-path=/saas-industry
-Dsaas-reconciliation-assembly-server.ribbon.NIWSServerListClassName=com.netflix.loadbalancer.ConfigurationBasedServerList
-Dsaas-reconciliation-assembly-server.ribbon.listOfServers=http://127.0.0.1:81
-Dsaas-industry-assembly-server.ribbon.NIWSServerListClassName=com.netflix.loadbalancer.ConfigurationBasedServerList
-Dsaas-industry-assembly-server.ribbon.listOfServers=http://172.18.163.52:30000
```

## 服务定义

> 格式：`| 服务名 | 路径 | 端口 |`，端口为空的是基础组件，不参与本地启动。

| 服务名                           | 路径                                                                            | 端口 |
| -------------------------------- | ------------------------------------------------------------------------------- |----|
| `saas-reconciliation-business` | `/Users/zhangzhengqing/work/project/vasService/saas-reconciliation-business/` | 82 |
| `saas-data-gateway` | `/Users/zhangzhengqing/work/project/vasService/saas-data-gateway/` | 81 |
| `saas-ybld-rpa` | `/Users/zhangzhengqing/work/project/vasService/saas-ybld-rpa/` | 83 |


## 登录配置

支持多环境、多账户。在 `JAVARUN.md`（共享模板）或 `JAVARUN.local.md`（本机私有，不提交仓库）中配置：

### 登录环境

> 格式：`| 别名 | 登录地址 | 登录接口 |`，账户通过「环境」列引用别名。

| 别名 | 登录地址 | 登录接口 |
|------|---------|---------|
|  |  | POST /saas-industry/saas/identity/industry/privatizationLogin |

### 登录账户

> 格式：`| 账户名 | 环境 | 主账号 | 用户名 | 密码 |`，「环境」列填写上面定义的别名。

| 账户名 | 环境 | 主账号 | 用户名 | 密码 |
|--------|------|--------|--------|------|
|  |  |  |  |  |

### 固定行为

| 配置项 | 值 |
|--------|---|
| Authorization 格式 | 直接使用 JWT Token，无 Bearer 前缀 |
| Authorization 请求头 | `authorization: <token>` |
| Token 来源 | 登录接口响应体 `response.token` 字段 |

> ⚠️ **重要**：登录接口的请求参数（用户名、主账号、密码）经过前端加密传输，无法直接用 curl 明文调用。必须通过 Playwright 脚本模拟浏览器操作来完成登录。

## 登录脚本

| 脚本 | 说明 |
|------|------|
| `login-script.cjs` | Playwright 版，推荐使用，可模拟完整浏览器登录流程 |
| `login.sh` | Shell 包装脚本，调用 login-script.cjs |
| `login-curl.sh` | curl 版（不可用，因接口参数加密） |

### 使用方式

```bash
# 交互选择账户，有头模式（可看到浏览器）
./login.sh
# 或：node bin/bs-java-run.js login

# 指定账户 + 无头模式
node bin/bs-java-run.js login --account dev-001 --headless

# 获取 token（无缓存，每次重新 headless 登录，自动复制到剪贴板）
node bin/bs-java-run.js token
node bin/bs-java-run.js token --account dev-001 --quiet
```

> 💡 `login` 和 `token` 命令默认会把获取到的 Token **自动复制到剪贴板**，直接粘贴即可使用。
> 如需关闭，加 `--no-clipboard`。`--quiet` 模式仍会复制，但不打印提示（方便管道使用）。
> `login` 默认有头模式；`token` 默认无头模式且不缓存，每次执行都重新登录。
