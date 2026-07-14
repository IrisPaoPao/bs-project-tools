"""Issue 相关命令（CRUD + 状态变更）"""

import click

from jira_cli.client import JiraAPIError
from jira_cli.formatter import (
    print_issues,
    print_issue_detail,
    print_transitions,
    print_success,
    print_error,
    print_warning,
    console,
)


@click.group("issue")
def issue_group():
    """📋 Issue 管理"""
    pass


@issue_group.command("list")
@click.argument("project_key")
@click.option("--max", "-m", "max_results", default=20, show_default=True, help="最大返回数量")
@click.option("--status", "-s", default=None, help="按状态过滤")
@click.option("--type", "-t", "issue_type", default=None, help="按类型过滤")
@click.option("--assignee", "-a", default=None, help="按经办人过滤")
@click.option("--start", "start_at", default=0, help="起始偏移（分页用）")
@click.pass_context
def issue_list(ctx, project_key, max_results, status, issue_type, assignee, start_at):
    """列出项目下的 Issue

    PROJECT_KEY: 项目 Key，如 PROJ
    """
    from jira_cli.main import get_client
    client = get_client(ctx)

    # 构建 JQL
    jql_parts = [f'project = "{project_key.upper()}"']
    if status:
        jql_parts.append(f'status = "{status}"')
    if issue_type:
        jql_parts.append(f'issuetype = "{issue_type}"')
    if assignee:
        jql_parts.append(f'assignee = "{assignee}"')
    jql_parts.append("ORDER BY updated DESC")
    jql = " AND ".join(jql_parts[:-1]) + " " + jql_parts[-1]

    try:
        result = client.search_issues(
            jql=jql,
            max_results=max_results,
            start_at=start_at,
            fields="summary,status,issuetype,priority,assignee,updated",
        )
        print_issues(
            result.get("issues", []),
            total=result.get("total", 0),
            start_at=start_at,
        )
    except JiraAPIError as e:
        print_error(f"获取 Issue 列表失败: {e}")
        raise SystemExit(1)


@issue_group.command("show")
@click.argument("issue_key")
@click.pass_context
def issue_show(ctx, issue_key: str):
    """查看 Issue 详情

    ISSUE_KEY: Issue Key，如 PROJ-123
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    try:
        issue = client.get_issue(issue_key.upper())
        print_issue_detail(issue)
    except JiraAPIError as e:
        print_error(f"获取 Issue {issue_key} 失败: {e}")
        raise SystemExit(1)


@issue_group.command("create")
@click.argument("project_key")
@click.option("--type", "-t", "issue_type", default="Task", show_default=True, help="Issue 类型")
@click.option("--summary", "-s", required=True, help="摘要/标题")
@click.option("--description", "-d", "desc", default="", help="描述")
@click.option("--assignee", "-a", default=None, help="经办人用户名")
@click.option("--priority", "-p", default=None, help="优先级 (Highest/High/Medium/Low/Lowest)")
@click.option("--labels", "-l", default=None, help="标签（逗号分隔）")
@click.pass_context
def issue_create(ctx, project_key, issue_type, summary, desc, assignee, priority, labels):
    """创建 Issue

    PROJECT_KEY: 项目 Key
    """
    from jira_cli.main import get_client
    client = get_client(ctx)

    fields = {
        "project": {"key": project_key.upper()},
        "summary": summary,
        "issuetype": {"name": issue_type},
    }

    if desc:
        fields["description"] = desc
    if assignee:
        fields["assignee"] = {"name": assignee}
    if priority:
        fields["priority"] = {"name": priority}
    if labels:
        fields["labels"] = [l.strip() for l in labels.split(",")]

    try:
        result = client.create_issue(fields)
        print_success(f"Issue 创建成功: {result['key']}")
        console.print(f"   🔗 {client.base_url}/browse/{result['key']}")
    except JiraAPIError as e:
        print_error(f"创建 Issue 失败: {e}")
        raise SystemExit(1)


@issue_group.command("update")
@click.argument("issue_key")
@click.option("--summary", "-s", default=None, help="更新摘要")
@click.option("--description", "-d", "desc", default=None, help="更新描述")
@click.option("--assignee", "-a", default=None, help="更新经办人")
@click.option("--priority", "-p", default=None, help="更新优先级")
@click.option("--labels", "-l", default=None, help="更新标签（逗号分隔）")
@click.pass_context
def issue_update(ctx, issue_key, summary, desc, assignee, priority, labels):
    """更新 Issue

    ISSUE_KEY: Issue Key
    """
    from jira_cli.main import get_client
    client = get_client(ctx)

    fields = {}
    if summary is not None:
        fields["summary"] = summary
    if desc is not None:
        fields["description"] = desc
    if assignee is not None:
        fields["assignee"] = {"name": assignee} if assignee else None
    if priority is not None:
        fields["priority"] = {"name": priority}
    if labels is not None:
        fields["labels"] = [l.strip() for l in labels.split(",")] if labels else []

    if not fields:
        print_warning("没有指定要更新的字段，请至少指定一个 --summary/--description/--assignee/--priority/--labels")
        raise SystemExit(1)

    try:
        client.update_issue(issue_key.upper(), fields)
        print_success(f"Issue {issue_key.upper()} 更新成功")
    except JiraAPIError as e:
        print_error(f"更新 Issue {issue_key} 失败: {e}")
        raise SystemExit(1)


@issue_group.command("delete")
@click.argument("issue_key")
@click.option("--yes", "-y", is_flag=True, help="跳过确认")
@click.pass_context
def issue_delete(ctx, issue_key, yes):
    """删除 Issue

    ISSUE_KEY: Issue Key
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    issue_key = issue_key.upper()

    if not yes:
        # 先显示 Issue 信息
        try:
            issue = client.get_issue(issue_key, fields="summary,status,issuetype")
            summary = issue.get("fields", {}).get("summary", "")
            console.print(f"\n即将删除: [bold]{issue_key}[/bold] - {summary}")
        except JiraAPIError:
            pass

        if not click.confirm(f"确认删除 {issue_key}？此操作不可撤销"):
            console.print("[dim]已取消[/dim]")
            return

    try:
        client.delete_issue(issue_key)
        print_success(f"Issue {issue_key} 已删除")
    except JiraAPIError as e:
        print_error(f"删除 Issue {issue_key} 失败: {e}")
        raise SystemExit(1)


