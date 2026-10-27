import click
from rich.console import Console

from jira_cli.client import JiraAPIError

console = Console()


@click.group(name="attachment")
def attachment_group():
    """📎 附件管理"""
    pass


@attachment_group.command()
@click.argument("issue_key")
@click.argument("files", nargs=-1, required=True,
                type=click.Path(exists=True, file_okay=True, dir_okay=False, readable=True))
@click.pass_context
def upload(ctx, issue_key: str, files: tuple[str, ...]):
    """上传一个或多个附件到指定任务

    ISSUE_KEY: 目标任务号，如 YLZHXT-1234
    FILES: 本地文件路径，多个文件用空格分隔
    """
    from jira_cli.main import get_client
    client = get_client(ctx)
    issue_key = issue_key.strip().upper()
    try:
        with console.status(f"正在上传 {len(files)} 个附件 ..."):
            attachments = client.upload_attachments(issue_key, list(files))
        console.print(f"✅ 已上传 {len(attachments)} 个附件到 {issue_key}", markup=False)
        for attachment in attachments:
            console.print(
                f"  {attachment['filename']} (ID: {attachment['id']})", markup=False,
            )
            if attachment.get("content"):
                console.print(f"    {attachment['content']}", markup=False)
    except (JiraAPIError, OSError, ValueError) as e:
        console.print(f"❌ 上传失败: {e}", style="red", markup=False)
        # 超时或断连时服务器可能已经保存附件，提示先核对以免重复上传。
        console.print("请先用 issue show 核对任务附件，再决定是否重试。", markup=False)
        raise click.Abort()


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
