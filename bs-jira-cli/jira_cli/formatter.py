"""输出格式化模块

使用 rich 库提供精美的终端输出：表格、面板、颜色标记等。
"""

from datetime import datetime

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich import box

console = Console()
error_console = Console(stderr=True)


# ──────────────────────────────────────────────
# 颜色主题
# ──────────────────────────────────────────────

STATUS_COLORS = {
    # 常见状态 → 颜色映射
    "open": "green",
    "reopened": "green",
    "新建": "green",
    "打开": "green",
    "重新打开": "green",
    "in progress": "blue",
    "进行中": "blue",
    "处理中": "blue",
    "resolved": "yellow",
    "已解决": "yellow",
    "closed": "bright_black",
    "已关闭": "bright_black",
    "done": "bright_black",
    "完成": "bright_black",
}

PRIORITY_COLORS = {
    "highest": "red bold",
    "high": "red",
    "medium": "yellow",
    "low": "green",
    "lowest": "bright_black",
    "最高": "red bold",
    "高": "red",
    "中": "yellow",
    "低": "green",
    "最低": "bright_black",
}

ISSUE_TYPE_ICONS = {
    "bug": "🐛",
    "task": "✅",
    "story": "📖",
    "epic": "⚡",
    "sub-task": "📌",
    "improvement": "💡",
    "new feature": "✨",
    "缺陷": "🐛",
    "任务": "✅",
    "故事": "📖",
    "子任务": "📌",
    "改进": "💡",
    "新功能": "✨",
}


def _get_status_color(status: str) -> str:
    """获取状态对应的颜色"""
    return STATUS_COLORS.get(status.lower(), "white")


def _get_priority_color(priority: str) -> str:
    """获取优先级对应的颜色"""
    return PRIORITY_COLORS.get(priority.lower(), "white")


def _get_type_icon(issue_type: str) -> str:
    """获取 Issue 类型图标"""
    return ISSUE_TYPE_ICONS.get(issue_type.lower(), "📋")


