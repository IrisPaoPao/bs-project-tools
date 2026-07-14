# bs-jira-cli

命令行 Jira 管理工具，基于 Jira REST API v2，深度适配 Jira v6.0.5（问题管理系统）。
它不仅支持标准的 Issue 管理，还内置了智能 JQL 解析、多条件别名、中文账号适配和附件解析。

## 安装

推荐使用 `pipx` 直接从 Git 仓库全局安装（无需克隆代码），这会将 `bsq-jira` 暴露为全局命令，且不会污染你的 Python 环境：

```bash
pipx install "git+ssh://git@ssh.github.com:443/IrisPaoPao/bs-project-tools.git#subdirectory=bs-jira-cli"
```
*(日后更新只需执行 `pipx install --force ...` 即可)*

如果你没有 pipx，也可以使用传统的 pip 或源码安装：
```bash
# pip 全局安装
pip install "git+ssh://git@ssh.github.com:443/IrisPaoPao/bs-project-tools.git#subdirectory=bs-jira-cli"

# 源码克隆安装
git clone ssh://git@ssh.github.com:443/IrisPaoPao/bs-project-tools.git
cd bs-project-tools/bs-jira-cli
./install.sh   # 或者 pip install -e .
```

## 快速开始

```bash
# 1. 初始化配置（交互式输入账号密码，密码会被加密存储）
bsq-jira config init

# 2. 测试连接
bsq-jira config test

# 3. 使用高级别名直接搜索（比如查询当前未解决的需求）
bsq-jira search @我的需求当前
```

## 命令参考

### 配置管理

配置保存在 `~/.jira-cli/config.json`，在任何地方安装工具都可共享配置。

```bash
bsq-jira config init                   # 初始化配置（交互式）
bsq-jira config init --url http://... --username user --password pass  # 非交互式
bsq-jira config show                   # 查看当前配置（密码脱敏）
bsq-jira config test                   # 测试连接
```

### JQL 搜索与别名 (🔥 核心功能)

针对 Jira v6.0.5 和复杂的内部中文字段，我们对 `search` 做了深度优化。你可以直接定义常用 JQL 的别名（Alias）。

```bash
# 1. 管理别名
bsq-jira alias list                                 # 查看所有别名
bsq-jira alias add my-bugs "project = YLZHXT AND status = 开发中"  # 添加别名
bsq-jira alias remove my-bugs                       # 删除别名

# 2. 搜索（支持直接调用别名，且会自动处理合并多重 ORDER BY 防止报错）
bsq-jira search @my-bugs                            # 直接使用别名
bsq-jira search "@my-bugs AND affectedVersion='V2.0.3'"  # 别名组合过滤！

# 3. 快捷搜索选项
bsq-jira search --mine                     # 我报告的 Issue
bsq-jira search --assigned-to-me           # 分配给我的
bsq-jira search --assigned-to-me --open    # 分配给我的未关闭 Issue
```

### Issue 管理

```bash
# 查看详情 (会自动抓取描述并解析所有的附件下载链接)
bsq-jira issue show YLZHXT-1234

# 快速指派经办人
bsq-jira issue assign YLZHXT-1234 zhangsan          # 指派给 zhangsan
bsq-jira issue assign YLZHXT-1234                   # 不填人名则自动指派给自己

# 创建 Issue
bsq-jira issue create PROJ --summary "修复登录Bug" --type Bug --description "详细描述"
bsq-jira issue create PROJ -s "新需求" -t Story -a zhangsan -p High

# 更新 Issue
bsq-jira issue update PROJ-123 --summary "新标题"

# 状态流转
bsq-jira issue transition PROJ-123 --list           # 查看可用状态变更
bsq-jira issue transition PROJ-123 --to "In Progress"  # 变更状态
```

### 项目与评论

```bash
bsq-jira project list                  # 列出所有项目
bsq-jira comment list PROJ-123         # 查看评论
bsq-jira comment add PROJ-123          # 交互式输入评论
```

## 技术特性与约束

1. **Session 会话机制**：弃用了 Jira 的 Basic Auth，完全采用 Cookie/Session 登录，彻底解决**中文用户名**调用报 401/403 权限错误的问题。
2. **多条件 JQL 动态拦截**：Jira 6.0.5 对重复的 `ORDER BY` 解析非常严苛。工具底层实现了正则表达式动态拦截器，当你混用含有排序的 JQL 别名与自带的排序参数时，不再发生 HTTP 400 崩溃。

## 技术栈

- **Python 3.8+**
- **Click** - 工业级 CLI 框架
- **requests** - HTTP 客户端与会话管理
- **rich** - 极致的终端排版与色彩美化
