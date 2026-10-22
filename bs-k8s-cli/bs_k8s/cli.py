"""CLI 入口；仅使用 HTTP，不调用浏览器或执行集群内命令。"""

import argparse
from datetime import datetime, timezone
import getpass
import json
from pathlib import Path
import sys

import yaml
import requests

from . import __version__
from .client import (Client, K8sError, config_path, load_profile, private_json,
                     read_private, redact, segment, clone)
from .operations import (WORKLOADS, apply_documents, deployment_history, guarded_patch,
                         image_operations, image_rows, rollback_operations,
                         rollout_state, wait_rollout, write)


def integer(value):
    try:
        result = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("必须是整数") from None
    if result < 0:
        raise argparse.ArgumentTypeError("不能是负数")
    return result


def positive(value):
    result = integer(value)
    if result == 0:
        raise argparse.ArgumentTypeError("必须大于 0")
    return result


def parser():
    common = argparse.ArgumentParser(add_help=False, argument_default=argparse.SUPPRESS)
    common.add_argument("--config", help="私有 JSON 配置路径，默认 BS_K8S_CONFIG 或 ~/.config/bsq-k8s/config.json")
    common.add_argument("-p", "--profile", help="连接别名")
    common.add_argument("-n", "--namespace", help="明确的命名空间")
    common.add_argument("-A", "--all-namespaces", action="store_true", help="仅用于跨空间查询")
    common.add_argument("--api-version", help="如 apps/v1；用于同名资源消歧义")
    common.add_argument("-o", "--output", choices=["json", "yaml", "table"], help="默认 json")
    common.add_argument("--timeout", type=positive, help="单次 HTTP 超时秒数，默认 20")
    common.add_argument("--show-sensitive", action="store_true", help="显式输出配置正文/Secret 等敏感字段；慎用于终端日志")
    common.add_argument("--execute", action="store_true", help="预演通过后实际执行；必须已有用户对目标操作的授权")
    root = argparse.ArgumentParser(prog="bsq-k8s", parents=[common], description="通过 HTTP 管理 KubeSphere / Kubernetes；写操作默认服务端 dry-run")
    root.add_argument("--version", action="version", version=__version__)
    commands = root.add_subparsers(dest="command", required=True)

    def command(name, help_text, parent=commands):
        return parent.add_parser(name, parents=[common], help=help_text)

    cfg = command("config", "管理私有多连接配置")
    configs = cfg.add_subparsers(dest="config_command", required=True)
    command("list", "只显示连接元数据", configs)
    add = command("add", "增量新增或更新连接，凭据不接受命令行明文", configs)
    add.add_argument("name")
    add.add_argument("--url", required=True)
    add.add_argument("--mode", choices=["kubesphere", "kubernetes"], default="kubesphere")
    add.add_argument("--username")
    pw = add.add_mutually_exclusive_group()
    pw.add_argument("--password-env")
    pw.add_argument("--password-stdin", action="store_true")
    tk = add.add_mutually_exclusive_group()
    tk.add_argument("--token-env")
    tk.add_argument("--token-stdin", action="store_true")
    add.add_argument("--ca-file")
    add.add_argument("--api-prefix", default="")
    add.add_argument("--default", action="store_true")
    for name in ("use", "remove"):
        command(name, "设置默认连接" if name == "use" else "删除一个连接", configs).add_argument("name")

    login = command("login", "验证认证，不输出 Token")
    login.add_argument("--refresh", action="store_true")
    command("version", "查询服务端版本")
    command("api-resources", "发现资源名称、版本、作用域和支持动作")
    get = command("get", "查询资源，支持标签和字段选择器")
    get.add_argument("resource")
    get.add_argument("name", nargs="?")
    get.add_argument("-l", "--selector")
    get.add_argument("--field-selector")
    describe = command("describe", "查询单个资源及其相关事件")
    describe.add_argument("target", help="如 deployment/my-service")
    events = command("events", "查询命名空间或指定资源的事件")
    events.add_argument("--for", dest="target", help="如 pod/my-pod")
    images = command("images", "列出普通容器与初始化容器的镜像")
    images.add_argument("target")
    logs = command("logs", "读取 Pod 日志，可跟随输出")
    logs.add_argument("pod")
    logs.add_argument("-c", "--container")
    logs.add_argument("--tail", type=integer, default=200)
    logs.add_argument("--since", type=integer, help="最近多少秒")
    logs.add_argument("--previous", action="store_true")
    logs.add_argument("--timestamps", action="store_true")
    logs.add_argument("-f", "--follow", action="store_true")
    top = command("top", "查询 metrics.k8s.io 原始 CPU/内存量纲")
    top.add_argument("resource", choices=["pods", "nodes"])
    top.add_argument("name", nargs="?")
    can = command("can-i", "查询 Kubernetes 代理身份的权限，非 KubeSphere 用户角色结论")
    can.add_argument("verb")
    can.add_argument("resource")
    can.add_argument("--name")
    can.add_argument("--subresource")

    image = command("image", "更新一个或多个容器镜像，包含 initContainers")
    image.add_argument("target")
    image.add_argument("--set", action="append", dest="sets", help="精确容器名=完整镜像，可重复")
    image.add_argument("--container")
    image.add_argument("--tag")
    restart = command("restart", "滚动重启 Deployment/StatefulSet/DaemonSet")
    restart.add_argument("target")
    scale = command("scale", "调整 Deployment/StatefulSet 副本数")
    scale.add_argument("target")
    scale.add_argument("--replicas", required=True, type=integer)
    for name in ("pause", "resume"):
        command(name, "暂停 Deployment 发布" if name == "pause" else "继续 Deployment 发布").add_argument("target")
    rollout = command("rollout", "发布状态、历史与指定 revision 回滚")
    rolls = rollout.add_subparsers(dest="rollout_command", required=True)
    status = command("status", "检查或等待发布完成", rolls)
    status.add_argument("target")
    status.add_argument("--wait", action="store_true")
    status.add_argument("--wait-timeout", type=positive, default=300)
    status.add_argument("--interval", type=positive, default=3)
    command("history", "查询 Deployment ReplicaSet 历史", rolls).add_argument("target")
    undo = command("undo", "恢复指定 revision 的完整 Pod 模板", rolls)
    undo.add_argument("target")
    undo.add_argument("--revision", required=True, type=positive)
    for name in ("apply", "create", "replace"):
        cmd = command(name, "从 YAML/JSON 文件操作资源，默认预演")
        cmd.add_argument("-f", "--file", required=True, help="本地文件或 - 表示 stdin")
    patch = command("patch", "使用 JSON Patch 或 JSON Merge Patch 更新单个资源")
    patch.add_argument("target")
    patch.add_argument("-f", "--file", required=True)
    patch.add_argument("--type", choices=["json", "merge"], default="merge")
    delete = command("delete", "按精确名称删除资源，带 UID/resourceVersion 前置条件")
    delete.add_argument("target")
    delete.add_argument("--cascade", choices=["Foreground", "Background", "Orphan"], default="Background")
    delete.add_argument("--grace-period", type=integer)
    for name in ("label", "annotate"):
        cmd = command(name, "增量设置 key=value 或用 key- 删除键")
        cmd.add_argument("target")
        cmd.add_argument("assignments", nargs="+")
    for name in ("cordon", "uncordon"):
        command(name, "设置节点禁止/允许调度；不驱逐现有 Pod").add_argument("node")
    job = command("run-job", "从 CronJob 创建一次性 Job")
    job.add_argument("cronjob")
    job.add_argument("--name", required=True, help="明确且唯一的 Job 名称")
    suspend = command("suspend", "暂停或恢复 CronJob 调度")
    suspend.add_argument("cronjob")
    suspend.add_argument("--value", choices=["true", "false"], required=True)
    env = command("env", "增量设置或移除工作负载中指定容器的环境变量")
    env.add_argument("target")
    env.add_argument("--container", required=True)
    env.add_argument("-f", "--file", required=True, help="YAML/JSON 键值对象；null 表示删除，避免命令行暴露值")
    taint = command("taint", "给节点增量设置或移除污点")
    taint.add_argument("node")
    taint.add_argument("taints", nargs="+", help="key=value:NoSchedule 或 key:NoSchedule-")
    raw = command("api-get", "读取当前连接下的 API 路径，不允许外部 URL 或写入")
    raw.add_argument("path")
    return root


