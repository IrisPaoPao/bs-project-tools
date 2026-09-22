import time
import click
from ..main import pass_context


@click.command()
@click.argument('job_name')
@click.option('--wait/--no-wait', default=False, help='是否等待扫描完成 (默认不等待)')
@click.option('--timeout', type=click.IntRange(min=1), default=300, show_default=True,
              help='等待扫描完成的最大超时时间（秒）')
@pass_context
def scan_cmd(ctx, job_name, wait, timeout):
    """触发多分支流水线（Multibranch Pipeline）分支扫描"""
    console = ctx.console
    api = ctx.api

    with console.status(f"[cyan]检查任务 {job_name}...[/cyan]"):
        try:
            job_info = api.get_job_info(job_name)
        except Exception as e:
            raise click.ClickException(f'检查任务 {job_name} 失败: {e}') from e
        if not job_info:
            raise click.ClickException(f"任务 '{job_name}' 不存在")

        job_class = job_info.get('_class', '')
        is_multibranch = (
            job_class == 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject'
            or 'multibranch' in job_class.lower()
        )
        if not is_multibranch:
            raise click.ClickException(
                f"任务 '{job_name}' 不是多分支流水线，无需扫描；构建具体任务请使用 'build' 命令"
            )

    with console.status(f"[cyan]正在触发 {job_name} 多分支扫描...[/cyan]"):
        try:
            location_url = api.scan_job(job_name)
        except Exception as e:
            raise click.ClickException(f'触发 {job_name} 扫描失败: {e}') from e

    console.print(f"[green]✅ 已提交多分支流水线 '{job_name}' 扫描请求[/green]")
    if location_url:
        console.print(f"队列/索引地址: [blue]{location_url}[/blue]")

    if not wait:
        console.print("[dim]提示: 扫描请求已提交，Jenkins 将在后台索引分支；可稍后使用 jobs 或查询目标分支确认结果。[/dim]")
        return

    # 等待模式
    deadline = time.monotonic() + timeout
    last_error = None

    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            detail = f'；最后一次查询错误: {last_error}' if last_error else ''
            raise click.ClickException(f'等待扫描超时 ({timeout} 秒)，任务 {job_name}{detail}')
        return seconds

    # 如果有队列 URL 并且属于 queue item，先等待出队
    if location_url and '/queue/item/' in location_url:
        with console.status('[cyan]等待扫描任务出队...[/cyan]'):
            while True:
                budget = remaining()
                try:
                    queue_info = api.get_queue_item(location_url, timeout=min(10, budget))
                    last_error = None
                except Exception as e:
                    queue_info = None
                    last_error = str(e)

                if queue_info and queue_info.get('cancelled'):
                    raise click.ClickException(f"任务 {job_name} 扫描在队列中被取消: {location_url}")

                # 如果 queue_info 为 None（如 404，说明已经离开队列进入执行）或者已经出队
                if queue_info is None or queue_info.get('executable'):
                    break
                time.sleep(min(2, remaining()))

    # 尝试检测 indexing 状态（如果服务端支持 /indexing/api/json）
    with console.status('[cyan]等待索引完成...[/cyan]'):
        while True:
            budget = remaining()
            try:
                indexing_info = api.get_indexing_info(job_name, timeout=min(10, budget))
                last_error = None
            except Exception as e:
                indexing_info = None
                last_error = str(e)

            if indexing_info is not None:
                if not indexing_info.get('building', False) and not indexing_info.get('isBuilding', False):
                    result = indexing_info.get('result') or 'SUCCESS'
                    if result != 'SUCCESS':
                        raise click.ClickException(f"任务 {job_name} 扫描未成功，状态: {result}")
                    break
            else:
                # 若服务端不支持 /indexing/api/json，且已离开队列，退出等待
                break
            time.sleep(min(3, remaining()))

    console.print(f"[bold green]🎉 多分支流水线 '{job_name}' 扫描完成！[/bold green]")
