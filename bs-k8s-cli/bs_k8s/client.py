"""HTTP 认证、私有配置、资源发现及脱敏输出。"""

import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from urllib.parse import quote, urlsplit

import requests


class K8sError(Exception):
    """只包含可安全输出的诊断信息。"""


class ApiError(K8sError):
    def __init__(self, status, method, path, reason=""):
        self.status = status
        super().__init__(f"HTTP {status}: {method} {path.split('?')[0]} {reason}".strip())


def config_path():
    return Path(os.environ.get("BS_K8S_CONFIG", "~/.config/bsq-k8s/config.json")).expanduser()


def private_json(path, value):
    """先写临时文件再替换，避免配置或会话只写了一半。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_private(path):
    path = Path(path)
    if not path.is_file():
        raise K8sError(f"找不到配置：{path}；先运行 config add")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise K8sError(f"私有文件权限过宽，请先 chmod 600 {path}")
    try:
        with path.open(encoding="utf-8") as source:
            return json.load(source)
    except (ValueError, OSError):
        raise K8sError(f"无法读取有效 JSON：{path}") from None


def load_profile(path, name=None):
    cfg = read_private(path)
    name = name or cfg.get("default_profile")
    profile = cfg.get("profiles", {}).get(name)
    if not isinstance(profile, dict):
        raise K8sError("连接别名不存在或未设置默认连接；用 --profile 指定")
    return name, profile


def secret_value(profile, key):
    env_name = profile.get(f"{key}_env")
    if env_name:
        value = os.environ.get(env_name)
        if not value:
            raise K8sError(f"缺少环境变量：{env_name}")
        return value
    value = profile.get(key)
    if not value:
        raise K8sError(f"连接缺少 {key} 或 {key}_env")
    return value


def encode_password(key, password):
    """兼容已核对的 KubeSphere 3.x console /login 协议。"""
    value = base64.b64encode(password.encode("utf-8")).decode()
    if len(value) > len(key):
        key += value[:len(value) - len(key)]
    bits, chars = [], []
    for index, char in enumerate(key):
        num = ord(char) + (ord(value[index]) if index < len(value) else 64)
        bits.append(str(num % 2))
        chars.append(chr(num // 2))
    return base64.b64encode("".join(bits).encode()).decode() + "@" + "".join(chars)


SENSITIVE = re.compile(r"password|passwd|token|secret|credential|authorization|cookie|private.?key|license|client.?key", re.I)


def redact(value, inherited_kind=""):
    """资源输出默认隐藏 Secret、内联环境变量和配置正文，避免意外输出密钥。"""
    if isinstance(value, list):
        return [redact(item, inherited_kind) for item in value]
    if not isinstance(value, dict):
        return value
    obj = {}
    kind = value.get("kind", inherited_kind)
    for key, item in value.items():
        if key in ("managedFields", "last-applied-configuration") or "last-applied-configuration" in key:
            continue
        if key in ("data", "stringData", "binaryData") and kind in ("Secret", "ConfigMap"):
            obj[key] = {name: "<redacted>" for name in item} if isinstance(item, dict) else "<redacted>"
        elif key == "env" and isinstance(item, list):
            obj[key] = [{**redact(env), **({"value": "<redacted>"} if "value" in env else {})} for env in item]
        elif key in ("command", "args"):
            obj[key] = "<redacted>"
        elif SENSITIVE.search(key):
            obj[key] = "<redacted>"
        elif key == "annotations" and isinstance(item, dict):
            obj[key] = {name: "<redacted>" for name in item}
        elif key == "items" and kind.endswith("List"):
            obj[key] = redact(item, kind[:-4])
        else:
            obj[key] = redact(item)
    return obj


def segment(value):
    if not value or value in (".", "..") or any(c in value for c in "/?#%\\"):
        raise K8sError("资源名称、命名空间或 API 路径段无效")
    return quote(value, safe="")


class Client:
    def __init__(self, profile, *, name="default", config=None, timeout=20, session=None):
        self.profile = profile
        self.name = name
        self.config = Path(config) if config else config_path()
        self.timeout = timeout
        self.session = session or requests.Session()
        self.base = profile.get("url", "").rstrip("/")
        url = urlsplit(self.base)
        if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.query or url.fragment:
            raise K8sError("url 必须为无账号、查询参数和片段的 HTTP(S) 地址")
        if profile.get("verify_tls", True) is not True:
            raise K8sError("不支持关闭 TLS 校验；自签证书请配置 ca_file")
        self.verify = profile.get("ca_file") or True
        self.mode = profile.get("mode", "kubesphere")
        if self.mode not in ("kubesphere", "kubernetes"):
            raise K8sError("mode 必须是 kubesphere 或 kubernetes")
        prefix = profile.get("api_prefix", "")
        if prefix and (not prefix.startswith("/") or ".." in prefix or any(x in prefix for x in "?#%\\")):
            raise K8sError("api_prefix 必须是安全的绝对路径")
        self.prefix = prefix.rstrip("/")
        self.resources = None
        self.logged_in = False

    def _request(self, method, path, **kwargs):
        if not path.startswith("/") or path.startswith("//") or ".." in path or "\\" in path:
            raise K8sError("只允许当前连接下的绝对 API 路径")
        try:
            response = self.session.request(method, self.base + path, timeout=self.timeout,
                                            verify=self.verify, allow_redirects=False, **kwargs)
        except requests.RequestException as exc:
            # 不输出 requests 异常正文，URL、代理或响应中可能包含认证材料。
            raise K8sError(f"请求失败（{type(exc).__name__}）；写请求不自动重试，请先查询实际状态") from None
        return response

    def _cache_path(self, password):
        identity = json.dumps([self.base, self.profile.get("username"), password,
                               self.profile.get("encrypt_key", "kubesphere")])
        digest = hashlib.sha256(identity.encode()).hexdigest()
        return self.config.parent / "sessions" / f"{digest}.json"

    def login(self, force=False):
        if self.logged_in and not force:
            return
        if self.mode == "kubernetes":
            self.session.headers["Authorization"] = "Bearer " + secret_value(self.profile, "token")
            self.logged_in = True
            return
        password = secret_value(self.profile, "password")
        path = self._cache_path(password)
        if path.exists() and not force:
            cached = read_private(path)
            if cached.get("expires_at", 0) > time.time() + 30 and cached.get("token"):
                self.session.cookies.set("token", cached["token"])
                self.logged_in = True
                return
        if not self.profile.get("username"):
            raise K8sError("连接缺少 username")
        self.session.cookies.clear()
        response = self._request("POST", "/login", json={
            "username": self.profile["username"],
            "encrypt": encode_password(self.profile.get("encrypt_key", "kubesphere"), password),
        })
        tokens = [cookie.value for cookie in self.session.cookies if cookie.name == "token"]
        if response.status_code not in (200, 302) or not tokens:
            raise K8sError(f"KubeSphere 登录失败（HTTP {response.status_code}）；未输出响应正文")
        token = tokens[-1]
        # JWT 仅解码有效期以控制缓存，认证有效性始终由服务端判断。
        expiry = time.time() + 300
        try:
            body = token.split(".")[1]
            expiry = min(float(json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))["exp"]), time.time() + 86400)
        except (IndexError, KeyError, ValueError, TypeError):
            pass
        private_json(path, {"token": token, "expires_at": expiry})
        self.logged_in = True

    def request(self, method, path, *, body=None, params=None, content_type=None, text=False, stream=False):
        self.login()
        kwargs = {"params": params or {}, "stream": stream}
        if body is not None:
            kwargs["data"] = json.dumps(body, ensure_ascii=False).encode("utf-8")
            kwargs["headers"] = {"Content-Type": content_type or "application/json"}
        response = self._request(method, self.prefix + path, **kwargs)
        if not response.ok:
            status = response.status_code
            response.close()
            reason = "会话无效，请运行 login --refresh 后查询实际状态" if status == 401 else ""
            raise ApiError(status, method, path, reason)
        if 300 <= response.status_code < 400 or "text/html" in response.headers.get("Content-Type", ""):
            response.close()
            raise K8sError("接口返回重定向或 HTML，可能会话失效或 API 路径不受支持；请核对连接")
        if stream:
            return response
        if text:
            return response.text
        if response.status_code == 204 or not response.content:
            return {}
        try:
            return response.json()
        except ValueError:
            raise K8sError("接口未返回有效 JSON；未输出响应正文") from None

    def list(self, path, params=None):
        """遵循 continue 分页，不能将首批数据当成全部资源。"""
        params = dict(params or {})
        params.setdefault("limit", 500)
        items, seen = [], set()
        while True:
            result = self.request("GET", path, params=params)
            items.extend(result.get("items", []))
            token = result.get("metadata", {}).get("continue")
            if not token:
                return {**result, "items": items}
            if token in seen:
                raise K8sError("服务端返回重复分页游标，停止读取")
            seen.add(token)
            params["continue"] = token

    def discover(self):
        if self.resources is not None:
            return self.resources
        versions = ["v1"]
        # KubeSphere console 的代理路由要求尾部斜线；/apis 会落到前端 HTML。
        for group in self.request("GET", "/apis/").get("groups", []):
            preferred = group.get("preferredVersion", {}).get("groupVersion")
            if preferred:
                versions.append(preferred)
        resources = []
        for version in versions:
            path = "/api/v1" if version == "v1" else "/apis/" + version
            try:
                listing = self.request("GET", path)
            except ApiError as exc:
                if exc.status in (403, 404, 503):
                    continue
                raise
            for item in listing.get("resources", []):
                if "/" not in item["name"]:
                    resources.append({**item, "apiVersion": version, "base": path})
        self.resources = resources
        return resources

    def resolve(self, resource, api_version=None):
        aliases = {"deploy": "deployments", "sts": "statefulsets", "ds": "daemonsets",
                   "po": "pods", "svc": "services", "ns": "namespaces", "cm": "configmaps",
                   "rs": "replicasets", "no": "nodes", "cj": "cronjobs", "sa": "serviceaccounts"}
        resource = aliases.get(resource.lower(), resource)
        # 指定版本时直接发现该版本，支持旧版与非首选 CRD 版本。
        if api_version:
            if not re.fullmatch(r"[a-zA-Z0-9.-]+(?:/[a-zA-Z0-9]+)?", api_version):
                raise K8sError("apiVersion 格式无效")
            base = "/api/v1" if api_version == "v1" else "/apis/" + api_version
            choices = [{**x, "apiVersion": api_version, "base": base}
                       for x in self.request("GET", base).get("resources", []) if "/" not in x["name"]]
        else:
            choices = self.discover()
        found = [x for x in choices if resource.lower() in
                 [x["name"].lower(), x.get("singularName", "").lower(), x["kind"].lower(),
                  *(s.lower() for s in x.get("shortNames", [])),
                  (x["name"] + "." + x["apiVersion"].split("/")[0]).lower()]]
        if len(found) > 1:
            # 同名资源优先标准稳定组，否则要求明确 API 版本。
            standard = [x for x in found if x["apiVersion"] in ("v1", "apps/v1", "batch/v1", "networking.k8s.io/v1")]
            found = standard if len(standard) == 1 else found
        if len(found) != 1:
            raise K8sError(f"资源 {resource} 未找到或存在歧义；用 api-resources 查询并指定 --api-version")
        return found[0]

    def resource_path(self, resource, namespace=None, name=None, all_namespaces=False):
        base = resource["base"]
        if resource["namespaced"]:
            if namespace:
                base += "/namespaces/" + segment(namespace)
            elif not all_namespaces:
                raise K8sError("必须显式指定 --namespace（或连接中配置 namespace）；跨空间查询用 -A")
            if name and not namespace:
                raise K8sError("按名称操作必须指定命名空间")
        base += "/" + segment(resource["name"])
        return base + ("/" + segment(name) if name else "")


def clone(value):
    return copy.deepcopy(value)
