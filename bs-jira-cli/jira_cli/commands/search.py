"""JQL 搜索命令"""

import click

from jira_cli.client import JiraAPIError
from jira_cli.formatter import print_issues, print_error


@click.command("search")
@click.argument("jql", required=False)
@click.option("--max", "-m", "max_results", default=20, show_default=True, help="最大返回数量")
@click.option("--start", "start_at", default=0, help="起始偏移（分页用）")
@click.option("--mine", is_flag=True, help="快捷搜索：我报告的 Issue")
@click.option("--assigned-to-me", "assigned", is_flag=True, help="快捷搜索：分配给我的 Issue")
@click.option("--open", "open_only", is_flag=True, help="仅显示未关闭的 Issue")
@click.option("--project", "-p", default=None, help="限定项目")
@click.option("--fields", "-f", default=None, help="返回字段（逗号分隔），默认常用字段")
@click.pass_context
def search_command(ctx, jql, max_results, start_at, mine, assigned, open_only, project, fields):
    """🔍 搜索 Issue（JQL）

    JQL: Jira 查询语句，例如 'project = PROJ AND status = Open'

    \b
    快捷搜索示例：
      jira search --mine                          # 我报告的 Issue
      jira search --assigned-to-me                # 分配给我的
      jira search --assigned-to-me --open         # 分配给我的未关闭 Issue
      jira search -p PROJ --open                  # 某项目未关闭的 Issue
      jira search "summary ~ '关键词'"            # 按关键词搜索
    """
    from jira_cli.main import get_client
    client = get_client(ctx)

    # 构建 JQL
    jql_parts = []
    if mine:
        jql_parts.append("reporter = currentUser()")
    if assigned:
        jql_parts.append("assignee = currentUser()")
    if project:
        jql_parts.append(f'project = "{project.upper()}"')
    if open_only:
        jql_parts.append("resolution = Unresolved")

    order_by_clause = "ORDER BY updated DESC"
    if jql:
        import re
        from jira_cli.config import get_aliases
        aliases = get_aliases()
        extracted_orders = []

        def replace_alias(match):
            alias_name = match.group(1)
            if alias_name in aliases:
                alias_jql = aliases[alias_name]
                # 剥离别名内的 ORDER BY，避免嵌套导致语法错误
                m = re.search(r'(?i)\s+ORDER\s+BY\s+.*$', alias_jql)
                if m:
                    extracted_orders.append(m.group(0).strip())
                    alias_jql = alias_jql[:m.start()].strip()
                return f"({alias_jql})"
            else:
                from jira_cli.formatter import print_warning
                print_warning(f"别名未找到: @{alias_name}")
                return match.group(0)

        # 允许在字符串任何位置替换别名 (支持中文别名)
        jql = re.sub(r'@([\w\u4e00-\u9fa5-]+)', replace_alias, jql)

        # 提取用户自定义 JQL 末尾的 ORDER BY
        match = re.search(r'(?i)\s+ORDER\s+BY\s+.*$', jql)
        if match:
            extracted_orders.append(match.group(0).strip())
            jql = jql[:match.start()].strip()
            
        if extracted_orders:
            order_by_clause = extracted_orders[-1]

        if jql:
            jql_parts.append(f"({jql})")

    if not jql_parts:
        # 默认：分配给当前用户的 Issue
        jql_parts.append("assignee = currentUser()")

    final_jql = " AND ".join(jql_parts) + f" {order_by_clause}"

    if not fields:
        fields = "summary,status,issuetype,priority,assignee,updated"

    try:
        result = client.search_issues(
            jql=final_jql,
            max_results=max_results,
            start_at=start_at,
            fields=fields,
        )
        print_issues(
            result.get("issues", []),
            total=result.get("total", 0),
            start_at=start_at,
        )
    except JiraAPIError as e:
        print_error(f"搜索失败: {e}")
        raise SystemExit(1)
