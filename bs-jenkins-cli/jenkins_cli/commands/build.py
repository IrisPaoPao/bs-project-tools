import time
import click
from ..main import pass_context

@click.command()
@click.argument('job_name')
@click.option('--wait/--no-wait', default=True, help='是否等待构建结束并返回结果 (默认等待)')
@click.option('-p', '--param', multiple=True, help='构建参数，例如 -p branch=main -p env=prod')
@pass_context
def build_cmd(ctx, job_name, wait, param):
    """触发任务构建"""
    console = ctx.console
    api = ctx.api
    
    # 检查任务是否存在
    with console.status(f"[cyan]检查任务 {job_name}...[/cyan]"):
        try:
            job_info = api.get_job_info(job_name)
        except Exception as e:
            console.print(f"[bold red]❌ 检查任务失败: {e}[/bold red]")
            return
            
        if not job_info:
            console.print(f"[bold red]❌ 任务 '{job_name}' 不存在！[/bold red]")
            return

    # 解析参数
    build_params = {}
    if param:
        for p in param:
            if '=' in p:
                k, v = p.split('=', 1)
                build_params[k] = v
            else:
                console.print(f"[yellow]⚠️ 忽略无效的参数格式 (缺少 '='): {p}[/yellow]")

    # 触发构建
    with console.status(f"[cyan]正在触发 {job_name} 构建...[/cyan]") as status:
        try:
            queue_url = api.build_job(job_name, parameters=build_params if build_params else None)
        except Exception as e:
            console.print(f"[bold red]❌ 触发构建失败: {e}[/bold red]")
            return
            
    console.print(f"[green]✅ 成功触发任务 '{job_name}'[/green]")
    if not wait:
        return
        
    if queue_url:
        console.print(f"队列信息: [blue]{queue_url}[/blue]")
    else:
        console.print("[yellow]⚠️ 无法获取构建队列 URL，无法跟踪构建进度（若是扫描多分支流水线则属正常现象）。[/yellow]")
        return
        
    # 等待队列分配构建号
    build_url = None
    with console.status("[cyan]等待 Jenkins 分配构建号...[/cyan]") as status:
        while True:
            try:
                queue_info = api.get_queue_item(queue_url)
                if queue_info and 'executable' in queue_info and queue_info['executable']:
                    build_url = queue_info['executable'].get('url')
                    build_number = queue_info['executable'].get('number')
                    break
                elif queue_info and queue_info.get('cancelled'):
                    console.print("[bold red]❌ 构建在队列中被取消！[/bold red]")
                    return
            except Exception as e:
                console.print(f"[yellow]⚠️ 检查队列状态出错: {e}[/yellow]")
            time.sleep(2)
            
    console.print(f"[green]✅ 已分配构建号: #{build_number}[/green]")
    console.print(f"构建地址: [blue]{build_url}[/blue]")
    
    # 等待构建结束
    with console.status(f"[cyan]构建 #{build_number} 进行中...[/cyan]") as status:
        while True:
            try:
                build_info = api.get_build_info(job_name, build_number)
                if not build_info:
                    time.sleep(2)
                    continue
                    
                if not build_info.get('building'):
                    # 构建结束
                    result = build_info.get('result', 'UNKNOWN')
                    break
                    
                # 还可以获取预估时间并在 status 中显示 (可选)
            except Exception as e:
                pass
            time.sleep(3)
            
    if result == 'SUCCESS':
        console.print(f"[bold green]🎉 构建 #{build_number} 成功！[/bold green]")
    elif result == 'FAILURE':
        console.print(f"[bold red]💥 构建 #{build_number} 失败！[/bold red]")
    elif result == 'ABORTED':
        console.print(f"[bold grey50]🛑 构建 #{build_number} 被中止！[/bold grey50]")
    else:
        console.print(f"[bold yellow]⚠️ 构建 #{build_number} 结束，状态: {result}[/bold yellow]")
