import time
import click
from ..main import pass_context


@click.command()
@click.argument('job_name')
@click.option('--wait/--no-wait', default=True, help='是否等待构建结束并返回结果 (默认等待)')
@click.option('--timeout', type=click.IntRange(min=1), default=1800, show_default=True,
              help='队列和构建的总等待上限（秒，不取消 Jenkins 任务）')
@click.option('-p', '--param', multiple=True, help='构建参数，例如 -p branch=main -p env=prod')
@pass_context
def build_cmd(ctx, job_name, wait, timeout, param):
    """触发任务构建；等待模式只有确认 SUCCESS 才返回成功。"""
    console = ctx.console
    api = ctx.api

    # 参数不完整时不能退化成默认构建，避免触发错误环境或分支。
    build_params = {}
    for p in param:
        if '=' not in p or not p.split('=', 1)[0].strip():
            raise click.BadParameter('必须使用非空名称的 key=value 格式', param_hint='--param')
        k, v = p.split('=', 1)
        build_params[k] = v

    with console.status(f"[cyan]检查任务 {job_name}...[/cyan]"):
        try:
            job_info = api.get_job_info(job_name)
        except Exception as e:
            raise click.ClickException(f'检查任务 {job_name} 失败: {e}') from e
        if not job_info:
            raise click.ClickException(f"任务 '{job_name}' 不存在")
        if job_info.get('_class') == 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject':
            raise click.ClickException(
                f"任务 '{job_name}' 是多分支流水线父任务，请使用 '{job_name}/job/<分支名>' 构建具体分支"
            )

    with console.status(f"[cyan]正在触发 {job_name} 构建...[/cyan]"):
        try:
            queue_url = api.build_job(job_name, parameters=build_params or None)
        except Exception as e:
            raise click.ClickException(f'触发 {job_name} 未能确认成功，请先查询 Jenkins，勿直接重试: {e}') from e

    console.print(f"[green]✅ 已提交任务 '{job_name}'[/green]")
    if queue_url:
        console.print(f"队列信息: [blue]{queue_url}[/blue]")
    if not wait:
        return
    if not queue_url:
        raise click.ClickException('未返回队列 URL，无法确认最终结果；扫描流水线可使用 --no-wait，勿重复提交构建')

    # 队列和构建共用同一个截止时间，短暂查询失败可重试，绝不重新提交任务。
    deadline = time.monotonic() + timeout
    last_error = None
    build_number = None
    build_url = None

    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            detail = f'；最后一次查询错误: {last_error}' if last_error else ''
            location = build_url or queue_url
            raise click.ClickException(
                f'等待超时 ({timeout} 秒)，任务 {job_name}，构建号 {build_number or "未分配"}，'
                f'位置 {location}；Jenkins 任务未取消，请查询后续状态{detail}')
        return seconds

    with console.status('[cyan]等待 Jenkins 分配构建号...[/cyan]'):
        while build_number is None:
            budget = remaining()
            try:
                queue_info = api.get_queue_item(queue_url, timeout=min(10, budget))
                last_error = None
            except Exception as e:
                queue_info = None
                last_error = str(e)
            remaining()
            if queue_info and queue_info.get('cancelled'):
                raise click.ClickException(f'任务 {job_name} 在队列中被取消: {queue_url}')
            executable = queue_info.get('executable') if queue_info else None
            if executable and executable.get('number') is not None:
                build_number = executable['number']
                build_url = executable.get('url')
                break
            time.sleep(min(2, remaining()))

    console.print(f"[green]✅ 已分配构建号: #{build_number}[/green]")
    if build_url:
        console.print(f"构建地址: [blue]{build_url}[/blue]")
    with console.status(f'[cyan]构建 #{build_number} 进行中...[/cyan]'):
        while True:
            budget = remaining()
            try:
                build_info = api.get_build_info(job_name, build_number, timeout=min(10, budget))
                last_error = None
            except Exception as e:
                build_info = None
                last_error = str(e)
            remaining()
            if build_info and build_info.get('building') is False:
                result = build_info.get('result') or 'UNKNOWN'
                break
            time.sleep(min(3, remaining()))

    if result != 'SUCCESS':
        raise click.ClickException(f'任务 {job_name} 构建 #{build_number} 未成功，状态: {result}')
    console.print(f'[bold green]🎉 构建 #{build_number} 成功！[/bold green]')
