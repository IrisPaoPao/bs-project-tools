# JAVARUN.md

## java 环境地址

/Users/zhangzhengqing/Library/Java/JavaVirtualMachines/corretto-1.8.0_492/Contents/Home

## nacos 配置参数

NACOS_HOST=172.18.163.52:30003
NACOS_NAMESPACE=saas-industry-dev

## JVM 参数

每行一个 JVM 参数，启动时自动拼接（`-D` / `-XX` / `-X` 均可，`JAVARUN.local.md` 里同名块会覆盖此处）。

本地对账调用链路：
- 全局 Feign path 使用真实环境前缀：`/saas-industry`
- `saas-reconciliation-assembly-server` 路由到本地 `saas-data-gateway`：`http://127.0.0.1:81`
- `saas-industry-assembly-server` 路由到远端行业网关：`http://172.18.163.52:30000`

```jvm-opts
-Dsaas.feign.context-path=/saas-industry
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

| 配置项 | 值 |
|--------|---|
| 登录地址 |  |
| 主账号 |  |
| 用户名 |  |
| 密码 |  |
| 登录接口 | `POST /saas-industry/saas/identity/industry/privatizationLogin` |
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
# 有头模式（可看到浏览器）
./login.sh

# 无头模式（后台运行）
./login.sh --headless
```