def parse_args(argv=None):
    # 全局参数可置于子命令前后；子解析器不能用默认值覆盖前面已传的参数。
    defaults = argparse.Namespace(config=str(config_path()), profile=None, namespace=None,
                                  all_namespaces=False, api_version=None, output="json",
                                  timeout=20, show_sensitive=False, execute=False)
    return parser().parse_args(argv, namespace=defaults)


def emit(value, args):
    value = value if args.show_sensitive else redact(value)
    if args.output == "yaml":
        print(yaml.safe_dump(value, allow_unicode=True, sort_keys=False), end="")
    elif args.output == "table":
        rows = value.get("items", [value]) if isinstance(value, dict) else value
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            print(json.dumps(value, ensure_ascii=False, indent=2))
            return
        print("NAMESPACE\tKIND\tNAME\tREADY / PHASE")
        for row in rows:
            meta, state = row.get("metadata", {}), row.get("status", {})
            ready = state.get("phase", state.get("readyReplicas", ""))
            print(f"{meta.get('namespace', '')}\t{row.get('kind', '')}\t{meta.get('name', row.get('name', ''))}\t{ready}")
    else:
        print(json.dumps(value, ensure_ascii=False, indent=2))


def file_data(filename):
    try:
        text = sys.stdin.read() if filename == "-" else Path(filename).read_text(encoding="utf-8")
        docs = [doc for doc in yaml.safe_load_all(text) if doc is not None]
    except (OSError, yaml.YAMLError):
        raise K8sError("无法读取有效 YAML/JSON；未输出文件正文") from None
    return docs


