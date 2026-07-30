# JAVARUN.md

> `JAVARUN.md` 为团队共享的规则与使用说明文档（提交 Git 仓库）。
> 本机所有的实际运行配置（服务路径、运行环境、测试账号与密码）请配置在 `JAVARUN.local.md` 中（已被 `.gitignore` 保护）。
> 新成员可复制 `JAVARUN.local.md.example` 生成自己的 `JAVARUN.local.md`。
> 配置只支持下述环境化结构。`JAVARUN.local.md` 是本机唯一的运行配置来源。

---

## 🛠️ CLI 常用命令

```bash
# 查看服务运行状态
bs-java-run status

# 指定环境启动服务（支持主命令前置或后置）
bs-java-run --env zhsf-test-industry-02 start saas-zhsf-business
bs-java-run start saas-zhsf-business --env zhsf-test-industry-02

# 启动服务并打包
bs-java-run start saas-zhsf-business --build

# 重启服务（全逆序停止 -> 全正序启动）
bs-java-run restart saas-zhsf-business

# 停止服务（若有运行中的反向依赖服务，默认安全阻断）
bs-java-run stop saas-zhsf-base

# 级联停止依赖该服务的所有上游服务
bs-java-run stop saas-zhsf-base --cascade

# 强杀非本工具 PID / 端口残留进程
bs-java-run stop saas-zhsf-base --force

# 指定环境与账号获取 Token（quiet 模式 stdout 只输出纯净 token 字符串）
bs-java-run token --env zhsf-test-industry-02 --account test-zhsf-001 --quiet
```

---

## 📋 配置表语法规范 (于 JAVARUN.local.md 中配置)

### 1. java 环境地址
```markdown
## java 环境地址

/Library/Java/JavaVirtualMachines/corretto-1.8.0_492/Contents/Home
```

### 2. 运行环境
> 格式：`| 环境名 | Nacos 主机 | Nacos 命名空间 | 登录地址 | 登录接口 | 行业网关 | Feign 上下文 | 服务端上下文 |`
>
> 环境名是唯一标识，可自行命名；`--env`、`--profile`、`BS_ENV` 与账户、环境服务、JVM 参数组均使用该名称。

### 3. 账户定义
> 格式：`| 账户别名 | 环境 | 主账号 | 用户名 | 密码 |`

### 4. 服务定义
> 格式：`| 服务名 | 路径 | 端口 | 依赖服务 |`
>
> 服务定义只描述本机进程。Nacos 与 JVM 参数不得配置在此处。

### 5. 环境服务
> 格式：`| 环境名 | 服务名 | 专属 JVM 参数 |`
>
> 每一行表示该服务允许在该环境启动；专属 JVM 参数只用于内存等服务差异。

### 6. JVM 参数组
> 每个参数组必须与“运行环境”表中的环境名完全一致。即使参数内容相同，也应显式写入各环境参数组，避免跨环境继承。每组使用多行 `jvm-env-opts` 代码块：

### <env-name>
```jvm-env-opts
-Dexample.environment=true
```

---

## ⚙️ 优先级与求解规则

1. **四层 JVM 参数优先级链**：
   `CLI (--java-opt)` → `OS ENV (JAVA_OPTS)` → `环境服务专属` → `环境参数组`
   - Feign 上下文与服务端上下文由“运行环境”表自动生成，禁止在 JVM 参数组或环境服务中重复设置。
   - `server.port`、`loader.path`、`file.encoding`、`bs.javarun.instance` 由工具管理，禁止配置。
2. **运行环境必填**：
   `start`、`up`、`restart` 必须通过 `--env` 或 `BS_ENV` 选择环境；`build`、`status`、`stop` 不要求环境。
3. **PID 安全归属校验**：
   启动时自动生成 `-Dbs.javarun.instance=<UUID>`，停止前使用 `ps -ww -p` 长命令强校验 UUID 与模块名，拒绝误杀宿主其它进程。
4. **日志游标与截断复位**：
   基于增量日志游标 `{inode, byteOffset}` 消费日志，消除历史日志引发的提前解锁误判，保持错误排查现场。
