# bs-java-run

BS Java 服务运行管理 CLI 工具。

## 安装

```bash
git clone <仓库地址> bs-java-run
cd bs-java-run
npm install
```

## 使用方式

### 方式一：全局安装（推荐）

```bash
cd bs-java-run
npm link

# 然后任何地方都能用
bs-java-run status
bs-java-run start --yes
```

### 方式二：不安装，直接运行

```bash
cd bs-java-run
node bin/bs-java-run.js --help

# 或者添加到 PATH
export PATH="/Users/zhangzhengqing/work/project/bs-project-tools/bs-java-run/bin:$PATH"
```

### 方式三：npx（无需安装）

```bash
# 进入项目目录后
npx bs-java-run status
```

## 命令

```bash
bs-java-run --help              # 查看帮助
bs-java-run --version           # 查看版本

# 服务管理
bs-java-run build [service]     # 构建服务（交互式选择）
bs-java-run build --yes         # 构建全部服务

bs-java-run start [service] --env 52test     # 启动该环境内已有 WAR
bs-java-run start --yes --env 52test         # 启动该环境全部服务，不自动构建
bs-java-run start --yes --env 52test --build # 构建后启动该环境全部服务
bs-java-run start --yes --env 52test --startup-timeout 600
bs-java-run up --yes --env 52test            # 构建并启动该环境全部服务

bs-java-run stop [service]      # 停止服务
bs-java-run stop --yes          # 停止全部服务

bs-java-run restart [service]   # 重启服务，不自动构建
bs-java-run restart --yes --build
bs-java-run status [service]    # 查看服务状态

# 登录 & Token（多账户）
bs-java-run login                       # 有头模式登录，交互选择账户
bs-java-run login --account dev-001     # 指定账户
bs-java-run login --headless --quiet    # 无头模式，只输出 token
bs-java-run token                       # 重新 headless 登录获取 token（用上次账户，免交互）
bs-java-run token --account prod-001    # 指定账户重新获取
```

### 聚合目录工作区

为多仓库聚合目录生成独立的启动配置与根目录快捷命令。首次初始化会交互录入运行环境、Nacos、登录连接信息和可用用户；密码无回显并仅写入工作区私有配置：

```bash
bs-java-run workspace init /path/to/reconciliation_all

cd /path/to/reconciliation_all
./javarun doctor                         # 校验 Java、Maven、配置和构建产物
./javarun status                         # 使用工作区自己的日志/PID 目录
./javarun up saas-data-gateway --env dev --yes
./javarun smoke saas-data-gateway --env dev --build
./javarun update                         # 重扫服务并更新受托管配置
./javarun update --configure             # 合并录入环境、Nacos 和可用用户
./javarun update --configure --replace-all # 全量覆盖（展示删除项后需二次确认）
```

初始化会在目标根目录生成 `javarun` 和 `.bs-java-run/`。后者的 `JAVARUN.md`、清单和日志由工具管理；`JAVARUN.local.md` 保存 Java 路径与用户密码，普通更新不会覆盖。`update --configure` 默认按名称合并：新增环境会保留现有环境及账户，同名环境只更新其连接配置，账户可跳过并在登录前补充。每次配置写入前都会输出不含敏感值的差异摘要，并同时备份共享与私有配置。只有 `--replace-all` 可删除未重新录入的环境或账户，且会展示删除项并二次确认。生成的是轻量转发脚本，运行时仍依赖生成时记录的 `bs-java-run` 路径。

配置文件分为共享模板 `JAVARUN.md` 与本机私有配置 `JAVARUN.local.md`：
- **`JAVARUN.md`**：提交到 Git 仓库的公共标准模板。
- **`JAVARUN.local.md`**：已加入 `.gitignore`，存放个人本机的源码绝对路径、个人测试账号密码与环境化运行配置。

新成员初始化配置：
```bash
cp JAVARUN.local.md.example JAVARUN.local.md
# 然后根据个人环境编辑 JAVARUN.local.md 中的本地绝对路径和密码
```

## 环境变量

```bash
LOG_DIR                 # 日志目录（默认 ./logs）
NACOS_HOST              # Nacos 主机地址
NACOS_NAMESPACE         # Nacos 命名空间
BS_JAVA_HOME            # Java 路径
BS_LOGIN_TIMEOUT        # 登录超时时间（毫秒）
BS_STARTUP_TIMEOUT      # 服务启动等待超时时间，单位秒（默认 420）
```

## 构建失败处理

`build`、`start --build`、`up`、`restart --build` 遇到 Maven 依赖解析失败时会立即停止，并输出缺失依赖坐标、仓库线索和失败命令，交给人工排查依赖发布、仓库访问或版本问题。工具不会建议修改 `pom.xml`、替换 jar 或做临时依赖修复。

Java 编译错误等非依赖类 Maven 失败仍按普通构建失败处理。

## 向后兼容

以下脚本保留为兼容包装（内部调用 CLI）：
- `build_services.sh`
- `start_services.sh`
- `stop_services.sh`
- `restart_services.sh`
- `status_services.sh`
- `login.sh`