@issue_group.command("transition")
@click.argument("issue_key")
@click.option("--to", "-t", "target", default=None, help="目标状态名称")
@click.option("--id", "transition_id", default=None, help="状态变更 ID（直接指定）")
@click.option("--comment", "-c", default=None, help="变更评论")
@click.option("--list", "-l", "list_only", is_flag=True, help="仅列出可用的状态变更")
@click.pass_context
def issue_transition(ctx, issue_key, target, transition_id, comment, list_only):
    """变更 Issue 状态

    ISSUE_KEY: Issue Key
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    issue_key = issue_key.upper()

    try:
        transitions = client.get_transitions(issue_key)
    except JiraAPIError as e:
        print_error(f"获取状态变更失败: {e}")
        raise SystemExit(1)

    if list_only or (not target and not transition_id):
        print_transitions(transitions, issue_key)
        return

    # 查找目标 transition
    selected = None
    if transition_id:
        selected = next((t for t in transitions if t["id"] == transition_id), None)
    elif target:
        # 按名称或目标状态名匹配（不区分大小写）
        target_lower = target.lower()
        selected = next(
            (t for t in transitions
             if t.get("name", "").lower() == target_lower
             or t.get("to", {}).get("name", "").lower() == target_lower),
            None,
        )

    if not selected:
        print_error(f"未找到匹配的状态变更: {target or transition_id}")
        print_transitions(transitions, issue_key)
        raise SystemExit(1)

    try:
        client.do_transition(issue_key, selected["id"], comment)
        to_name = selected.get("to", {}).get("name", selected.get("name", ""))
        print_success(f"{issue_key} 状态已变更为: {to_name}")
    except JiraAPIError as e:
        print_error(f"状态变更失败: {e}")
        raise SystemExit(1)


@issue_group.command("assign")
@click.argument("issue_key", required=True)
@click.argument("assignee", required=False)
@click.pass_context
def issue_assign(ctx, issue_key: str, assignee: str):
    """分配任务给指定用户 (不传 assignee 或传 me 则分配给自己)"""
    from jira_cli.main import get_client
    from jira_cli.config import load_config
    
    client = get_client(ctx)
    issue_key = issue_key.upper()
    
    if not assignee or assignee.lower() == "me":
        cfg = load_config()
        assignee = cfg.get("username")
        
    try:
        client.assign_issue(issue_key, assignee)
        print_success(f"已将 {issue_key} 成功分配给 {assignee}")
    except Exception as e:
        print_error(f"分配失败: {e}")
        raise SystemExit(1)
