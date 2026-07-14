"""Jira REST API v2 客户端

封装所有 Jira API 调用，统一错误处理。
适配 Jira v6.0.5。
"""

import requests


class JiraAPIError(Exception):
    """Jira API 调用异常"""

    def __init__(self, status_code: int, message: str, url: str = ""):
        self.status_code = status_code
        self.url = url
        super().__init__(f"[{status_code}] {message}")


class JiraClient:
    """Jira REST API v2 客户端"""

    def __init__(self, base_url: str, username: str, password: str, timeout: int = 30):
        """初始化客户端

        Args:
            base_url: Jira 服务器地址，例如 http://172.18.169.8:6899
            username: 用户名
            password: 密码
            timeout: 请求超时时间（秒）
        """
        self.base_url = base_url.rstrip("/")
        self.api_base = f"{self.base_url}/rest/api/2"
        self.timeout = timeout
        self.username = username
        self.password = password
        self._logged_in = False

        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

    def _login(self):
        """执行 Cookie 认证登录（解决 Basic Auth 对中文用户名的编码兼容问题）"""
        if self._logged_in:
            return
            
        url = f"{self.base_url}/rest/auth/1/session"
        try:
            resp = self.session.post(
                url,
                json={"username": self.username, "password": self.password},
                timeout=self.timeout
            )
        except requests.ConnectionError:
            raise JiraAPIError(0, f"无法连接到 Jira 服务器: {self.base_url}")
        except requests.Timeout:
            raise JiraAPIError(0, f"登录请求超时 ({self.timeout}s): {url}")
            
        if resp.status_code >= 400:
            msg = resp.text.strip()
            if "<html" in msg.lower() or "<body" in msg.lower():
                import re
                title_match = re.search(r"<title>(.*?)</title>", msg, re.IGNORECASE)
                msg = f"HTML Response: {title_match.group(1).strip()}" if title_match else "HTML Response (可能认证失败)"
            elif not msg:
                msg = f"HTTP {resp.status_code}"
            else:
                try:
                    error_data = resp.json()
                    messages = error_data.get("errorMessages", [])
                    if messages:
                        msg = "; ".join(messages)
                except ValueError:
                    pass
            raise JiraAPIError(resp.status_code, f"认证失败: {msg}", url)
            
        self._logged_in = True

    def _request(self, method: str, path: str, **kwargs) -> dict | list | None:
        """发送 API 请求"""
        self._login()
        url = f"{self.api_base}{path}"
        kwargs.setdefault("timeout", self.timeout)

        try:
            resp = self.session.request(method, url, **kwargs)
        except requests.ConnectionError:
            raise JiraAPIError(0, f"无法连接到 Jira 服务器: {self.base_url}")
        except requests.Timeout:
            raise JiraAPIError(0, f"请求超时 ({self.timeout}s): {url}")

        if resp.status_code == 204:
            return None

        if resp.status_code >= 400:
            try:
                error_data = resp.json()
                messages = error_data.get("errorMessages", [])
                errors = error_data.get("errors", {})
                msg_parts = messages + [f"{k}: {v}" for k, v in errors.items()]
                msg = "; ".join(msg_parts) if msg_parts else resp.text
            except (ValueError, AttributeError):
                msg = resp.text.strip()
                # 如果返回了 HTML 页面（通常是 401/403 或者被代理拦截），简化错误信息
                if "<html" in msg.lower() or "<body" in msg.lower():
                    import re
                    # 尝试提取 title
                    title_match = re.search(r"<title>(.*?)</title>", msg, re.IGNORECASE)
                    if title_match:
                        msg = f"HTML Response: {title_match.group(1).strip()}"
                    else:
                        msg = "HTML Response (可能认证失败或被代理拦截)"
                elif not msg:
                    msg = f"HTTP {resp.status_code}"
            raise JiraAPIError(resp.status_code, msg, url)

        if not resp.text:
            return None

        return resp.json()

    # ──────────────────────────────────────────────
    # 服务器信息
    # ──────────────────────────────────────────────

    def server_info(self) -> dict:
        """获取服务器信息"""
        return self._request("GET", "/serverInfo")

    def test_connection(self) -> dict:
        """测试连接并获取当前用户信息"""
        info = self.server_info()
        # 尝试获取当前用户信息
        try:
            myself = self._request("GET", "/myself")
            info["currentUser"] = myself
        except JiraAPIError:
            # Jira v6 可能不支持 /myself 接口
            try:
                session = self.session.get(
                    f"{self.base_url}/rest/auth/1/session",
                    timeout=self.timeout,
                )
                if session.status_code == 200:
                    info["currentUser"] = session.json()
            except Exception:
                pass
        return info

    # ──────────────────────────────────────────────
    # 项目
    # ──────────────────────────────────────────────

    def get_projects(self) -> list:
        """获取所有项目列表"""
        return self._request("GET", "/project")

    def get_project(self, key: str) -> dict:
        """获取项目详情

        Args:
            key: 项目 Key，如 PROJ
        """
        return self._request("GET", f"/project/{key}")

    # ──────────────────────────────────────────────
    # Issue
    # ──────────────────────────────────────────────

    def search_issues(self, jql: str, max_results: int = 50, start_at: int = 0,
                      fields: str = None) -> dict:
        """JQL 搜索 Issue

        Args:
            jql: JQL 查询语句
            max_results: 最大返回数量
            start_at: 起始偏移
            fields: 返回字段（逗号分隔），None 为全部

        Returns:
            {"startAt", "maxResults", "total", "issues": [...]}
        """
        params = {
            "jql": jql,
            "maxResults": max_results,
            "startAt": start_at,
        }
        if fields:
            params["fields"] = fields
        return self._request("GET", "/search", params=params)

    def get_issue(self, key: str, fields: str = None) -> dict:
        """获取 Issue 详情

        Args:
            key: Issue Key，如 PROJ-123
            fields: 返回字段（逗号分隔），None 为全部
        """
        params = {}
        if fields:
            params["fields"] = fields
        return self._request("GET", f"/issue/{key}", params=params)

    def create_issue(self, fields: dict) -> dict:
        """创建 Issue

        Args:
            fields: Issue 字段，例如:
                {
                    "project": {"key": "PROJ"},
                    "summary": "标题",
                    "issuetype": {"name": "Bug"},
                    "description": "描述"
                }

        Returns:
            {"id", "key", "self"}
        """
        return self._request("POST", "/issue", json={"fields": fields})

    def update_issue(self, key: str, fields: dict) -> None:
        """更新 Issue

        Args:
            key: Issue Key
            fields: 要更新的字段
        """
        self._request("PUT", f"/issue/{key}", json={"fields": fields})

    def delete_issue(self, key: str) -> None:
        """删除 Issue

        Args:
            key: Issue Key
        """
        self._request("DELETE", f"/issue/{key}")

    def get_transitions(self, key: str) -> list:
        """获取 Issue 可用的状态变更

        Args:
            key: Issue Key

        Returns:
            [{"id", "name", "to": {"name", "id"}}, ...]
        """
        result = self._request("GET", f"/issue/{key}/transitions")
        return result.get("transitions", [])

    def do_transition(self, key: str, transition_id: str, comment: str = None) -> None:
        """执行 Issue 状态变更

        Args:
            key: Issue Key
            transition_id: 状态变更 ID
            comment: 可选的变更评论
        """
        payload = {
            "transition": {"id": transition_id},
        }
        if comment:
            payload["update"] = {
                "comment": [{"add": {"body": comment}}],
            }
        self._request("POST", f"/issue/{key}/transitions", json=payload)

    # ──────────────────────────────────────────────
    # Issue 类型
    # ──────────────────────────────────────────────

    def get_issue_types(self) -> list:
        """获取所有 Issue 类型"""
        return self._request("GET", "/issuetype")

    def get_create_meta(self, project_key: str) -> dict:
        """获取创建 Issue 的元数据（可用字段和类型）

        Args:
            project_key: 项目 Key
        """
        params = {
            "projectKeys": project_key,
            "expand": "projects.issuetypes.fields",
        }
        return self._request("GET", "/issue/createmeta", params=params)

    # ──────────────────────────────────────────────
    # 评论
    # ──────────────────────────────────────────────

    def get_comments(self, issue_key: str) -> list:
        """获取 Issue 的所有评论

        Args:
            issue_key: Issue Key

        Returns:
            评论列表
        """
        result = self._request("GET", f"/issue/{issue_key}/comment")
        return result.get("comments", [])

    def add_comment(self, issue_key: str, body: str) -> dict:
        """添加评论

        Args:
            issue_key: Issue Key
            body: 评论内容

        Returns:
            创建的评论对象
        """
        return self._request("POST", f"/issue/{issue_key}/comment", json={"body": body})

    def assign_issue(self, issue_key: str, assignee: str) -> None:
        """分配任务给指定用户

        Args:
            issue_key: Issue ID，例如 PROJ-123
            assignee: 被分配人的用户名
        """
        payload = {"name": assignee}
        self._request("PUT", f"/issue/{issue_key}/assignee", json=payload)

    # ──────────────────────────────────────────────
    # 用户
    # ──────────────────────────────────────────────

    def get_assignable_users(self, project_key: str, username: str = None) -> list:
        """获取项目中可分配的用户列表

        Args:
            project_key: 项目 Key
            username: 用户名过滤（模糊匹配）
        """
        params = {"project": project_key}
        if username:
            params["username"] = username
        return self._request("GET", "/user/assignable/search", params=params)

    # ──────────────────────────────────────────────
    # 状态
    # ──────────────────────────────────────────────

    def get_statuses(self) -> list:
        """获取所有状态"""
        return self._request("GET", "/status")
