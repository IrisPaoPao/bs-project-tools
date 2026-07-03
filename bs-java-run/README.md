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

bs-java-run start [service]     # 启动已有 WAR（交互式选择）
bs-java-run start --yes         # 启动全部服务，不自动构建
bs-java-run start --yes --build # 构建后启动全部服务
bs-java-run start --yes --startup-timeout 600
bs-java-run up --yes            # 构建并启动全部服务

bs-java-run stop [service]      # 停止服务
bs-java-run stop --yes          # 停止全部服务

bs-java-run restart [service]   # 重启服务，不自动构建
bs-java-run restart --yes --build
bs-java-run status [service]    # 查看服务状态

# 登录 & Token
bs-java-run login               # 有头模式登录
bs-java-run login --headless    # 无头模式登录
bs-java-run login --quiet       # 只输出 token
bs-java-run token --quiet       # 查看缓存的 token
```

## 配置

配置文件为 `JAVARUN.md`，包含：
- Java 环境地址
- Nacos 配置参数
- 服务定义（服务名、路径、端口）
- 登录配置（地址、账号、密码）

可选的本地覆盖文件为 `JAVARUN.local.md`，不会提交到仓库，适合放登录账号、密码等本机私有配置。环境变量优先级最高，其次是 `JAVARUN.local.md`，最后是 `JAVARUN.md`。

## 环境变量

```bash
LOG_DIR                 # 日志目录（默认 ./logs）
NACOS_HOST              # Nacos 主机地址
NACOS_NAMESPACE         # Nacos 命名空间
BS_JAVA_HOME            # Java 路径
BS_LOGIN_TIMEOUT        # 登录超时时间（毫秒）
BS_LOGIN_URL            # 登录地址
BS_LOGIN_MAIN_ACCOUNT   # 主账号
BS_LOGIN_USERNAME       # 用户名
BS_LOGIN_PASSWORD       # 密码
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
