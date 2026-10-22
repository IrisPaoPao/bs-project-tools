import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bs_k8s.cli import main, parse_args, run
from bs_k8s.client import ApiError, Client, K8sError, private_json, read_private, redact
from bs_k8s.operations import (apply_documents, deployment_history, guarded_patch, image_operations,
                               image_rows, rollback_operations, rollout_state, wait_rollout, write)


def deployment(kind="Deployment"):
    return {"apiVersion": "apps/v1", "kind": kind,
            "metadata": {"name": "assembly", "namespace": "dev", "uid": "uid-1", "resourceVersion": "10", "generation": 3,
                         "annotations": {"deployment.kubernetes.io/revision": "3"}},
            "spec": {"replicas": 1, "selector": {"matchLabels": {"app": "assembly"}},
                     "template": {"metadata": {"labels": {"app": "assembly"}}, "spec": {
                         "initContainers": [{"name": "business", "image": "registry:7005/team/business:artifact-1.0", "env": [{"name": "KEEP", "valueFrom": {"secretKeyRef": {"name": "s", "key": "k"}}}]}],
                         "containers": [{"name": "runtime", "image": "runtime/jdk:8"}]}}},
            "status": {"observedGeneration": 3, "replicas": 1, "updatedReplicas": 1, "availableReplicas": 1, "readyReplicas": 1}}


RESOURCES = [
    {"name": "deployments", "kind": "Deployment", "apiVersion": "apps/v1", "base": "/apis/apps/v1", "namespaced": True},
    {"name": "statefulsets", "kind": "StatefulSet", "apiVersion": "apps/v1", "base": "/apis/apps/v1", "namespaced": True},
    {"name": "daemonsets", "kind": "DaemonSet", "apiVersion": "apps/v1", "base": "/apis/apps/v1", "namespaced": True},
    {"name": "replicasets", "kind": "ReplicaSet", "apiVersion": "apps/v1", "base": "/apis/apps/v1", "namespaced": True},
    {"name": "pods", "kind": "Pod", "apiVersion": "v1", "base": "/api/v1", "namespaced": True},
    {"name": "configmaps", "kind": "ConfigMap", "apiVersion": "v1", "base": "/api/v1", "namespaced": True},
    {"name": "events", "kind": "Event", "apiVersion": "v1", "base": "/api/v1", "namespaced": True},
    {"name": "nodes", "kind": "Node", "apiVersion": "v1", "base": "/api/v1", "namespaced": False},
    {"name": "cronjobs", "kind": "CronJob", "apiVersion": "batch/v1", "base": "/apis/batch/v1", "namespaced": True},
    {"name": "jobs", "kind": "Job", "apiVersion": "batch/v1", "base": "/apis/batch/v1", "namespaced": True},
]
PATH = "/apis/apps/v1/namespaces/dev/deployments/assembly"


def json_patch(obj, operations):
    for op in operations:
        keys = [s.replace("~1", "/").replace("~0", "~") for s in op["path"].split("/")[1:]]
        parent = obj
        for key in keys[:-1]:
            parent = parent[int(key)] if isinstance(parent, list) else parent[key]
        key = int(keys[-1]) if isinstance(parent, list) else keys[-1]
        if op["op"] == "test":
            if parent[key] != op["value"]:
                raise ApiError(409, "PATCH", PATH)
        elif op["op"] in ("replace", "add"):
            parent[key] = copy.deepcopy(op["value"])
        elif op["op"] == "remove":
            del parent[key]
    return obj


