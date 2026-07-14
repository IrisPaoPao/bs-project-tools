import click
from rich.table import Table
from ..main import pass_context

@click.command()
@pass_context
def jobs_cmd(ctx):
    """列出所有 Jenkins 任务"""
    console = ctx.console
    api = ctx.api
    
    with console.status(f"[bold cyan]正在获取 {ctx.server_config['name']} 上的任务列表...[/bold cyan]"):
        try:
            jobs = api.get_jobs()
        except Exception as e:
            console.print(f"[bold red]❌ 获取任务列表失败: {e}[/bold red]")
            return

    if not jobs:
        console.print("[yellow]该服务器上没有任何任务。[/yellow]")
        return
        
    table = Table(title=f"Jenkins 任务列表 ({ctx.server_config['name']})", show_header=True, header_style="bold magenta")
    table.add_column("任务名称", style="cyan")
    table.add_column("状态", style="bold")
    table.add_column("URL", style="blue")
    
    for job in jobs:
        color = job.get('color', 'notbuilt')
        status = _get_status_text(color)
        table.add_row(job['name'], status, job['url'])
        
    console.print(table)

def _get_status_text(color):
    """将 Jenkins 颜色转换为状态文本"""
    mapping = {
        'blue': '[green]成功[/green]',
        'blue_anime': '[green blink]运行中 (成功)[/green blink]',
        'red': '[red]失败[/red]',
        'red_anime': '[red blink]运行中 (失败)[/red blink]',
        'yellow': '[yellow]不稳定[/yellow]',
        'yellow_anime': '[yellow blink]运行中 (不稳定)[/yellow blink]',
        'aborted': '[grey50]已中止[/grey50]',
        'aborted_anime': '[grey50 blink]运行中 (已中止)[/grey50 blink]',
        'notbuilt': '[grey50]未构建[/grey50]',
        'disabled': '[grey50]已禁用[/grey50]'
    }
    return mapping.get(color, f"[white]{color}[/white]")
