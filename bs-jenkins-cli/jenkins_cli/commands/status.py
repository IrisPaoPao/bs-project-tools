import click
import datetime
from rich.table import Table
from ..main import pass_context

@click.command()
@click.argument('job_name')
@pass_context
def status_cmd(ctx, job_name):
    """查看任务最新构建状态"""
    console = ctx.console
    api = ctx.api
    
    with console.status(f"[cyan]获取 {job_name} 状态...[/cyan]"):
        try:
            job_info = api.get_job_info(job_name)
        except Exception as e:
            console.print(f"[bold red]❌ 获取任务失败: {e}[/bold red]")
            return
            
        if not job_info:
            console.print(f"[bold red]❌ 任务 '{job_name}' 不存在！[/bold red]")
            return
            
        last_build = job_info.get('lastBuild')
        if not last_build:
            console.print(f"[yellow]任务 '{job_name}' 还没有任何构建记录。[/yellow]")
            return
            
        build_number = last_build['number']
        try:
            build_info = api.get_build_info(job_name, build_number)
        except Exception as e:
            console.print(f"[bold red]❌ 获取构建详情失败: {e}[/bold red]")
            return

    table = Table(title=f"构建状态: {job_name} #{build_number}", show_header=False)
    table.add_column("Key", style="bold cyan")
    table.add_column("Value")
    
    # 构建状态
    if build_info.get('building'):
        status = "[yellow blink]运行中[/yellow blink]"
    else:
        result = build_info.get('result', 'UNKNOWN')
        if result == 'SUCCESS':
            status = "[bold green]成功 (SUCCESS)[/bold green]"
        elif result == 'FAILURE':
            status = "[bold red]失败 (FAILURE)[/bold red]"
        elif result == 'ABORTED':
            status = "[bold grey50]已中止 (ABORTED)[/bold grey50]"
        else:
            status = f"[yellow]{result}[/yellow]"
            
    table.add_row("状态", status)
    table.add_row("URL", f"[blue]{build_info.get('url')}[/blue]")
    
    # 时间转换
    timestamp = build_info.get('timestamp')
    if timestamp:
        # Jenkins timestamp is in milliseconds
        dt = datetime.datetime.fromtimestamp(timestamp / 1000.0)
        table.add_row("触发时间", dt.strftime('%Y-%m-%d %H:%M:%S'))
        
    duration = build_info.get('duration')
    if duration and not build_info.get('building'):
        seconds = duration / 1000.0
        m, s = divmod(seconds, 60)
        table.add_row("耗时", f"{int(m)}分 {int(s)}秒")
        
    # 构建原因 (通常在 actions 中)
    causes = []
    for action in build_info.get('actions', []):
        if action.get('_class') == 'hudson.model.CauseAction':
            for cause in action.get('causes', []):
                causes.append(cause.get('shortDescription', ''))
    if causes:
        table.add_row("构建原因", ", ".join(causes))

    console.print(table)
