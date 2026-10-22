# bs-k8s-cli

通过 HTTP API 管理 KubeSphere / Kubernetes，命令为 `bsq-k8s`。不使用浏览器，不依赖 kubectl。

Python 3.10+；依赖 requests、PyYAML。已针对 KubeSphere 3.x Console 的 `/login` + Cookie 代理协议实现认证；也支持原生 Kubernetes Bearer Token。其他 KubeSphere 版本需先核对协议。Kubernetes API 版本与 CRD 通过服务端资源发现确定。

## 安装

```bash
cd /path/to/bs-project-tools/bs-k8s-cli
pipx install -e .
bsq-k8s --help
```

无需全局安装也可在工具目录运行 `python3 -m bs_k8s.cli`，前提是当前 Python 已安装依赖。

## 连接配置

默认配置 `~/.config/bsq-k8s/config.json`；可用 `BS_K8S_CONFIG` 或 `--config` 切换。配置与会话缓存要求 `0600`。真实凭据不写入源码仓库。

```bash
# 无回显录入密码，保存在用户目录私有配置；不把密码写进命令参数。
bsq-k8s config add dev --url http://kubesphere.example.internal:30880 \
  --mode kubesphere --username your-user --default

# 或仅保存环境变量名，密码由调用环境提供。
bsq-k8s config add test --url http://kubesphere-test.example.internal:30880 \
  --username your-user --password-env BS_K8S_TEST_PASSWORD

# 原生 API Server：Token 可来自环境变量或 --token-stdin。
bsq-k8s config add native --url https://kubernetes.example.internal:6443 \
  --mode kubernetes --token-env BS_K8S_NATIVE_TOKEN --ca-file /path/to/ca.crt

bsq-k8s config list
bsq-k8s config use dev
bsq-k8s -p dev login
bsq-k8s -p dev version
```

`config add` 按别名增量合并，不删除其他连接。同名连接不重新录入凭据时保留原值。`config remove NAME` 删除指定连接；不会自动改选其他默认连接。`--password-stdin` / `--token-stdin` 便于安全管道输入，不提供明文 `--password` / `--token` 参数。

连接可配置 `namespace` 作为默认空间，未设置时必须显式 `-n`；`-A` 只用于查询。可配置 `api_prefix` 对接已核对的 API 代理前缀，不自动猜测成员集群路径。TLS 始终校验证书，自签证书使用 `ca_file`。KubeSphere 会话缓存在配置旁的 `sessions/`，有效期内复用，不缓存刷新 Token；401 后先 `login --refresh`，再查询操作实际状态。

## 查询与诊断

全局参数可放子命令前后。默认输出脱敏 JSON，`-o yaml` / `-o table` 切换。表格只显示基础资源元数据，复杂结果建议 JSON。Secret/ConfigMap 正文、内联环境变量、命令参数与注解默认隐藏；`--show-sensitive` 可显式查看，避免把结果写入会话或公共日志。日志是原始业务文本，不自动脱敏。

```bash
bsq-k8s api-resources
bsq-k8s get namespaces -o table
bsq-k8s get deployments -A -o table
bsq-k8s -n team get pods -l app=my-service
bsq-k8s -n team get pods --field-selector status.phase=Pending
bsq-k8s -n team get deploy my-service -o yaml
bsq-k8s -n team describe deployment/my-service
bsq-k8s -n team events --for pod/my-pod
bsq-k8s -n team images deployment/my-service
bsq-k8s -n team images pod/my-pod
bsq-k8s -n team logs my-pod -c main --tail 100 --since 600 --timestamps
bsq-k8s -n team logs my-pod -c main --previous
bsq-k8s -n team logs my-pod -c main --follow --timeout 60
bsq-k8s -n team top pods
bsq-k8s top nodes
bsq-k8s -n team can-i patch deployments --name my-service
bsq-k8s -p native api-get /readyz
```

`get` 支持服务端资源发现出的所有普通资源：Pod、Deployment、StatefulSet、DaemonSet、ReplicaSet、Job、CronJob、Service、Ingress、Endpoints、ConfigMap、Secret、ServiceAccount、Role/Binding、PV/PVC、StorageClass、Node、Namespace、NetworkPolicy、HPA、CRD 和自定义资源。资源名称有歧义时指定 `--api-version group/version`，或使用完整资源组名称。内置 `deploy/sts/ds/po/svc/ns/cm/rs/no/cj/sa` 等别名，其他短名来自服务端。

`top` 依赖 metrics-server，保持 Kubernetes 原始 CPU/内存量纲。`can-i` 为 SelfSubjectAccessReview；KubeSphere 代理可能以服务账号访问 Kubernetes，所以此结果不等于当前用户的完整平台权限，实际 dry-run 更直接。`api-get` 仅允许当前连接下的读取，拒绝外部 URL、proxy 和远程执行子资源；原生健康检查端点可返回纯文本。KubeSphere Console 可能未代理 `/readyz`、`/healthz`、`/livez`（本次目标实测 `/readyz` 返回 HTML），此时应使用原生 API 连接，不能把网页响应当作集群健康结果。

## 变更：默认服务端预演

