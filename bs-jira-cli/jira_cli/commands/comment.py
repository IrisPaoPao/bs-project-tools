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
