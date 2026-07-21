import click
from rich.console import Console

console = Console()


@click.group(name="attachment")
def attachment_group():
    """📎 附件管理"""
    pass


@attachment_group.command()
@click.argument("url")
@click.option("--dest-dir", "-d", default=".", help="下载保存的目录路径")
@click.pass_context
def download(ctx, url: str, dest_dir: str):
    """下载附件

    URL: 附件的真实下载地址 (可以在 issue show 中获取)
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    with console.status(f"正在下载附件到 [bold cyan]{dest_dir}[/bold cyan] ..."):
        try:
            dest_path = client.download_attachment(url, dest_dir)
            console.print(f"✅ 下载成功: [bold green]{dest_path}[/bold green]")
        except Exception as e:
            console.print(f"[red]❌ 下载失败: {e}[/red]")
            raise click.Abort()