class FakeClient(Client):
    def __init__(self):
        self.profile = {}
        self.mode = "kubernetes"
        self.resources = copy.deepcopy(RESOURCES)
        self.calls = []
        self.objects = {PATH: deployment()}
        self.failure = None
        self.race = False

    def resolve(self, resource, api_version=None):
        if api_version:
            aliases = {"deploy": "deployments", "cm": "configmaps", "po": "pods"}
            resource = aliases.get(resource, resource)
            choices = [r for r in self.resources if r["apiVersion"] == api_version and resource.lower() in (r["kind"].lower(), r["name"].lower())]
            if len(choices) != 1:
                raise K8sError("资源不存在")
            return choices[0]
        return super().resolve(resource)

    def request(self, method, path, *, body=None, params=None, content_type=None, **kwargs):
        params = params or {}
        self.calls.append({"method": method, "path": path, "body": copy.deepcopy(body), "params": dict(params), "content_type": content_type})
        if method == "GET":
            if path in self.objects:
                return copy.deepcopy(self.objects[path])
            if path.endswith(("/replicasets", "/events", "/pods", "/deployments")):
                return {"items": [copy.deepcopy(obj) for key, obj in self.objects.items() if key.rsplit("/", 1)[0] == path]}
            raise ApiError(404, method, path)
        if self.failure:
            raise self.failure
        if method == "PATCH" and content_type == "application/json-patch+json":
            obj = json_patch(copy.deepcopy(self.objects[path]), body)
        elif method == "DELETE":
            metadata = self.objects[path]["metadata"]
            if any(body["preconditions"].get(key) != metadata[key] for key in ("uid", "resourceVersion")):
                raise ApiError(409, method, path)
            obj = {"kind": "Status", "status": "Success"}
        else:
            obj = copy.deepcopy(body)
        if params.get("dryRun") == "All":
            if self.race:
                self.objects[PATH]["metadata"]["resourceVersion"] = "11"
            return obj
        if method == "DELETE":
            self.objects.pop(path)
        else:
            self.objects[path] = obj
        return obj


