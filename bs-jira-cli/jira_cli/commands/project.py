"""项目相关命令"""

import click

from jira_cli.client import JiraAPIError
from jira_cli.formatter import (
    print_projects,
    print_project_detail,
    print_error,
)


@click.group("project")
def project_group():
    """📁 项目管理"""
    pass


@project_group.command("list")
@click.pass_context
def project_list(ctx):
    """列出所有项目"""
    from jira_cli.main import get_client
    client = get_client(ctx)
    try:
        projects = client.get_projects()
        print_projects(projects)
    except JiraAPIError as e:
        print_error(f"获取项目列表失败: {e}")
        raise SystemExit(1)


@project_group.command("show")
@click.argument("project_key")
@click.pass_context
def project_show(ctx, project_key: str):
    """查看项目详情

    PROJECT_KEY: 项目 Key，如 PROJ
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    try:
        project = client.get_project(project_key.upper())
        print_project_detail(project)
    except JiraAPIError as e:
        print_error(f"获取项目 {project_key} 失败: {e}")
        raise SystemExit(1)
