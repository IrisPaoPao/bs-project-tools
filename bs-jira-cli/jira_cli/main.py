"""Jira CLI 主入口

使用 Click 构建命令行界面，统一管理配置和客户端初始化。
"""

import click

from jira_cli import __version__
from jira_cli.client import JiraClient, JiraAPIError
from jira_cli.config import (
    save_config,
    load_config,
    config_exists,
    get_config_display,
)
from jira_cli.formatter import (
    print_config,
    print_server_info,
    print_success,
    print_error,
    console,
)
from jira_cli.commands.project import project_group
from jira_cli.commands.issue import issue_group
from jira_cli.commands.search import search_command
from jira_cli.commands.comment import comment_group
from jira_cli.commands.alias import alias_group


# ──────────────────────────────────────────────
# 需要配置的命令（自动初始化 JiraClient）
# ──────────────────────────────────────────────

COMMANDS_NO_AUTH = {"config"}


def _create_client() -> JiraClient:
    """从配置创建 JiraClient 实例"""
    cfg = load_config()
    return JiraClient(cfg["url"], cfg["username"], cfg["password"])


def get_client(ctx) -> JiraClient:
    """懒加载 JiraClient，供子命令调用

    延迟初始化，避免 --help 时触发认证检查。
    """
    if "client" not in ctx.obj:
        try:
            ctx.obj["client"] = _create_client()
        except FileNotFoundError as e:
            print_error(str(e))
            raise SystemExit(1)
    return ctx.obj["client"]


# ──────────────────────────────────────────────
# 根命令组
# ──────────────────────────────────────────────

@click.group(invoke_without_command=True)
@click.version_option(__version__, prog_name="bsq-jira")
@click.pass_context
def cli(ctx):
    """🔧 Jira CLI - 命令行 Jira 管理工具

    \b
    快速开始：
      bsq-jira config init          # 首次配置
      bsq-jira config test          # 测试连接
      bsq-jira project list         # 查看项目列表
      bsq-jira issue list PROJ      # 查看项目 Issue
      bsq-jira search --mine        # 搜索我的 Issue
    """
    ctx.ensure_object(dict)

    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())
        return

    # 标记是否需要认证（延迟到子命令实际执行时才创建客户端）
    if ctx.invoked_subcommand not in COMMANDS_NO_AUTH:
        ctx.obj["_needs_auth"] = True


# ──────────────────────────────────────────────
# config 命令组
# ──────────────────────────────────────────────

@cli.group("config")
def config_group():
    """⚙️  配置管理"""
    pass


@config_group.command("init")
@click.option("--url", default=None, help="Jira 服务器地址")
@click.option("--username", "-u", default=None, help="用户名")
@click.option("--password", "-p", default=None, help="密码")
def config_init(url, username, password):
    """初始化配置（交互式）"""
    if not url:
        url = click.prompt("Jira 服务器地址", default="http://172.18.169.8:6899")
    if not username:
        username = click.prompt("用户名")
    if not password:
        password = click.prompt("密码", hide_input=True)

    config_path = save_config(url, username, password)
    print_success(f"配置已保存到 {config_path}")

    # 自动测试连接
    console.print("\n[dim]正在测试连接...[/dim]")
    try:
        client = JiraClient(url, username, password)
        info = client.test_connection()
        print_server_info(info)
    except JiraAPIError as e:
        print_error(f"连接测试失败: {e}")
        console.print("[yellow]配置已保存，但连接失败。请检查地址和凭据。[/yellow]")


@config_group.command("show")
def config_show():
    """显示当前配置"""
    display = get_config_display()
    print_config(display)


@config_group.command("test")
def config_test():
    """测试连接"""
    try:
        cfg = load_config()
    except FileNotFoundError as e:
        print_error(str(e))
        raise SystemExit(1)

    console.print("[dim]正在连接...[/dim]")
    try:
        client = JiraClient(cfg["url"], cfg["username"], cfg["password"])
        info = client.test_connection()
        print_server_info(info)
    except JiraAPIError as e:
        print_error(f"连接失败: {e}")
        raise SystemExit(1)


# ──────────────────────────────────────────────
# 注册子命令
# ──────────────────────────────────────────────

cli.add_command(config_group)
cli.add_command(project_group)
cli.add_command(issue_group)
cli.add_command(search_command)
cli.add_command(comment_group)
cli.add_command(alias_group)


# ──────────────────────────────────────────────
# 入口
# ──────────────────────────────────────────────

if __name__ == "__main__":
    cli()