class CliTest(unittest.TestCase):
    def invoke(self, argv, client=None):
        client = client or FakeClient()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            run(parse_args(argv), client)
        return client, stdout.getvalue()

    def test_global_options_survive_nested_subparsers(self):
        for argv in (["-p", "dev", "-n", "dev", "--execute", "rollout", "undo", "deploy/assembly", "--revision", "2"],
                     ["rollout", "undo", "deploy/assembly", "--revision", "2", "-p", "dev", "-n", "dev", "--execute"]):
            args = parse_args(argv)
            self.assertEqual((args.profile, args.namespace, args.execute), ("dev", "dev", True))

    def test_init_image_update_defaults_to_dryrun(self):
        client, output = self.invoke(["-n", "dev", "image", "deploy/assembly", "--container", "business", "--tag", "artifact-2.0"])
        result = json.loads(output)
        self.assertEqual(result["mode"], "dry-run")
        self.assertFalse(result["persisted"])
        self.assertEqual(image_rows(client.objects[PATH])[0]["image"], "registry:7005/team/business:artifact-1.0")
        self.assertEqual(image_rows(result["resource"])[0]["image"], "registry:7005/team/business:artifact-2.0")
        self.assertEqual(image_rows(result["resource"])[1]["image"], "runtime/jdk:8")
        writes = [c for c in client.calls if c["method"] != "GET"]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]["params"], {"dryRun": "All"})

    def test_execute_requires_successful_preflight(self):
        client, output = self.invoke(["restart", "deploy/assembly", "-n", "dev", "--execute"])
        self.assertTrue(json.loads(output)["persisted"])
        writes = [c for c in client.calls if c["method"] == "PATCH"]
        self.assertEqual([c["params"] for c in writes], [{"dryRun": "All"}, {}])
        self.assertIn("kubectl.kubernetes.io/restartedAt", client.objects[PATH]["spec"]["template"]["metadata"]["annotations"])
        self.assertFalse(json.loads(output)["rolloutVerified"])

    def test_preflight_failure_never_writes(self):
        client = FakeClient()
        client.failure = ApiError(403, "PATCH", PATH)
        with self.assertRaises(ApiError):
            self.invoke(["restart", "deploy/assembly", "-n", "dev", "--execute"], client)
        self.assertEqual(len([c for c in client.calls if c["method"] == "PATCH"]), 1)
        self.assertNotIn("annotations", client.objects[PATH]["spec"]["template"]["metadata"])

    def test_race_after_preflight_is_not_overwritten(self):
        client = FakeClient()
        client.race = True
        with self.assertRaises(ApiError):
            self.invoke(["image", "deploy/assembly", "-n", "dev", "--container", "business", "--tag", "new", "--execute"], client)
        self.assertEqual(image_rows(client.objects[PATH])[0]["image"], "registry:7005/team/business:artifact-1.0")
        self.assertEqual(len([c for c in client.calls if c["method"] == "PATCH"]), 2)

    def test_missing_namespace_rejected(self):
        with self.assertRaises(K8sError):
            self.invoke(["restart", "deploy/assembly"])

    def test_all_namespace_write_rejected(self):
        with self.assertRaises(K8sError):
            self.invoke(["restart", "deploy/assembly", "-A"])

    def test_namespace_conflicting_flags_rejected(self):
        with self.assertRaises(K8sError):
            self.invoke(["get", "deploy", "-A", "-n", "dev"])

    def test_scale_zero(self):
        _, out = self.invoke(["scale", "deploy/assembly", "-n", "dev", "--replicas", "0"])
        self.assertEqual(json.loads(out)["resource"]["spec"]["replicas"], 0)

    def test_negative_replicas_rejected_before_network(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parse_args(["scale", "deploy/x", "--replicas", "-1"])

    def test_deletion_has_preconditions_and_preview(self):
        client, output = self.invoke(["delete", "deploy/assembly", "-n", "dev"])
        request = client.calls[-1]
        self.assertEqual(request["body"]["preconditions"], {"uid": "uid-1", "resourceVersion": "10"})
        self.assertEqual(request["params"], {"dryRun": "All"})
        self.assertIn(PATH, client.objects)

    def test_metadata_merge_preserves_existing(self):
        _, out = self.invoke(["label", "deploy/assembly", "-n", "dev", "team=finance"])
        self.assertEqual(json.loads(out)["resource"]["metadata"]["labels"], {"team": "finance"})

    def test_pause_and_resume(self):
        _, output = self.invoke(["pause", "deploy/assembly", "-n", "dev"])
        self.assertTrue(json.loads(output)["resource"]["spec"]["paused"])
        _, output = self.invoke(["resume", "deploy/assembly", "-n", "dev"])
        self.assertFalse(json.loads(output)["resource"]["spec"]["paused"])

    def test_restart_paused_deployment_rejected(self):
        client = FakeClient()
        client.objects[PATH]["spec"]["paused"] = True
        with self.assertRaises(K8sError):
            self.invoke(["restart", "deploy/assembly", "-n", "dev"], client)

    def test_env_preserves_valuefrom_and_redacts_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "env.json"
            path.write_text(json.dumps({"NEW": "do-not-print-me"}))
            client, output = self.invoke(["env", "deploy/assembly", "-n", "dev", "--container", "business", "-f", str(path)])
            self.assertNotIn("do-not-print-me", output)
            body = client.calls[-1]["body"][-1]["value"]
            self.assertEqual(body[0]["valueFrom"]["secretKeyRef"]["name"], "s")
            self.assertEqual(body[1], {"name": "NEW", "value": "do-not-print-me"})

    def test_cordon_keeps_node_properties(self):
        client = FakeClient()
        client.objects["/api/v1/nodes/worker"] = {"kind": "Node", "metadata": {"name": "worker", "uid": "n", "resourceVersion": "9"}, "spec": {"taints": [{"key": "other", "effect": "NoExecute"}]}}
        _, output = self.invoke(["cordon", "worker"], client)
        node = json.loads(output)["resource"]
        self.assertTrue(node["spec"]["unschedulable"])
        self.assertEqual(len(node["spec"]["taints"]), 1)

    def test_taint_incremental_update(self):
        client = FakeClient()
        client.objects["/api/v1/nodes/worker"] = {"kind": "Node", "metadata": {"name": "worker", "uid": "n", "resourceVersion": "9"}, "spec": {"taints": [{"key": "keep", "effect": "NoExecute"}]}}
        _, output = self.invoke(["taint", "worker", "team=finance:NoSchedule"], client)
        self.assertEqual(len(json.loads(output)["resource"]["spec"]["taints"]), 2)

    def test_run_job_copies_template_without_modifying_cronjob(self):
        client = FakeClient()
        path = "/apis/batch/v1/namespaces/dev/cronjobs/nightly"
        cronjob = {"apiVersion": "batch/v1", "kind": "CronJob", "metadata": {"name": "nightly", "namespace": "dev", "uid": "cj", "resourceVersion": "10"},
                   "spec": {"schedule": "0 0 * * *", "jobTemplate": {"metadata": {"labels": {"app": "nightly"}}, "spec": {"template": {"spec": {"containers": [{"name": "sync", "image": "sync:v1"}], "restartPolicy": "Never"}}}}}}
        client.objects[path] = copy.deepcopy(cronjob)
        _, output = self.invoke(["run-job", "nightly", "--name", "nightly-manual", "-n", "dev"], client)
        result = json.loads(output)[0]
        self.assertEqual(result["resource"]["kind"], "Job")
        self.assertEqual(result["resource"]["metadata"]["name"], "nightly-manual")
        self.assertEqual(result["resource"]["metadata"]["labels"], {"app": "nightly"})
        self.assertEqual(client.objects[path], cronjob)
        self.assertFalse(result["persisted"])

    def test_suspend_is_preview_and_preserves_schedule(self):
        client = FakeClient()
        path = "/apis/batch/v1/namespaces/dev/cronjobs/nightly"
        client.objects[path] = {"kind": "CronJob", "metadata": {"name": "nightly", "uid": "cj", "resourceVersion": "1"}, "spec": {"schedule": "0 0 * * *"}}
        _, output = self.invoke(["suspend", "nightly", "--value", "true", "-n", "dev"], client)
        doc = json.loads(output)["resource"]
        self.assertTrue(doc["spec"]["suspend"])
        self.assertEqual(doc["spec"]["schedule"], "0 0 * * *")
        self.assertNotIn("suspend", client.objects[path]["spec"])

    def test_api_get_rejects_external_url_and_remote_execution(self):
        for path in ("https://other.invalid/api", "/api/v1/pods/p/exec", "/api/v1/nodes/n/proxy/metrics", "/api/v1/pods/p/%65xec", "/api/../login"):
            with self.subTest(path=path), self.assertRaises(K8sError):
                self.invoke(["api-get", path])


class ImageAndRolloutTest(unittest.TestCase):
    def test_tag_replacement_preserves_registry_port(self):
        doc = deployment()
        doc["spec"]["template"]["spec"]["initContainers"][0]["image"] = "host:7005/team/business"
        ops = image_operations(doc, container="business", tag="artifact-2")
        self.assertEqual(ops[0]["value"], "host:7005/team/business:artifact-2")

    def test_digest_requires_explicit_image(self):
        doc = deployment()
        doc["spec"]["template"]["spec"]["initContainers"][0]["image"] = "team/image@sha256:abcd"
        with self.assertRaises(K8sError):
            image_operations(doc, container="business", tag="latest")

    def test_unknown_container_invalid_tag_duplicate_assignment(self):
        for kwargs in ({"container": "missing", "tag": "v1"}, {"container": "business", "tag": "../v1"},
                       {"sets": ["business=x", "business=y"]}, {"sets": ["missing=x"]},
                       {"container": "business"}, {"sets": ["business=x"], "container": "business", "tag": "v1"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(K8sError):
                image_operations(deployment(), **kwargs)

    def test_multiple_images_target_only_selected_containers(self):
        ops = image_operations(deployment(), sets=["business=team/new:v2", "runtime=runtime/jdk:17"])
        self.assertEqual(len(ops), 2)
        self.assertIn("/initContainers/", ops[0]["path"])
        self.assertIn("/containers/", ops[1]["path"])

    def test_rollout_does_not_confuse_old_available_pods_with_new_revision(self):
        doc = deployment()
        doc["status"]["updatedReplicas"] = 0
        self.assertFalse(rollout_state(doc)[0])
        doc["status"]["updatedReplicas"] = 1
        doc["status"]["replicas"] = 2
        self.assertFalse(rollout_state(doc)[0])
        doc["status"]["replicas"] = 1
        self.assertTrue(rollout_state(doc)[0])

    def test_rollout_requires_observed_generation(self):
        doc = deployment()
        doc["status"]["observedGeneration"] = 2
        self.assertFalse(rollout_state(doc)[0])

    def test_zero_replicas_can_finish(self):
        doc = deployment()
        doc["spec"]["replicas"] = 0
        doc["status"] = {"observedGeneration": 3}
        self.assertTrue(rollout_state(doc)[0])

    def test_rollout_deadline_failure(self):
        doc = deployment()
        doc["status"]["conditions"] = [{"type": "Progressing", "reason": "ProgressDeadlineExceeded", "status": "False"}]
        self.assertTrue(rollout_state(doc)[2])

    def test_previous_generation_failure_does_not_fail_new_rollout(self):
        doc = deployment()
        doc["status"]["observedGeneration"] = 2
        doc["status"]["conditions"] = [{"type": "Progressing", "reason": "ProgressDeadlineExceeded", "status": "False"}]
        ready, _, failed = rollout_state(doc)
        self.assertFalse(ready)
        self.assertFalse(failed)

    def test_daemonset_ondelete_reports_ready_after_manual_update(self):
        doc = deployment("DaemonSet")
        doc["spec"]["updateStrategy"] = {"type": "OnDelete"}
        doc["status"] = {"observedGeneration": 3, "desiredNumberScheduled": 2,
                         "updatedNumberScheduled": 2, "numberReady": 2, "numberAvailable": 2}
        self.assertTrue(rollout_state(doc)[0])
        doc["status"]["updatedNumberScheduled"] = 1
        self.assertFalse(rollout_state(doc)[0])

    def test_statefulset_ondelete_reports_ready_after_manual_update(self):
        doc = deployment("StatefulSet")
        doc["spec"]["updateStrategy"] = {"type": "OnDelete"}
        doc["status"].update({"currentRevision": "rev3", "updateRevision": "rev3"})
        self.assertTrue(rollout_state(doc)[0])

    def test_statefulset_partition_and_ondelete(self):
        doc = deployment("StatefulSet")
        doc["spec"].update({"replicas": 3, "updateStrategy": {"type": "RollingUpdate", "rollingUpdate": {"partition": 2}}})
        doc["status"].update({"readyReplicas": 3, "updatedReplicas": 1})
        self.assertTrue(rollout_state(doc)[0])
        doc["spec"]["updateStrategy"]["type"] = "OnDelete"
        self.assertFalse(rollout_state(doc)[0])

    def test_wait_timeout_does_not_resubmit(self):
        client = FakeClient()
        client.objects[PATH]["status"]["updatedReplicas"] = 0
        with self.assertRaises(K8sError):
            wait_rollout(client, PATH, timeout=0)
        self.assertEqual([c["method"] for c in client.calls], ["GET"])

    def test_history_filters_by_owner_uid_not_labels(self):
        client = FakeClient()
        for name, uid in (("owned", "uid-1"), ("foreign", "other")):
            obj = deployment("ReplicaSet")
            obj["metadata"].update({"name": name, "ownerReferences": [{"uid": uid, "controller": True}]})
            client.objects[f"/apis/apps/v1/namespaces/dev/replicasets/{name}"] = obj
        history = deployment_history(client, deployment(), "dev")
        self.assertEqual([x["metadata"]["name"] for x in history], ["owned"])

    def test_rollback_restores_full_template_and_removes_hash(self):
        old = deployment("ReplicaSet")
        old["metadata"]["annotations"]["deployment.kubernetes.io/revision"] = "2"
        old["spec"]["template"]["metadata"]["labels"]["pod-template-hash"] = "old-hash"
        old["spec"]["template"]["spec"]["containers"][0]["image"] = "jdk:old"
        ops = rollback_operations(deployment(), [old], 2)
        self.assertEqual(ops[0]["path"], "/spec/template")
        self.assertNotIn("pod-template-hash", ops[0]["value"]["metadata"]["labels"])
        self.assertEqual(ops[0]["value"]["spec"]["containers"][0]["image"], "jdk:old")
        self.assertIn("pod-template-hash", old["spec"]["template"]["metadata"]["labels"])


class ManifestTest(unittest.TestCase):
    def manifest(self, name="settings", namespace="dev"):
        return {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": name, "namespace": namespace}, "data": {"key": "secret-value"}}

    def test_namespace_mismatch_rejected_before_write(self):
        client = FakeClient()
        with self.assertRaises(K8sError):
            apply_documents(client, [self.manifest(namespace="prod")], "dev", execute=True)
        self.assertEqual(client.calls, [])

    def test_apply_is_server_side_and_conflicts_not_forced(self):
        client = FakeClient()
        obj = self.manifest()
        obj["metadata"].update({"resourceVersion": "7", "uid": "cm-7"})
        client.objects["/api/v1/namespaces/dev/configmaps/settings"] = obj
        result = apply_documents(client, [self.manifest()], "dev")
        request = client.calls[-1]
        self.assertEqual(request["content_type"], "application/apply-patch+yaml")
        self.assertEqual(request["params"], {"fieldManager": "bsq-k8s", "dryRun": "All"})
        self.assertFalse(result[0]["persisted"])

    def test_apply_absent_resource_uses_atomic_create(self):
        client = FakeClient()
        apply_documents(client, [self.manifest()], "dev", execute=True)
        writes = [c for c in client.calls if c["method"] != "GET"]
        self.assertEqual([c["method"] for c in writes], ["POST", "POST"])
        self.assertEqual([c["params"].get("dryRun") for c in writes], ["All", None])

    def test_existing_apply_includes_resourceversion_and_uid(self):
        client = FakeClient()
        obj = self.manifest()
        obj["metadata"].update({"resourceVersion": "15", "uid": "cm-15"})
        client.objects["/api/v1/namespaces/dev/configmaps/settings"] = obj
        apply_documents(client, [self.manifest()], "dev")
        self.assertEqual(client.calls[-1]["body"]["metadata"]["resourceVersion"], "15")
        self.assertEqual(client.calls[-1]["body"]["metadata"]["uid"], "cm-15")

    def test_all_manifests_preflight_before_execution(self):
        client = FakeClient()
        apply_documents(client, [self.manifest("one"), self.manifest("two")], "dev", execute=True, operation="create")
        writes = [c for c in client.calls if c["method"] != "GET"]
        self.assertEqual([c["params"].get("dryRun") for c in writes], ["All", "All", None, None])

    def test_duplicate_manifests_rejected(self):
        with self.assertRaises(K8sError):
            apply_documents(FakeClient(), [self.manifest(), self.manifest()], "dev", execute=True)

    def test_replace_uses_current_resourceversion(self):
        client = FakeClient()
        path = "/api/v1/namespaces/dev/configmaps/settings"
        obj = self.manifest()
        obj["metadata"].update({"uid": "cm-1", "resourceVersion": "15"})
        client.objects[path] = obj
        apply_documents(client, [self.manifest()], "dev", operation="replace")
        self.assertEqual(client.calls[-1]["body"]["metadata"]["resourceVersion"], "15")


class PrivacyTest(unittest.TestCase):
    def test_redaction_for_secret_list_without_item_kind(self):
        doc = {"kind": "SecretList", "items": [{"metadata": {"name": "s"}, "data": {"x": "VERY-PRIVATE"}}]}
        self.assertNotIn("VERY-PRIVATE", json.dumps(redact(doc)))
        self.assertEqual(doc["items"][0]["data"]["x"], "VERY-PRIVATE")

    def test_redaction_for_configmaps_env_args_and_annotations(self):
        values = [{"kind": "ConfigMap", "data": {"app.yaml": "PRIVATE1"}},
                  {"env": [{"name": "CUSTOM_KEY", "value": "PRIVATE2"}], "args": ["PRIVATE3"], "annotations": {"x": "PRIVATE4"}},
                  {"clientToken": "PRIVATE5"}]
        for value in values:
            self.assertNotIn("PRIVATE", json.dumps(redact(value)))

    def test_atomic_private_config_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "private" / "config.json"
            private_json(path, {"value": "private"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(read_private(path), {"value": "private"})
            path.chmod(0o644)
            with self.assertRaises(K8sError):
                read_private(path)

    def test_config_add_is_incremental_and_does_not_print_password(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            private_json(path, {"default_profile": "keep", "profiles": {"keep": {"url": "http://keep", "password": "keep-secret"}}})
            output, error = io.StringIO(), io.StringIO()
            with patch("sys.stdin", io.StringIO("NEW-SECRET\n")), contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                code = main(["--config", str(path), "config", "add", "new", "--url", "http://new", "--username", "u", "--password-stdin"])
            self.assertEqual(code, 0)
            data = read_private(path)
            self.assertEqual(data["profiles"]["keep"]["password"], "keep-secret")
            self.assertEqual(data["default_profile"], "keep")
            self.assertEqual(data["profiles"]["new"]["password"], "NEW-SECRET")
            self.assertNotIn("SECRET", output.getvalue() + error.getvalue())


if __name__ == "__main__":
    unittest.main()
