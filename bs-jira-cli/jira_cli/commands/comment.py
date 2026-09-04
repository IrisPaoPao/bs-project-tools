"""评论相关命令"""

import click

from jira_cli.client import JiraAPIError
from jira_cli.formatter import (
    print_comments,
    print_success,
    print_error,
    console,
)


@click.group("comment")
def comment_group():
    """💬 评论管理"""
    pass


@comment_group.command("list")
@click.argument("issue_key")
@click.pass_context
def comment_list(ctx, issue_key: str):
    """查看 Issue 的评论

    ISSUE_KEY: Issue Key，如 PROJ-123
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    try:
        comments = client.get_comments(issue_key.upper())
        print_comments(comments, issue_key.upper())
    except JiraAPIError as e:
        print_error(f"获取评论失败: {e}")
        raise SystemExit(1)


@comment_group.command("add")
@click.argument("issue_key")
@click.option("--body", "-b", default=None, help="评论内容")
@click.pass_context
def comment_add(ctx, issue_key: str, body: str):
    """添加评论

    ISSUE_KEY: Issue Key，如 PROJ-123
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    issue_key = issue_key.upper()

    if not body:
        # 交互式输入
        console.print("[dim]请输入评论内容（输入空行结束）：[/dim]")
        lines = []
        try:
            while True:
                line = input()
                if line == "":
                    if lines:
                        break
                    continue
                lines.append(line)
        except (EOFError, KeyboardInterrupt):
            pass

        body = "\n".join(lines)

    if not body.strip():
        print_error("评论内容不能为空")
        raise SystemExit(1)

    try:
        client.add_comment(issue_key, body)
        print_success(f"评论已添加到 {issue_key}")
    except JiraAPIError as e:
        print_error(f"添加评论失败: {e}")
        raise SystemExit(1)


@comment_group.command("delete")
@click.argument("issue_key")
@click.argument("comment_id")
@click.option("--yes", "-y", is_flag=True, help="跳过确认")
@click.pass_context
def comment_delete(ctx, issue_key: str, comment_id: str, yes: bool):
    """删除评论

    ISSUE_KEY: Issue Key，如 PROJ-123
    COMMENT_ID: 评论 ID，如 10523（支持带或不带 #）
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    issue_key = issue_key.upper()
    comment_id = comment_id.lstrip("#").strip()

    if not yes:
        # 尝试获取评论详情展示预览
        try:
            comment = client.get_comment(issue_key, comment_id)
            body = comment.get("body", "")
            preview = body[:100] + ("..." if len(body) > 100 else "")
            author = comment.get("author", {}).get("displayName", "")
            console.print(f"\n即将删除评论 [cyan]#{comment_id}[/cyan]" + (f" (作者: {author})" if author else "") + f":\n  [dim]{preview}[/dim]\n")
        except JiraAPIError:
            pass

        if not click.confirm(f"确认删除 {issue_key} 的评论 #{comment_id}？此操作不可撤销"):
            console.print("[dim]已取消[/dim]")
            return

    try:
        client.delete_comment(issue_key, comment_id)
        print_success(f"评论 #{comment_id} 已删除")
    except JiraAPIError as e:
        print_error(f"删除评论失败: {e}")
        raise SystemExit(1)


comment_group.add_command(comment_delete, "remove")
comment_group.add_command(comment_delete, "rm")