def one_document(filename):
    docs = file_data(filename)
    if len(docs) != 1:
        raise K8sError("需要一个 YAML/JSON 文档")
    return docs[0]


def configure(args):
    path = Path(args.config).expanduser()
    cfg = read_private(path) if path.exists() else {"profiles": {}}
    profiles = cfg.setdefault("profiles", {})
    op = args.config_command
    if op == "list":
        emit({"default_profile": cfg.get("default_profile"), "profiles": [
            {"name": name, **{key: profile[key] for key in ("url", "mode", "namespace", "api_prefix") if key in profile}}
            for name, profile in profiles.items()]}, args)
        return
    if op in ("use", "remove"):
        if args.name not in profiles:
            raise K8sError("连接别名不存在")
        if op == "use":
            cfg["default_profile"] = args.name
        else:
            profiles.pop(args.name)
            if cfg.get("default_profile") == args.name:
                cfg.pop("default_profile", None)
    else:
        if not args.name or any(char in args.name for char in "/\\"):
            raise K8sError("连接别名格式无效")
        old = profiles.get(args.name, {})
        profile = {**old, "mode": args.mode, "url": args.url, "api_prefix": args.api_prefix, "verify_tls": True}
        if args.namespace:
            segment(args.namespace)
            profile["namespace"] = args.namespace
        if args.ca_file:
            profile["ca_file"] = str(Path(args.ca_file).expanduser().resolve())
        if args.mode == "kubesphere":
            if args.token_env or args.token_stdin:
                raise K8sError("KubeSphere 模式不使用 --token-env / --token-stdin")
            if args.username:
                profile["username"] = args.username
            if not profile.get("username"):
                raise K8sError("KubeSphere 连接需要 --username")
            key, env_var, from_stdin = "password", args.password_env, args.password_stdin
            profile.pop("token", None)
            profile.pop("token_env", None)
        else:
            if args.password_env or args.password_stdin or args.username:
                raise K8sError("原生 Kubernetes 模式只接受 Token")
            key, env_var, from_stdin = "token", args.token_env, args.token_stdin
            for field in ("username", "password", "password_env"):
                profile.pop(field, None)
        if env_var:
            profile[f"{key}_env"] = env_var
            profile.pop(key, None)
        elif from_stdin or not (profile.get(key) or profile.get(f"{key}_env")):
            if from_stdin:
                value = sys.stdin.read().rstrip("\r\n")
            elif sys.stdin.isatty():
                value = getpass.getpass(f"{key}（无回显）: ")
            else:
                raise K8sError(f"非交互配置请使用 --{key}-env 或 --{key}-stdin")
            if not value:
                raise K8sError(f"{key} 不能为空")
            profile[key] = value
            profile.pop(f"{key}_env", None)
        Client(profile, config=path)  # 只校验连接格式，不发送网络请求。
        profiles[args.name] = profile
        if args.default or not cfg.get("default_profile"):
            cfg["default_profile"] = args.name
    print(f"连接配置：{op} {args.name}；其他连接保留，凭据不显示", file=sys.stderr)
    private_json(path, cfg)
    emit({"configured": True, "operation": op, "profile": args.name}, args)


