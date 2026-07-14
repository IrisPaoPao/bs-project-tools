import click
from rich.console import Console
from .config import load_config, get_server_config
from .api import JenkinsAPI

console = Console()

class Context:
    def __init__(self):
        self.config = None
        self.server_config = None
        self.api = None
        self.console = console

pass_context = click.make_pass_decorator(Context, ensure=True)

@click.group()
@click.option('--server', '-s', help='指定 Jenkins 服务器 (如 saas-jenkins, tax-jenkins)')
@pass_context
def cli(ctx, server):
    """bsq-jenkins: 命令行 Jenkins 管理工具"""
    ctx.config = load_config()
    ctx.server_config = get_server_config(ctx.config, server)
    
    try:
        ctx.api = JenkinsAPI(ctx.server_config)
    except Exception as e:
        ctx.console.print(f"[bold red]❌ 初始化 Jenkins API 失败: {e}[/bold red]")
        exit(1)

# Import commands here to register them with the CLI group
from .commands import jobs, build, status

cli.add_command(jobs.jobs_cmd, name='jobs')
cli.add_command(build.build_cmd, name='build')
cli.add_command(status.status_cmd, name='status')

if __name__ == '__main__':
    cli()
