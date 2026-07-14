# bs-jenkins-cli

`bs-jenkins-cli` 是一个基于 Python 编写的命令行工具，用于直接在终端与你的 Jenkins 服务器进行交互。
它支持多 Jenkins 服务器环境，可以在不打开浏览器的情况下快速查看任务、触发构建以及追踪构建结果。

## 🌟 特性

- **多服务器支持**：支持在多个 Jenkins 服务器之间无缝切换。
- **美观的终端输出**：使用 `rich` 库提供带有颜色和格式的表格与状态显示。
- **实时跟踪**：触发构建后，自动分配并跟踪队列中的构建，并等待其执行完毕返回结果。
- **多分支流水线支持**：完美支持针对 Jenkins 多分支流水线的子分支进行直接构建。
- **参数化构建**：支持传递构建参数。

## 📦 安装与配置

推荐使用 `pipx` 进行全局安装，这样你可以在系统任何地方直接调用 `bsq-jenkins` 命令。

### 1. 安装
```bash
# 如果没有 pipx，请先安装 (brew install pipx 或 python3 -m pip install --user pipx)
pipx install -e . --force
```
*(如果没有 `pipx`，也可以直接运行 `./install.sh` 退化到虚拟环境安装)*

### 2. 配置
该工具依赖全局配置文件 `~/.bsq-jenkins.json`。
请将本项目下的 `config.example.json` 复制到用户目录并填写你的 Jenkins 账号信息：

```bash
cp config.example.json ~/.bsq-jenkins.json
```
然后在 `~/.bsq-jenkins.json` 中配置你的服务器别名、URL 以及账号密码。

## 🚀 使用指南

工具的全局命令为 `bsq-jenkins`，默认使用配置文件中的 `default_server` (如 `saas-jenkins`)。如果要操作其他服务器，可以使用 `-s <服务器别名>`。

### 1. 查看任务列表
```bash
bsq-jenkins jobs
# 指定其他服务器
bsq-jenkins -s tax-jenkins jobs
```

### 2. 触发构建
默认情况下，触发构建后命令会阻塞并显示实时构建状态，直到构建结束（成功/失败）。

**常规任务：**
```bash
bsq-jenkins build <任务名称>
```

**多分支流水线（Multibranch Pipeline）任务：**
不要使用参数传分支名，请将分支作为子目录拼接：
```bash
bsq-jenkins build my-project/job/main
```

**带参数的构建（Parameterized Build）：**
通过 `-p` 传递构建参数，可以多次使用：
```bash
bsq-jenkins build some-job -p env=prod -p version=1.0.0
```

**触发后不等待（异步）：**
如果你不想在终端干等结果，可以添加 `--no-wait`：
```bash
bsq-jenkins build <任务名称> --no-wait
```

### 3. 查看最新构建状态
```bash
bsq-jenkins status <任务名称>
```

## 🛠 开发依赖

- `click` - 用于构建 CLI 框架
- `requests` - 处理 HTTP 请求和 API 调用
- `rich` - 华丽的终端 UI 输出