def target(client, args, value, name=None):
    if "/" in value:
        if name:
            raise K8sError("不要同时使用 resource/name 和独立 name")
        parts = value.split("/")
        if len(parts) != 2:
            raise K8sError("目标格式为 resource/name")
        value, name = parts
    resolved = client.resolve(value, args.api_version)
    path = client.resource_path(resolved, args.namespace, name, args.all_namespaces)
    return resolved, path, name


def require_single(client, args, value):
    resolved, path, name = target(client, args, value)
    if not name:
        raise K8sError("需要精确目标 resource/name；不支持批量变更")
    return resolved, path, client.request("GET", path)


def related_events(client, args, resource=None):
    events = client.resolve("events", "v1")
    ns = resource.get("metadata", {}).get("namespace") if resource else args.namespace
    path = client.resource_path(events, ns, all_namespaces=args.all_namespaces or bool(resource and not ns))
    params = {"fieldSelector": "involvedObject.uid=" + resource["metadata"]["uid"]} if resource else {}
    result = client.list(path, params)
    result["items"].sort(key=lambda x: x.get("lastTimestamp") or x.get("eventTime") or x.get("metadata", {}).get("creationTimestamp", ""))
    return result


def run(args, client=None):
    if args.command == "config":
        return configure(args)
    if args.all_namespaces and args.namespace:
        raise K8sError("-A 与 -n 不能同时使用")
    if client is None:
        name, profile = load_profile(Path(args.config).expanduser(), args.profile)
        client = Client(profile, name=name, config=args.config, timeout=args.timeout)
        args.profile = name
    if not args.namespace and not args.all_namespaces:
        args.namespace = client.profile.get("namespace")
    # 跨命名空间只用于查询，禁止误将 -A 作为批量写入范围。
    readonly = {"login", "version", "api-resources", "get", "describe", "events", "images", "logs", "top", "can-i", "api-get"}
    if args.command == "rollout" and args.rollout_command in ("status", "history"):
        readonly.add("rollout")
    if args.all_namespaces and args.command not in readonly:
        raise K8sError("变更不能使用 -A；必须明确命名空间")
    cmd = args.command
    if cmd == "login":
        client.login(force=args.refresh)
        if client.mode == "kubesphere":
            value = client.request("GET", "/kapis/iam.kubesphere.io/v1alpha2/users/" + segment(client.profile["username"]))
            result = {"authenticated": True, "profile": args.profile, "state": value.get("status", {}).get("state"),
                      "role": value.get("metadata", {}).get("annotations", {}).get("iam.kubesphere.io/globalrole")}
        else:
            result = {"authenticated": True, "profile": args.profile, "version": client.request("GET", "/version")}
    elif cmd == "version":
        result = client.request("GET", "/kapis/version" if client.mode == "kubesphere" else "/version")
    elif cmd == "api-resources":
        result = [{key: row.get(key) for key in ("name", "kind", "apiVersion", "namespaced", "shortNames", "verbs")} for row in client.discover()]
    elif cmd == "get":
        _, path, name = target(client, args, args.resource, args.name)
        params = {key: value for key, value in (("labelSelector", args.selector), ("fieldSelector", args.field_selector)) if value}
        if name and params:
            raise K8sError("按名称查询不接受 selector，避免过滤条件被忽略")
        result = client.request("GET", path) if name else client.list(path, params)
    elif cmd == "describe":
        _, _, current = require_single(client, args, args.target)
        result = {"resource": current, "events": related_events(client, args, current)}
    elif cmd == "events":
        current = require_single(client, args, args.target)[2] if args.target else None
        result = related_events(client, args, current)
    elif cmd == "images":
        _, _, current = require_single(client, args, args.target)
        result = {"name": current["metadata"]["name"], "namespace": current["metadata"].get("namespace"), "images": image_rows(current)}
    elif cmd == "logs":
        pod = client.resolve("pods", "v1")
        path = client.resource_path(pod, args.namespace, args.pod) + "/log"
        current = client.request("GET", path.rsplit("/", 1)[0])
        names = [row["name"] for row in image_rows(current)]
        if args.container and args.container not in names:
            raise K8sError("容器不存在；先运行 images pod/<name>")
        if not args.container and len(names) > 1:
            raise K8sError("Pod 包含多个容器（含初始化容器），必须指定 --container")
        params = {"tailLines": args.tail, "timestamps": str(args.timestamps).lower(), "previous": str(args.previous).lower()}
        if args.container:
            params["container"] = args.container
        if args.since is not None:
            params["sinceSeconds"] = args.since
        if args.follow:
            params["follow"] = "true"
            response = client.request("GET", path, params=params, stream=True)
            try:
                for chunk in response.iter_content(chunk_size=4096):
                    if chunk:
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
            finally:
                response.close()
        else:
            print(client.request("GET", path, params=params, text=True), end="")
        return
    elif cmd == "top":
        resolved = client.resolve(args.resource, "metrics.k8s.io/v1beta1")
        path = client.resource_path(resolved, args.namespace, args.name, args.all_namespaces)
        result = client.request("GET", path) if args.name else client.list(path)
    elif cmd == "can-i":
        resolved = client.resolve(args.resource, args.api_version)
        if resolved["namespaced"] and not args.namespace:
            raise K8sError("权限检查必须明确 --namespace")
        attr = {"verb": args.verb, "group": resolved["apiVersion"].split("/")[0] if "/" in resolved["apiVersion"] else "",
                "resource": resolved["name"]}
        for key, value in (("namespace", args.namespace if resolved["namespaced"] else None), ("name", args.name), ("subresource", args.subresource)):
            if value:
                attr[key] = value
        value = client.request("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", body={
            "apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "spec": {"resourceAttributes": attr}})
        result = {"proxyIdentityOnly": client.mode == "kubesphere", "attributes": attr, "status": value.get("status", {})}
        emit(result, args)
        if not result["status"].get("allowed"):
            raise K8sError("权限检查未允许该操作")
        return
    elif cmd in ("apply", "create", "replace"):
        documents = []
        for doc in file_data(args.file):
            documents.extend(doc.get("items", []) if isinstance(doc, dict) and doc.get("kind") == "List" else [doc])
        result = apply_documents(client, documents, args.namespace, args.execute, cmd)
    elif cmd in ("cordon", "uncordon", "taint"):
        _, path, current = require_single(client, args, "nodes/" + args.node)
        if cmd == "taint":
            taints = clone(current.get("spec", {}).get("taints", []))
            for value in args.taints:
                remove = value.endswith("-")
                value = value[:-1] if remove else value
                content, sep, effect = value.rpartition(":")
                if not sep or effect not in ("NoSchedule", "PreferNoSchedule", "NoExecute"):
                    raise K8sError("污点格式为 key=value:Effect 或 key:Effect-")
                key, _, val = content.partition("=")
                if not key:
                    raise K8sError("污点 key 不能为空")
                taints = [t for t in taints if not (t["key"] == key and t["effect"] == effect)]
                if not remove:
                    taints.append({"key": key, "value": val, "effect": effect})
            ops = [{"op": "add", "path": "/spec/taints", "value": taints}]
        else:
            ops = [{"op": "add", "path": "/spec/unschedulable", "value": cmd == "cordon"}]
        result = guarded_patch(client, path, current, ops, args.execute)
    elif cmd in ("run-job", "suspend"):
        _, path, current = require_single(client, args, "cronjobs/" + args.cronjob)
        if cmd == "suspend":
            result = guarded_patch(client, path, current, [{"op": "add", "path": "/spec/suspend", "value": args.value == "true"}], args.execute)
        else:
            spec = clone(current["spec"]["jobTemplate"])
            metadata = spec.get("metadata", {})
            doc = {"apiVersion": "batch/v1", "kind": "Job", "metadata": {
                "name": args.name, "namespace": args.namespace, "labels": metadata.get("labels", {}),
                "annotations": metadata.get("annotations", {})}, "spec": spec["spec"]}
            result = apply_documents(client, [doc], args.namespace, args.execute, "create")
    elif cmd == "api-get":
        if not args.path.startswith(("/api/", "/apis/", "/kapis/")) and args.path not in ("/api", "/apis", "/version", "/healthz", "/readyz", "/livez"):
            raise K8sError("api-get 仅支持当前服务端的 API 路径")
        if any(part in args.path.split("?")[0].split("/") for part in ("exec", "attach", "portforward", "proxy")):
            raise K8sError("api-get 不支持 exec/attach/portforward/proxy 子资源")
        if "%" in args.path or "#" in args.path:
            raise K8sError("api-get 路径不能包含编码路径段或片段")
        if args.path.split("?", 1)[0] in ("/healthz", "/readyz", "/livez"):
            print(client.request("GET", args.path, text=True))
            return
        result = client.request("GET", args.path)
    else:
        _, path, current = require_single(client, args, args.target)
        if cmd == "rollout":
            op = args.rollout_command
            if op == "status":
                if args.wait:
                    result = wait_rollout(client, path, args.wait_timeout, args.interval)
                else:
                    ready, message, failed = rollout_state(current)
                    result = {"ready": ready, "message": message, "failed": failed, "businessVerified": False}
                    emit(result, args)
                    if not ready:
                        raise K8sError("发布尚未完成；可用 --wait 等待")
                    return
            else:
                history = deployment_history(client, current, segment(args.namespace))
                if op == "history":
                    result = [{"revision": item.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision"),
                               "replicaSet": item["metadata"]["name"], "created": item["metadata"].get("creationTimestamp"),
                               "images": image_rows(item)} for item in history]
                else:
                    result = guarded_patch(client, path, current, rollback_operations(current, history, args.revision), args.execute)
        elif cmd == "delete":
            body = {"apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": args.cascade,
                    "preconditions": {"uid": current["metadata"]["uid"], "resourceVersion": current["metadata"]["resourceVersion"]}}
            if args.grace_period is not None:
                body["gracePeriodSeconds"] = args.grace_period
            result = write(client, "DELETE", path, body=body, execute=args.execute)
        elif cmd == "patch":
            body = one_document(args.file)
            if args.type == "json":
                if not isinstance(body, list) or not body:
                    raise K8sError("JSON Patch 文件必须是非空数组")
                result = guarded_patch(client, path, current, body, args.execute)
            else:
                if not isinstance(body, dict):
                    raise K8sError("Merge Patch 文件必须是对象")
                if "metadata" in body and not isinstance(body["metadata"], dict):
                    raise K8sError("metadata 必须是对象")
                body.setdefault("metadata", {}).update({"uid": current["metadata"]["uid"], "resourceVersion": current["metadata"]["resourceVersion"]})
                result = write(client, "PATCH", path, body=body, execute=args.execute, content_type="application/merge-patch+json")
        elif cmd in ("label", "annotate"):
            field = "labels" if cmd == "label" else "annotations"
            values = clone(current.get("metadata", {}).get(field, {}))
            for assignment in args.assignments:
                key, sep, value = assignment.partition("=")
                if sep and key:
                    values[key] = value
                elif assignment.endswith("-") and len(assignment) > 1:
                    values.pop(assignment[:-1], None)
                else:
                    raise K8sError("格式为 key=value 或 key-")
            result = guarded_patch(client, path, current, [{"op": "add", "path": "/metadata/" + field, "value": values}], args.execute)
        elif cmd == "image":
            result = guarded_patch(client, path, current, image_operations(current, sets=args.sets, container=args.container, tag=args.tag), args.execute)
        elif cmd == "env":
            if current["kind"] not in WORKLOADS:
                raise K8sError("env 支持 Deployment、StatefulSet、DaemonSet")
            changes = one_document(args.file)
            if not isinstance(changes, dict) or not changes:
                raise K8sError("环境变量文件必须是非空键值对象；值为 null 表示删除")
            fields = [(field, i, c) for field in ("containers", "initContainers") for i, c in enumerate(current["spec"]["template"]["spec"].get(field, [])) if c["name"] == args.container]
            if len(fields) != 1:
                raise K8sError("容器名不存在或不唯一；先运行 images")
            field, index, container = fields[0]
            envs = clone(container.get("env", []))
            for key, value in changes.items():
                if not isinstance(key, str) or (value is not None and not isinstance(value, (str, int, float, bool, dict))):
                    raise K8sError("环境变量名必须是字符串；值支持标量、valueFrom 对象或 null")
                envs = [item for item in envs if item["name"] != key]
                if value is not None:
                    if isinstance(value, dict):
                        if set(value) != {"valueFrom"} or not isinstance(value["valueFrom"], dict):
                            raise K8sError("对象环境变量必须为 {valueFrom: {...}}")
                        envs.append({"name": key, **value})
                    else:
                        envs.append({"name": key, "value": str(value).lower() if isinstance(value, bool) else str(value)})
            result = guarded_patch(client, path, current, [{"op": "add", "path": f"/spec/template/spec/{field}/{index}/env", "value": envs}], args.execute)
        elif cmd in ("restart", "scale", "pause", "resume"):
            if current["kind"] not in WORKLOADS:
                raise K8sError("目标必须是 Deployment、StatefulSet 或 DaemonSet")
            if cmd == "restart":
                if current["spec"].get("paused"):
                    raise K8sError("Deployment 已暂停，需先明确是否恢复")
                annotation = clone(current["spec"]["template"].get("metadata", {}).get("annotations", {}))
                annotation["kubectl.kubernetes.io/restartedAt"] = datetime.now(timezone.utc).isoformat()
                metadata = clone(current["spec"]["template"].get("metadata", {}))
                metadata["annotations"] = annotation
                ops = [{"op": "add", "path": "/spec/template/metadata", "value": metadata}]
            elif cmd == "scale":
                if current["kind"] == "DaemonSet":
                    raise K8sError("DaemonSet 不支持按副本数扩缩容")
                ops = [{"op": "add", "path": "/spec/replicas", "value": args.replicas}]
            else:
                if current["kind"] != "Deployment":
                    raise K8sError("pause / resume 只支持 Deployment")
                ops = [{"op": "add", "path": "/spec/paused", "value": cmd == "pause"}]
            result = guarded_patch(client, path, current, ops, args.execute)
        else:
            raise K8sError("不支持的命令")
    emit(result, args)


def main(argv=None):
    try:
        args = parse_args(argv)
        run(args)
        return 0
    except K8sError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已中断；已提交的变更不会自动撤销，请先查询实际状态", file=sys.stderr)
        return 130
    except requests.RequestException as exc:
        print(f"错误：读取响应失败（{type(exc).__name__}）；请查询实际状态，未自动重试", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        # 配置、清单与响应异常只输出类型，不能把原始凭据或文件内容带入日志。
        print(f"错误：配置/清单/响应格式异常（{type(exc).__name__}）；未输出原始内容", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
