# bs-jira-cli

命令行 Jira 管理工具，基于 Jira REST API v2，适配 Jira v6.0.5（问题管理系统）。

## 安装

```bash
cd bs-jira-cli
pip install -e .
```

安装后即可全局使用 `bsq-jira` 命令。

## 快速开始

```bash
# 1. 初始化配置（交互式输入账号密码）
bsq-jira config init

# 2. 测试连接
bsq-jira config test

# 3. 查看项目列表
bsq-jira project list

# 4. 查看 Issue
bsq-jira issue list PROJ
```

## 命令参考

### 配置管理

```bash
bsq-jira config init                   # 初始化配置（交互式）
bsq-jira config init --url http://... --username user --password pass  # 非交互式
bsq-jira config show                   # 查看当前配置（密码脱敏）
bsq-jira config test                   # 测试连接
```

### 项目

```bash
bsq-jira project list                  # 列出所有项目
bsq-jira project show PROJ             # 查看项目详情
```

### Issue 管理

```bash
# 列出 Issue（支持过滤和分页）
bsq-jira issue list PROJ                           # 列出项目下的 Issue
bsq-jira issue list PROJ --status "Open"           # 按状态过滤
bsq-jira issue list PROJ --type Bug                # 按类型过滤
bsq-jira issue list PROJ --assignee zhangsan       # 按经办人过滤
bsq-jira issue list PROJ --max 50 --start 20       # 分页

# 查看详情
bsq-jira issue show PROJ-123

# 创建 Issue
bsq-jira issue create PROJ --summary "修复登录Bug" --type Bug --description "详细描述"
bsq-jira issue create PROJ -s "新需求" -t Story -a zhangsan -p High

# 更新 Issue
bsq-jira issue update PROJ-123 --summary "新标题"
bsq-jira issue update PROJ-123 --assignee zhangsan --priority High

# 删除 Issue
bsq-jira issue delete PROJ-123          # 需确认
bsq-jira issue delete PROJ-123 --yes    # 跳过确认

# 状态变更
bsq-jira issue transition PROJ-123 --list           # 查看可用状态变更
bsq-jira issue transition PROJ-123 --to "In Progress"  # 变更状态
bsq-jira issue transition PROJ-123 --to "Done" --comment "已完成"
```

### 搜索

```bash
# JQL 搜索
bsq-jira search "project = PROJ AND status = Open"
bsq-jira search "summary ~ '关键词'" --max 50

# 快捷搜索
bsq-jira search --mine                     # 我报告的 Issue
bsq-jira search --assigned-to-me           # 分配给我的
bsq-jira search --assigned-to-me --open    # 分配给我的未关闭 Issue
bsq-jira search -p PROJ --open             # 某项目的未关闭 Issue
```

### 评论

```bash
bsq-jira comment list PROJ-123                  # 查看评论
bsq-jira comment add PROJ-123 --body "评论内容"  # 添加评论
bsq-jira comment add PROJ-123                   # 交互式输入评论
```

## 配置

### 配置文件

配置保存在 `~/.jira-cli/config.json`，密码使用 base64 编码存储，文件权限为 600。

### 环境变量

支持环境变量覆盖（优先级高于配置文件）：

```bash
export JIRA_URL="http://172.18.169.8:6899"
export JIRA_USERNAME="your_username"
export JIRA_PASSWORD="your_password"
```

## 技术栈

- **Python 3.8+**
- **Click** - CLI 框架
- **requests** - HTTP 客户端
- **rich** - 终端美化输出