所有资源写命令默认带 `dryRun=All`；显式 `--execute` 时先预演，再发送实际变更。没有 `--execute` 不持久化资源。登录和权限检查不是资源变更，不受此开关影响。API 预演不检查镜像仓库是否已有目标 tag，也不证明容器能启动。[Kubernetes API 预演说明](https://kubernetes.io/docs/reference/using-api/api-concepts/#dry-run)。

以下示例均只预演；已有用户授权、核对目标后，在同一命令后追加 `--execute` 生效。

```bash
bsq-k8s -n team restart deploy/my-service
bsq-k8s -n team scale deploy/my-service --replicas 2
bsq-k8s -n team pause deploy/my-service
bsq-k8s -n team resume deploy/my-service

# 精确更新普通或初始化容器的 tag，保留仓库路径与端口。
bsq-k8s -n team image deploy/my-service --container business-init --tag artifact-1.2.3

# 一次更新多个模块，包含 digest 镜像或仓库迁移。
bsq-k8s -n team image deploy/my-service \
  --set business-init=registry:7005/team/business:artifact-1.2.3 \
  --set runtime=registry:7005/team/jdk:17

bsq-k8s -n team label deploy/my-service owner=finance old-label-
bsq-k8s -n team annotate deploy/my-service release.example/version=1.2.3
bsq-k8s -n team env deploy/my-service --container main -f env.yaml
bsq-k8s -n team suspend nightly-sync --value true
bsq-k8s -n team run-job nightly-sync --name nightly-sync-manual-20261022
bsq-k8s cordon worker-1
bsq-k8s uncordon worker-1
bsq-k8s taint worker-1 maintenance=true:NoSchedule
bsq-k8s taint worker-1 maintenance:NoSchedule-
```

Java 聚合服务常用 `initContainers[*].image` 存放业务制品，主容器只运行通用 JDK。先 `images` 核对模块与容器映射，不要把 JDK tag 当业务版本。聚合部署中更新一个模块会重新创建整个 Pod 并运行所有初始化容器；同一 Pod 内其他模块也会经历重启。相同 SNAPSHOT tag 的重新拉取取决于每个容器的 `imagePullPolicy`；重启并不保证获取被覆盖的新镜像。

`env.yaml` 支持标量、Kubernetes `valueFrom` 和 `null` 删除；其他已有变量保持不变，值不放命令行：

```yaml
APP_MODE: test
REMOVE_ME: null
DATABASE_PASSWORD:
  valueFrom:
    secretKeyRef:
      name: database
      key: password
```

写操作带 UID/resourceVersion 前置条件；冲突、权限错误、网络失败不自动重试，先查实际状态。节点污点 `NoExecute` 可能驱逐 Pod；`cordon` 只禁调度，不驱逐。暂停 Deployment、缩容到 0、删除存储/命名空间等仍须有相应用户授权，`--execute` 是技术开关，不是授权替代。

## 发布状态与回滚

```bash
bsq-k8s -n team rollout status deploy/my-service
bsq-k8s -n team rollout status deploy/my-service --wait --wait-timeout 300
bsq-k8s -n team rollout history deploy/my-service
bsq-k8s -n team rollout undo deploy/my-service --revision 12
```

`status` 支持 Deployment、StatefulSet、DaemonSet：核对 observedGeneration、新副本和就绪状态；Deployment 还检查旧副本退出。未完成/失败/超时返回非零。StatefulSet partition 按策略判断；OnDelete 不自动删 Pod。等待结束只代表 Kubernetes 发布状态，业务接口仍需单独验证。等待时多次 GET，不重复提交变更。

`history/undo` 目前只支持 Deployment，按 ReplicaSet owner UID 过滤，必须明确 revision。回滚恢复历史完整 Pod 模板，包括普通/初始化镜像、环境变量和挂载，不只是镜像 tag；不会恢复外部 ConfigMap/Secret 内容，也不修改副本数。被清理的历史不能回滚。恢复后会形成新的 Deployment revision。

## 通用资源管理

```bash
# YAML/JSON，支持多文档及 kind: List；文件中的 namespace 必须与 -n 一致。
bsq-k8s -n team apply -f resources.yaml
bsq-k8s -n team create -f resources.yaml
bsq-k8s -n team replace -f resource.yaml
bsq-k8s -n team patch deploy/my-service --type merge -f patch.json
bsq-k8s -n team patch deploy/my-service --type json -f patch-array.json
bsq-k8s -n team delete job/finished-job
```

`apply` 更新已有资源时使用 Server-Side Apply，fieldManager 为 `bsq-k8s`，不强制抢占字段；缺失资源用原子 POST 创建，避免预演后被别人抢先创建时覆盖新对象。[SSA 文档](https://kubernetes.io/docs/reference/using-api/server-side-apply/)。`replace` 是完整替换，使用当前 UID/resourceVersion；优先用小范围 `patch` 或专用命令。JSON Patch 会在用户操作前追加 UID/resourceVersion 检查。删除只允许精确名称，支持 `--cascade Foreground|Background|Orphan` 和 `--grace-period`，不提供批量删除或强删开关。

批量清单先全部预演再依次执行，但跨资源没有事务；有的清单依赖同批新建的 Namespace/CRD 时需按依赖拆批。出现失败会报告已执行项数和失败位置，不自动补偿。不要将默认脱敏的 `get` 输出当作可直接恢复的备份。

## 范围与验证

本工具覆盖 REST 资源操作，尚不包含交互 exec、attach、cp、port-forward、节点 drain/eviction 或 kubeconfig 客户端证书/exec 插件认证。需要这些能力时使用独立维护的 kubectl，并先解决相应的连接认证；不回退到浏览器，也不把远程命令执行伪装成只读 HTTP。

```bash
python3 -m unittest discover -s tests -v
```

自动测试使用本地模拟 HTTP 与内存资源，不访问真实集群。线上验证应分为：认证/读取、服务端 dry-run、实际发布、Pod 就绪、业务接口；不能把预演或 PATCH 成功称为发版完成。
