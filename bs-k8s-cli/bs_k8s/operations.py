"""资源变更、镜像定位与发布状态；所有写入先经过服务端预演。"""

import re
import time

from .client import ApiError, K8sError, clone


WORKLOADS = {"Deployment", "StatefulSet", "DaemonSet"}


def write(client, method, path, *, body, execute=False, content_type=None, params=None):
    params = dict(params or {})
    # 不允许调用方覆盖预演标记；没有 --execute 就没有持久化写请求。
    params["dryRun"] = "All"
    preview = client.request(method, path, body=body, params=params, content_type=content_type)
    if not execute:
        return {"mode": "dry-run", "persisted": False, "resource": preview}
    params.pop("dryRun")
    result = client.request(method, path, body=body, params=params, content_type=content_type)
    return {"mode": "executed", "persisted": True, "rolloutVerified": False, "resource": result}


def guarded_patch(client, path, current, operations, execute=False):
    if not operations:
        raise K8sError("没有需要修改的字段")
    metadata = current.get("metadata", {})
    if not metadata.get("resourceVersion") or not metadata.get("uid"):
        raise K8sError("服务端资源缺少 UID 或 resourceVersion，不能安全更新")
    patch = [{"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
             {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
             *operations]
    return write(client, "PATCH", path, body=patch, execute=execute, content_type="application/json-patch+json")


def image_rows(resource):
    spec = resource.get("spec", {})
    if resource.get("kind") == "CronJob":
        spec = spec.get("jobTemplate", {}).get("spec", {}).get("template", {}).get("spec", {})
    elif resource.get("kind") != "Pod":
        spec = spec.get("template", {}).get("spec", {})
    statuses = {c["name"]: c for c in [*resource.get("status", {}).get("containerStatuses", []),
                                        *resource.get("status", {}).get("initContainerStatuses", [])]}
    return [{"type": "init" if field == "initContainers" else "container", "name": c["name"],
             "image": c["image"], "imagePullPolicy": c.get("imagePullPolicy"),
             "runningImageID": statuses.get(c["name"], {}).get("imageID")}
            for field in ("initContainers", "containers") for c in spec.get(field, [])]


def image_operations(resource, *, sets=None, container=None, tag=None):
    if resource.get("kind") not in WORKLOADS | {"CronJob"}:
        raise K8sError("image 支持 Deployment、StatefulSet、DaemonSet 和 CronJob")
    if bool(sets) == bool(container or tag):
        raise K8sError("使用 --set 容器=完整镜像，或同时指定 --container 与 --tag")
    if not sets and (not container or not tag):
        raise K8sError("修改 tag 必须同时指定 --container 与 --tag")
    spec = resource["spec"]
    prefix = "/spec/template/spec"
    if resource["kind"] == "CronJob":
        spec = spec["jobTemplate"]["spec"]
        prefix = "/spec/jobTemplate/spec/template/spec"
    spec = spec["template"]["spec"]
    containers = [(field, i, c) for field in ("initContainers", "containers") for i, c in enumerate(spec.get(field, []))]
    updates = {}
    if sets:
        for assignment in sets:
            name, sep, image = assignment.partition("=")
            if not sep or not name or not image or name in updates:
                raise K8sError("--set 需要唯一的 容器名=完整镜像")
            updates[name] = image
    else:
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", tag):
            raise K8sError("镜像 tag 格式无效")
        matches = [c for _, _, c in containers if c["name"] == container]
        if len(matches) != 1:
            raise K8sError("容器名不存在或不唯一；先运行 images")
        image = matches[0]["image"]
        if "@" in image:
            raise K8sError("当前镜像使用 digest，请用 --set 指定完整镜像")
        # 镜像仓库的端口冒号不是 tag 分隔符。
        slash, colon = image.rfind("/"), image.rfind(":")
        updates[container] = (image[:colon] if colon > slash else image) + ":" + tag
    result = []
    for name, image in updates.items():
        if not re.fullmatch(r"[^\s?#]+", image):
            raise K8sError("完整镜像名称包含无效字符")
        matches = [(f, i, c) for f, i, c in containers if c["name"] == name]
        if len(matches) != 1:
            raise K8sError(f"容器 {name} 不存在或不唯一；先运行 images")
        field, index, _ = matches[0]
        result.append({"op": "replace", "path": f"{prefix}/{field}/{index}/image", "value": image})
    return result


def rollout_state(resource):
    kind, spec, status = resource["kind"], resource.get("spec", {}), resource.get("status", {})
    if kind not in WORKLOADS:
        raise K8sError("rollout status 只支持 Deployment、StatefulSet、DaemonSet")
    if spec.get("paused"):
        return False, "发布已暂停", False
    if status.get("observedGeneration", 0) < resource["metadata"].get("generation", 1):
        return False, "控制器尚未处理最新配置", False
    for condition in status.get("conditions", []):
        if condition.get("type") == "Progressing" and condition.get("reason") == "ProgressDeadlineExceeded":
            return False, "发布超过进度期限", True
    if kind == "Deployment":
        desired = spec.get("replicas", 1)
        updated, available, ready = (status.get(key, 0) for key in ("updatedReplicas", "availableReplicas", "readyReplicas"))
        done = updated == desired and status.get("replicas", 0) == desired and available >= desired and ready >= desired
        return done, f"期望 {desired}，已更新 {updated}，就绪 {ready}，可用 {available}", False
    if kind == "DaemonSet":
        desired = status.get("desiredNumberScheduled", 0)
        done = status.get("updatedNumberScheduled", 0) == desired and status.get("numberAvailable", 0) >= desired and status.get("numberReady", 0) >= desired
        if not done and spec.get("updateStrategy", {}).get("type") == "OnDelete":
            return False, "OnDelete 策略需另行授权删除旧 Pod", False
        return done, f"期望 {desired}，已更新 {status.get('updatedNumberScheduled', 0)}，就绪 {status.get('numberReady', 0)}", False
    desired = spec.get("replicas", 1)
    strategy = spec.get("updateStrategy", {})
    partition = strategy.get("rollingUpdate", {}).get("partition", 0) if strategy.get("type") != "OnDelete" else 0
    required = max(0, desired - partition)
    done = status.get("readyReplicas", 0) >= desired and status.get("updatedReplicas", 0) >= required
    if partition == 0 and desired > 0:
        done = done and bool(status.get("updateRevision")) and status.get("currentRevision") == status.get("updateRevision")
    if not done and strategy.get("type") == "OnDelete":
        return False, "OnDelete 策略需另行授权删除旧 Pod", False
    return done, f"期望 {desired}，就绪 {status.get('readyReplicas', 0)}，已更新 {status.get('updatedReplicas', 0)}，partition={partition}", False


def wait_rollout(client, path, timeout=300, interval=3):
    deadline = time.monotonic() + timeout
    while True:
        resource = client.request("GET", path)
        ready, message, failed = rollout_state(resource)
        if failed:
            raise K8sError(message)
        if ready:
            return {"ready": True, "name": resource["metadata"]["name"], "message": message,
                    "generation": resource["metadata"].get("generation"), "businessVerified": False}
        if time.monotonic() >= deadline:
            raise K8sError(f"等待超时：{message}；未取消发布，也未重新提交")
        time.sleep(min(interval, max(0, deadline - time.monotonic())))


def deployment_history(client, resource, namespace):
    if resource.get("kind") != "Deployment":
        raise K8sError("history / undo 当前只支持 Deployment")
    uid = resource["metadata"]["uid"]
    items = client.list(f"/apis/apps/v1/namespaces/{namespace}/replicasets")["items"]
    owned = [item for item in items if any(ref.get("uid") == uid and ref.get("controller")
                                          for ref in item.get("metadata", {}).get("ownerReferences", []))]
    return sorted(owned, key=lambda x: int(x.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision", "0")))


def rollback_operations(current, history, revision):
    current_revision = current.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision")
    choices = [x for x in history if x.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision") == str(revision)]
    if len(choices) != 1:
        raise K8sError("指定 revision 不存在或不唯一；历史可能已被清理")
    if str(revision) == current_revision:
        raise K8sError("目标 revision 是当前版本")
    template = clone(choices[0]["spec"]["template"])
    template.get("metadata", {}).get("labels", {}).pop("pod-template-hash", None)
    return [{"op": "replace", "path": "/spec/template", "value": template}]


def manifest_target(client, document, namespace=None):
    if not isinstance(document, dict) or not document.get("apiVersion") or not document.get("kind"):
        raise K8sError("清单必须包含 apiVersion、kind 和 metadata.name")
    metadata = document.get("metadata", {})
    if not metadata.get("name"):
        raise K8sError("清单必须包含 metadata.name；不支持隐式批量或 generateName")
    resolved = client.resolve(document["kind"], document["apiVersion"])
    declared_ns = metadata.get("namespace")
    if namespace and declared_ns and namespace != declared_ns:
        raise K8sError("清单 namespace 与 --namespace / 连接默认空间不一致")
    ns = namespace or declared_ns
    if not resolved["namespaced"] and declared_ns:
        raise K8sError("集群级资源不能声明 namespace")
    obj = clone(document)
    obj.pop("status", None)
    obj["metadata"].pop("managedFields", None)
    if resolved["namespaced"]:
        obj["metadata"]["namespace"] = ns
    path = client.resource_path(resolved, ns, metadata["name"])
    return resolved, path, obj


def apply_documents(client, documents, namespace, execute=False, operation="apply"):
    prepared = []
    targets = set()
    for doc in documents:
        resolved, path, obj = manifest_target(client, doc, namespace)
        if path in targets:
            raise K8sError("同一批清单包含重复资源，停止执行")
        targets.add(path)
        method, content_type, params = "PATCH", "application/apply-patch+yaml", {"fieldManager": "bsq-k8s"}
        if operation == "create":
            method, content_type, params = "POST", "application/json", {}
            path = path.rsplit("/", 1)[0]
        elif operation == "replace":
            current = client.request("GET", path)
            version = obj["metadata"].get("resourceVersion")
            if version and version != current["metadata"]["resourceVersion"]:
                raise K8sError("清单 resourceVersion 已过期，请重新查询")
            obj["metadata"]["resourceVersion"] = current["metadata"]["resourceVersion"]
            obj["metadata"]["uid"] = current["metadata"]["uid"]
            method, content_type, params = "PUT", "application/json", {}
        else:
            try:
                current = client.request("GET", path)
                obj["metadata"]["resourceVersion"] = current["metadata"]["resourceVersion"]
                obj["metadata"]["uid"] = current["metadata"]["uid"]
            except ApiError as exc:
                if exc.status != 404:
                    raise
                # 预演后若被别人抢先创建，POST 会返回 409，不能把新资源当成已审阅对象覆盖。
                method, content_type = "POST", "application/json"
                path = path.rsplit("/", 1)[0]
        prepared.append((method, path, obj, content_type, params))
    if not prepared:
        raise K8sError("清单为空")
    # 先校验所有清单再执行；多个资源仍不具备跨资源事务。
    previews = [write(client, method, path, body=obj, content_type=content_type, params=params)
                for method, path, obj, content_type, params in prepared]
    if not execute:
        return previews
    results = []
    for index, (method, path, obj, content_type, params) in enumerate(prepared):
        try:
            result = client.request(method, path, body=obj, content_type=content_type, params=params)
            results.append({"mode": "executed", "persisted": True, "resource": result})
        except K8sError as exc:
            raise K8sError(f"已执行 {index}/{len(prepared)} 项；失败位置 {path}；不自动重试或回滚。{exc}") from None
    return results
