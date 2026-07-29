# JAVARUN.md

> `JAVARUN.md` 为团队共享的规则与使用说明文档（提交 Git 仓库）。
> 本机所有的实际运行配置（服务路径、运行环境、测试账号与密码）请配置在 `JAVARUN.local.md` 中（已被 `.gitignore` 保护）。
> 新成员可复制 `JAVARUN.local.md.example` 生成自己的 `JAVARUN.local.md`。
> 旧版 `运行环境` / `登录环境` / `登录账户` 表和三列表服务定义仍可读取；建议后续迁移到下述新表结构。

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
> 格式：`| 环境别名 | Nacos 主机 | Nacos 命名空间 | 登录地址 | 登录接口 | 行业网关 | Feign 上下文 | 服务端上下文 | 环境 JVM 参数 |`

### 3. 账户定义
> 格式：`| 账户别名 | 环境 | 主账号 | 用户名 | 密码 |`

### 4. 服务定义
> 格式：`| 服务名 | 路径 | 端口 | 依赖服务 | 专属 Nacos | 专属 Nacos 命名空间 | 专属 JVM 参数 |`

### 5. 环境 x 服务 专属覆盖
> 格式：`| 环境别名 | 服务名 | 专属 Nacos | 专属 Nacos 命名空间 | 专属 JVM 参数 |`

### 6. JVM 参数
> 直接在底部书写 ````jvm-opts` 代码块，便于直接粘贴多行全局默认参数：

```jvm-opts
-Dsaas.feign.context-path=/saas-industry
-Dserver.servlet.context-path=/saas-industry
```

---

## ⚙️ 优先级与求解规则

1. **六层 JVM 参数优先级链**：
   `CLI (--java-opt)` → `OS ENV (JAVA_OPTS)` → `环境×服务覆盖` → `服务专属` → `环境通用` → `全局默认`
2. **PID 安全归属校验**：
   启动时自动生成 `-Dbs.javarun.instance=<UUID>`，停止前使用 `ps -ww -p` 长命令强校验 UUID 与模块名，拒绝误杀宿主其它进程。
3. **日志游标与截断复位**：
   基于增量日志游标 `{inode, byteOffset}` 消费日志，消除历史日志引发的提前解锁误判，保持错误排查现场。
