import click
from rich.table import Table
from rich import box
from jira_cli.formatter import console, print_success, print_error, print_warning
from jira_cli.config import get_aliases, save_aliases


@click.group(name="alias")
def alias_group():
    """🔗 JQL 搜索别名管理"""
    pass


@alias_group.command("add")
@click.argument("name")
@click.argument("jql")
def add_alias(name: str, jql: str):
    """添加或更新别名"""
    try:
        aliases = get_aliases()
        name_clean = name.lstrip("@")
        aliases[name_clean] = jql
        save_aliases(aliases)
        print_success(f"已保存别名: @{name_clean} -> {jql}")
    except Exception as e:
        print_error(f"保存别名失败: {e}")


@alias_group.command("remove")
@click.argument("name")
def remove_alias(name: str):
    """删除别名"""
    try:
        aliases = get_aliases()
        name_clean = name.lstrip("@")
        if name_clean in aliases:
            del aliases[name_clean]
            save_aliases(aliases)
            print_success(f"已删除别名: @{name_clean}")
        else:
            print_warning(f"别名不存在: @{name_clean}")
    except Exception as e:
        print_error(f"删除别名失败: {e}")


@alias_group.command("list")
def list_aliases():
    """列出所有别名"""
    aliases = get_aliases()
    if not aliases:
        print_warning("暂无别名。可以使用 'bsq-jira alias add NAME JQL' 添加")
        return

    table = Table(title="🔗 JQL 搜索别名", box=box.SIMPLE)
    table.add_column("别名", style="cyan", justify="right")
    table.add_column("JQL", style="green")

    for k, v in aliases.items():
        table.add_row(f"@{k}", v)

    console.print(table)