def _format_datetime(dt_str: str) -> str:
    """格式化 Jira 日期时间字符串"""
    if not dt_str:
        return "-"
    try:
        # Jira 格式: 2024-01-15T10:30:00.000+0800
        dt = datetime.fromisoformat(dt_str.replace("+0800", "+08:00").replace("+0000", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M")
    except (ValueError, AttributeError):
        return dt_str[:16] if len(dt_str) > 16 else dt_str


def _safe_get(data: dict, *keys, default="-") -> str:
    """安全地从嵌套 dict 中获取值"""
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key)
        else:
            return default
        if current is None:
            return default
    return str(current)


# ──────────────────────────────────────────────
# 项目格式化
# ──────────────────────────────────────────────

def print_projects(projects: list):
    """打印项目列表"""
    if not projects:
        console.print("[yellow]没有找到任何项目[/yellow]")
        return

    table = Table(
        title="📁 项目列表",
        box=box.ROUNDED,
        show_lines=False,
        header_style="bold cyan",
    )
    table.add_column("Key", style="bold green", min_width=8)
    table.add_column("名称", min_width=15)
    table.add_column("负责人", min_width=10)

    for proj in projects:
        lead = _safe_get(proj, "lead", "displayName")
        table.add_row(proj.get("key", ""), proj.get("name", ""), lead)

    console.print(table)
    console.print(f"\n共 [bold]{len(projects)}[/bold] 个项目")


def print_project_detail(project: dict):
    """打印项目详情"""
    lines = [
        f"[bold cyan]Key:[/bold cyan]         {project.get('key', '-')}",
        f"[bold cyan]名称:[/bold cyan]        {project.get('name', '-')}",
        f"[bold cyan]描述:[/bold cyan]        {project.get('description', '-') or '-'}",
        f"[bold cyan]负责人:[/bold cyan]      {_safe_get(project, 'lead', 'displayName')}",
        f"[bold cyan]URL:[/bold cyan]         {project.get('self', '-')}",
    ]

    # 组件
    components = project.get("components", [])
    if components:
        comp_names = ", ".join(c.get("name", "") for c in components)
        lines.append(f"[bold cyan]组件:[/bold cyan]        {comp_names}")

    # Issue 类型
    issue_types = project.get("issueTypes", [])
    if issue_types:
        type_names = ", ".join(
            f"{_get_type_icon(t.get('name', ''))} {t.get('name', '')}"
            for t in issue_types
        )
        lines.append(f"[bold cyan]Issue 类型:[/bold cyan]  {type_names}")

    content = "\n".join(lines)
    console.print(Panel(content, title=f"📁 {project.get('name', '')}", border_style="cyan"))


# ──────────────────────────────────────────────
# Issue 格式化
# ──────────────────────────────────────────────

def print_issues(issues: list, total: int = None, start_at: int = 0):
    """打印 Issue 列表"""
    if not issues:
        console.print("[yellow]没有找到任何 Issue[/yellow]")
        return

    table = Table(
        title="📋 Issue 列表",
        box=box.ROUNDED,
        show_lines=False,
        header_style="bold cyan",
    )
    table.add_column("Key", style="bold", min_width=10)
    table.add_column("类型", min_width=6)
    table.add_column("状态", min_width=8)
    table.add_column("优先级", min_width=6)
    table.add_column("摘要", min_width=20, max_width=50)
    table.add_column("经办人", min_width=8)
    table.add_column("更新时间", min_width=12)

    for issue in issues:
        fields = issue.get("fields", {})
        key = issue.get("key", "")

        # 类型
        type_name = _safe_get(fields, "issuetype", "name")
        type_icon = _get_type_icon(type_name)
        type_text = f"{type_icon} {type_name}"

        # 状态
        status_name = _safe_get(fields, "status", "name")
        status_color = _get_status_color(status_name)
        status_text = Text(status_name, style=status_color)

        # 优先级
        priority_name = _safe_get(fields, "priority", "name")
        priority_color = _get_priority_color(priority_name)
        priority_text = Text(priority_name, style=priority_color)

        # 其他字段
        summary = fields.get("summary", "")
        if len(summary) > 48:
            summary = summary[:48] + "…"
        assignee = _safe_get(fields, "assignee", "displayName")
        updated = _format_datetime(fields.get("updated", ""))

        table.add_row(key, type_text, status_text, priority_text, summary, assignee, updated)

    console.print(table)

    shown = len(issues)
    total = total or shown
    if total > shown:
        console.print(
            f"\n显示 [bold]{start_at + 1}-{start_at + shown}[/bold] / "
            f"共 [bold]{total}[/bold] 条"
        )
    else:
        console.print(f"\n共 [bold]{total}[/bold] 条")


def print_issue_detail(issue: dict):
    """打印 Issue 详情"""
    fields = issue.get("fields", {})
    key = issue.get("key", "")

    # 类型和图标
    type_name = _safe_get(fields, "issuetype", "name")
    type_icon = _get_type_icon(type_name)

    # 状态
    status_name = _safe_get(fields, "status", "name")
    status_color = _get_status_color(status_name)

    # 优先级
    priority_name = _safe_get(fields, "priority", "name")
    priority_color = _get_priority_color(priority_name)

    lines = [
        f"[bold cyan]Key:[/bold cyan]         {key}",
        f"[bold cyan]类型:[/bold cyan]        {type_icon} {type_name}",
        f"[bold cyan]状态:[/bold cyan]        [{status_color}]{status_name}[/{status_color}]",
        f"[bold cyan]优先级:[/bold cyan]      [{priority_color}]{priority_name}[/{priority_color}]",
        f"[bold cyan]摘要:[/bold cyan]        {fields.get('summary', '-')}",
        f"[bold cyan]项目:[/bold cyan]        {_safe_get(fields, 'project', 'name')} ({_safe_get(fields, 'project', 'key')})",
        "",
        f"[bold cyan]经办人:[/bold cyan]      {_safe_get(fields, 'assignee', 'displayName')}",
        f"[bold cyan]报告人:[/bold cyan]      {_safe_get(fields, 'reporter', 'displayName')}",
        f"[bold cyan]创建时间:[/bold cyan]    {_format_datetime(fields.get('created', ''))}",
        f"[bold cyan]更新时间:[/bold cyan]    {_format_datetime(fields.get('updated', ''))}",
        f"[bold cyan]解决时间:[/bold cyan]    {_format_datetime(fields.get('resolutiondate', ''))}",
    ]

    # 解决结果
    resolution = _safe_get(fields, "resolution", "name")
    if resolution != "-":
        lines.append(f"[bold cyan]解决结果:[/bold cyan]    {resolution}")

    # 标签
    labels = fields.get("labels", [])
    if labels:
        lines.append(f"[bold cyan]标签:[/bold cyan]        {', '.join(labels)}")

    # 组件
    components = fields.get("components", [])
    if components:
        comp_names = ", ".join(c.get("name", "") for c in components)
        lines.append(f"[bold cyan]组件:[/bold cyan]        {comp_names}")

    # Fix Version
    fix_versions = fields.get("fixVersions", [])
    if fix_versions:
        ver_names = ", ".join(v.get("name", "") for v in fix_versions)
        lines.append(f"[bold cyan]修复版本:[/bold cyan]    {ver_names}")

    # 附件
    attachments = fields.get("attachment", [])
    if attachments:
        lines.append("")
        lines.append("[bold cyan]附件:[/bold cyan]")
        for att in attachments:
            filename = att.get("filename", "")
            size = att.get("size", 0)
            url = att.get("content", "")
            
            if size > 1024 * 1024:
                size_str = f"{size / (1024 * 1024):.1f} MB"
            elif size > 1024:
                size_str = f"{size / 1024:.1f} KB"
            else:
                size_str = f"{size} B"
                
            lines.append(f"  📎 {filename} ({size_str}) -> {url}")

    # 描述
    description = fields.get("description", "")
    if description:
        lines.append("")
        lines.append("[bold cyan]描述:[/bold cyan]")
        lines.append(description)

    content = "\n".join(lines)
    console.print(Panel(
        content,
        title=f"{type_icon} {key} - {fields.get('summary', '')}",
        border_style="cyan",
        padding=(1, 2),
    ))


# ──────────────────────────────────────────────
# 评论格式化
# ──────────────────────────────────────────────

def print_comments(comments: list, issue_key: str):
    """打印评论列表"""
    if not comments:
        console.print(f"[yellow]{issue_key} 没有评论[/yellow]")
        return

    console.print(f"\n[bold]💬 {issue_key} 的评论 ({len(comments)} 条)[/bold]\n")

    for i, comment in enumerate(comments, 1):
        author = _safe_get(comment, "author", "displayName")
        created = _format_datetime(comment.get("created", ""))
        updated = _format_datetime(comment.get("updated", ""))
        body = comment.get("body", "")

        header = f"[bold]{author}[/bold]  [dim]{created}[/dim]"
        if created != updated:
            header += f"  [dim](编辑于 {updated})[/dim]"

        console.print(Panel(
            body,
            title=header,
            title_align="left",
            border_style="blue",
            padding=(0, 1),
        ))
        if i < len(comments):
            console.print()


# ──────────────────────────────────────────────
# 状态变更格式化
# ──────────────────────────────────────────────

def print_transitions(transitions: list, issue_key: str):
    """打印可用的状态变更列表"""
    if not transitions:
        console.print(f"[yellow]{issue_key} 没有可用的状态变更[/yellow]")
        return

    table = Table(
        title=f"🔄 {issue_key} 可用的状态变更",
        box=box.ROUNDED,
        header_style="bold cyan",
    )
    table.add_column("ID", style="dim", min_width=5)
    table.add_column("操作名称", style="bold", min_width=15)
    table.add_column("目标状态", min_width=15)

    for t in transitions:
        to_status = _safe_get(t, "to", "name")
        to_color = _get_status_color(to_status)
        table.add_row(
            t.get("id", ""),
            t.get("name", ""),
            Text(to_status, style=to_color),
        )

    console.print(table)


# ──────────────────────────────────────────────
# 通用输出
# ──────────────────────────────────────────────

def print_success(message: str):
    """打印成功信息"""
    console.print(f"[bold green]✅ {message}[/bold green]")


def print_error(message: str):
    """打印错误信息"""
    error_console.print(f"[bold red]❌ {message}[/bold red]")


def print_warning(message: str):
    """打印警告信息"""
    console.print(f"[bold yellow]⚠️  {message}[/bold yellow]")


def print_info(message: str):
    """打印信息"""
    console.print(f"[bold blue]ℹ️  {message}[/bold blue]")


def print_config(config_display: dict):
    """打印配置信息"""
    if not config_display:
        print_warning("未配置，请运行 'bsq-jira config init'")
        return

    table = Table(box=box.SIMPLE, show_header=False, padding=(0, 2))
    table.add_column("项目", style="bold cyan")
    table.add_column("值")

    table.add_row("服务器地址", config_display["url"])
    table.add_row("用户名", config_display["username"])
    table.add_row("密码", config_display["password"])
    table.add_row("配置来源", config_display["source"])

    console.print(Panel(table, title="⚙️  Jira CLI 配置", border_style="cyan"))


def print_server_info(info: dict):
    """打印服务器连接测试结果"""
    lines = [
        f"[bold cyan]服务器:[/bold cyan]      {info.get('baseUrl', '-')}",
        f"[bold cyan]版本:[/bold cyan]        {info.get('version', '-')}",
        f"[bold cyan]Build:[/bold cyan]       {info.get('buildNumber', '-')}",
        f"[bold cyan]标题:[/bold cyan]        {info.get('serverTitle', '-')}",
    ]

    user_info = info.get("currentUser")
    if user_info:
        display_name = user_info.get("displayName") or user_info.get("name", "-")
        lines.append(f"[bold cyan]当前用户:[/bold cyan]    {display_name}")

    content = "\n".join(lines)
    console.print(Panel(content, title="🔗 连接成功", border_style="green"))
