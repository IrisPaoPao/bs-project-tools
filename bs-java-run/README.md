# bs-java-run

BS Java 服务运行管理 CLI。它读取已托管服务的 Maven 路径、端口、依赖、运行环境和账号配置，负责构建、启动、停止、重启、状态诊断、登录取 Token，以及聚合工作区的初始化和维护。

## 安装与入口

```bash
cd /Users/zhangzhengqing/work/project/tools_and_skills/bs-project-tools/bs-java-run
npm install
npm link
bs-java-run --version
```

不安装全局命令时，可以直接调用：

```bash
node /Users/zhangzhengqing/work/project/tools_and_skills/bs-project-tools/bs-java-run/bin/bs-java-run.js --help
```

旧的 build_services.sh、start_services.sh、stop_services.sh、restart_services.sh、status_services.sh 和 login.sh 仍是兼容包装，内部转发到 CLI。新流程应使用 bs-java-run；不要绕过配置直接拼接 Java 启动命令。

## 两种配置模式

### 聚合工作区模式

使用 --workspace <directory> 或 BS_JAVARUN_WORKSPACE 时，配置目录只能是目标目录下的 .bs-java-run：

- .bs-java-run/JAVARUN.md：工作区托管的共享服务配置。
- .bs-java-run/JAVARUN.local.md：本机 Java 路径、账号密码和私有覆盖。
- .bs-java-run/workspace-manifest.json：扫描清单和托管配置指纹。
- .bs-java-run/logs/、PID 文件和 .bs-java-run/history/：默认运行现场。

工作区配置缺失、损坏或未初始化时，命令会失败并提示修复；不会回退到工具目录的 JAVARUN.md 或 JAVARUN.local.md。目标根目录生成的 javarun 是指向生成时 CLI 路径的轻量转发脚本，路径失效时用可用的 bs-java-run 重新执行 workspace init 或 workspace update。

初始化和维护：

```bash
bs-java-run workspace init /path/to/aggregate
cd /path/to/aggregate

./javarun doctor
./javarun status
./javarun up <service> --env <env> --yes
./javarun smoke <service> --env <env> --build
./javarun update
./javarun update --configure
./javarun update --configure --replace-all
```

init 会扫描聚合目录下直接的 Maven server 项目，交互录入运行环境、Nacos、登录接口和可用用户，密码无回显。doctor 只做校验，不构建、不启动、不修改文件；缺少 WAR 等构建产物只告警。smoke 会真实启动并等待就绪，默认只回收本次启动的实例，明确指定 --keep-running 才保留服务。

workspace update 重新扫描并更新受托管配置；update --configure 先备份共享和私有配置，再展示脱敏差异并原子写入。默认按名称合并，未录入的环境和账户保留；--replace-all 才会删除遗漏项，并要求交互式二次确认。私有配置和历史、日志、PID 会写入工作区忽略规则，不能把密码、Token 或本机绝对路径提交到业务仓库。

### 普通工具模式

未指定工作区时，CLI 读取工具目录中的 JAVARUN.md 和可选的 JAVARUN.local.md。共享文件描述服务和语法，私有文件描述本机 Java、WAR 路径、端口、依赖、运行环境、账号以及环境化 JVM 参数。缺少私有文件、服务、端口或环境时停止并提示补齐，不能凭经验猜端口、Nacos、账号或 Java 路径。

工作区和普通模式都支持全局参数：

```bash
bs-java-run --workspace /path/to/aggregate status
bs-java-run --env dev start <service> --yes
bs-java-run --profile dev status
```

--env 和兼容参数 --profile 同时出现且值不同会失败。运行环境由配置表选择，Nacos host/namespace、登录地址和上下文随所选环境生效；命令行的 --nacos-host、--nacos-ns 只用于 start、up、restart 的显式覆盖。

## 命令速查

```text
bs-java-run build [service] [--yes]
bs-java-run start [service] --env <env> [--yes] [--build]
bs-java-run up [service] --env <env> [--yes]
bs-java-run stop [service] [--yes] [--cascade] [--force]
bs-java-run restart [service] --env <env> [--yes] [--build] [--cascade]
bs-java-run status [service] [--json]
bs-java-run login [--env <env>] [--account <account>] [--headless]
bs-java-run token [--env <env>] [--account <account>] [--quiet]
bs-java-run history [filters]
printf '<feedback-json>\n' | bs-java-run feedback <run-id>
```

省略服务名时，build/start/up/stop/restart 进入选择流程；脚本和 CI 使用 --yes。start、up、restart 必须通过 --env、--profile 或 BS_ENV 指定运行环境；没有环境时在操作前失败。

### 构建

```bash
bs-java-run build --yes
bs-java-run build saas-data-gateway --yes
```

构建调用 Maven mvn -q -DskipTests clean package。start 默认只启动已有 WAR；只有 start --build 或 restart --build 才先构建，up 总是先构建再启动。构建成功只表示 Maven 产物生成成功，不表示服务已启动或接口可用。

如果失败属于依赖解析、制品或版本坐标不存在、仓库不可达或缺少内部/第三方依赖，工具会输出缺失坐标、仓库线索、失败命令和日志位置后停止当前任务。不要修改 pom.xml、替换 jar、临时改版本或反复盲目重试；先按错误坐标和仓库访问情况人工排查。普通 Java 编译失败仍按构建失败处理。

### 启动、up 与依赖复用

```bash
bs-java-run start saas-data-gateway --env dev --yes
bs-java-run start --env dev --yes --build
bs-java-run up saas-data-gateway --env dev --yes
bs-java-run start saas-data-gateway --env dev --yes --dry-run --json
bs-java-run up saas-data-gateway --env dev --yes --reuse-dependencies
```

up 会按拓扑顺序补齐传递依赖，等待每个服务就绪。--reuse-dependencies 只允许复用自动补齐的依赖，不会复用用户明确选择的目标服务。复用必须同时满足：本工具 PID/实例 UUID 归属、PID 存活、端口由该 PID 监听、实例环境已知、ready 标记成立、启动指纹一致。指纹由服务 realpath、端口、环境、Nacos host/namespace 和 JVM 参数键值计算；输出摘要只显示路径、端口、环境、Nacos 标识和 JVM 参数键名，不显示敏感值。目标服务端口被占用时仍失败，不能用 reuse 绕过。

start/up/restart 的 ready 不是“端口刚监听”。本次启动日志必须出现 Started ... in ... seconds，当前 PID 必须存活并拥有端口，并通过 5 秒稳定观察窗口。旧日志中的 Started 行、孤立 PID 或仅能连通端口都不能证明本次实例就绪。

### dry-run 和 JSON

dry-run 只解析配置、依赖和端口，输出计划，不构建、不启动、不停止、不杀进程：

- start/up：command、dryRun、environment、build、reuseDependencies，以及服务的 name、port、role、portOccupied、action、fingerprint、fingerprintSummary。
- restart：上述环境和构建信息，以及 services、stopOrder、startOrder。
- stop：service、cascade、force、blockedBy、services 和 stopOrder。

```bash
bs-java-run start <service> --env <env> --dry-run --json
bs-java-run restart <service> --env <env> --dry-run --json
bs-java-run stop <service> --dry-run --json
```

服务 action 会是 start、reuse 或 blocked-port。实际执行时给 start/up/stop/restart 加 --json，stdout 只输出一个结果对象 command、dryRun、code、outcome；内部日志被收集，便于脚本只解析 JSON。

### 停止与重启

```bash
bs-java-run stop <service> --yes
bs-java-run stop <service> --cascade --yes
bs-java-run stop <service> --force --yes
bs-java-run restart <service> --env <env> --yes
bs-java-run restart <service> --env <env> --yes --build --cascade
```

stop 默认只停止可证明属于本工具的实例；PID 文件、实例 UUID 或端口归属不匹配时拒绝清理。--force 才允许处理非本工具 PID 或残留端口，使用前应确认 PID 和端口。--cascade 才会把正在运行的反向依赖加入停止范围。restart 会先冻结目标范围，再按全逆序停止、全正序启动；--build 只影响启动前构建，--force 只透传停止阶段。

### 状态和状态 JSON

```bash
bs-java-run status
bs-java-run status saas-data-gateway
bs-java-run status --json
```

普通输出用于人工查看 PID、端口和日志路径。status --json 输出 command、environment，以及每个服务的 service、port、pid、pidState、portState、portPids、log、running、readiness、environment、pidEnvironment、expectedEnvironment、environmentStatus、fingerprint、fingerprintMatch。

running、pidState 和 portState 只描述进程和端口证据；readiness 还要求当前实例的 ready 标记。environmentStatus 会区分 known、mismatch、unknown 和 stopped；fingerprintMatch 用于发现配置或 JVM 指纹漂移。status 不会替代真实业务请求验证。

### 登录和 Token

```bash
bs-java-run login --env dev --account <account> --headless
bs-java-run token --env dev --account <account> --quiet
```

login/token 从当前配置模式读取账号。token 每次重新登录，不缓存 Token；--quiet 成功时 stdout 只有 Token，失败诊断写 stderr。将 Token 放进请求的 Authorization 头时不要额外添加 Bearer，除非目标接口明确要求。默认只记住最近使用的账户名，不打印或写入密码、Cookie 或 Token。需要落盘时必须显式指定 login --save-token <file>，并确保文件权限和位置合适。

真实接口验证示例：

```bash
TOKEN="$(bs-java-run token --env <env> --account <account> --quiet)"
curl -H "Authorization: $TOKEN" \
  -H "Function-Page-Id: <pageId>" \
  "http://localhost:<port>/<context-path>/api/..."
```

上下文路径、页面标识和业务参数从服务配置或浏览器 Network 请求确认，不按服务名猜测。构建、端口监听、status ready 和 curl 通畅分别记录，不能把其中一项称为完整端到端验证。

## 历史记录与反馈

有工作区时，runtime 命令会把记录写入 <workspace>/.bs-java-run/history/；普通工具模式没有持久化工作区时只保留当前进程内记录，后续 CLI 无法查询。build、start、up、stop、restart、login、token、workspace init/update/smoke 会创建 run；status、doctor、history、feedback 不会创建新 run。记录包含阶段、结果、环境、服务和诊断摘要，不包含原始命令行、密码、Token、Cookie、实例 UUID 或完整 JVM 参数。

默认保留 30 天、总量上限 20 MiB、单记录上限 256 KiB；目录权限为 0700，记录文件为 0600。磁盘不可用时命令仍尽量完成服务操作，并在 history/feedback 结果中报告 storageWarning。

查询历史：

```bash
bs-java-run history
bs-java-run history --limit 50 --service saas-data-gateway
bs-java-run history --failed --json --workspace /path/to/aggregate
bs-java-run history --run-id <uuid>
```

默认 limit 为 20；支持 -n/--limit、--service、--failed、--run-id/--runId、--json 和 --workspace。普通模式逐行显示摘要，过滤或存储告警写 stderr；JSON 模式 stdout 是完整查询对象 records、truncated、queryError、storageWarning，便于脚本诊断。

feedback 只能从 stdin 读取固定 JSON，避免把故障信息或凭据放进进程列表：

```bash
printf '%s\n' '{"phenomenon":"服务启动后退出","steps":["查看 status","检查本次启动日志"],"verification":"确认端口和日志","confidence":"confirmed"}' \
  | bs-java-run feedback --run-id <uuid> --json --workspace /path/to/aggregate
```

输入只允许 phenomenon、steps、verification、confidence 四个字段；phenomenon/verification 每项最多 1000 字符，steps 为 1 到 20 项且每项最多 1000 字符，confidence 只能是 confirmed 或 suspected，整个 JSON 不超过 64 KiB。凭据样式文本会被脱敏。成功 JSON 包含 runId、saved、storageWarning；普通模式成功输出一行，错误写 stderr。

历史诊断顺序：先按 runId 查看失败阶段和 errorCategory，再保留并检查该 run 对应的日志和 status JSON，最后追加可复现现象、步骤和验证结果。历史记录是诊断线索，不替代当前日志、PID/端口检查或真实接口验证。

## JVM 与环境配置

JVM 参数按四层合并：所选环境参数组 < 环境服务专属参数 < JAVA_OPTS < CLI --java-opt。每个 JVM 参数组必须有明确环境名；不支持全局或 common 参数组。工具保留 server.port、loader.path、file.encoding、bs.javarun.instance 等关键参数，不要在配置或 --java-opt 中覆盖。

常用覆盖：

```bash
BS_ENV=dev bs-java-run start <service> --yes
BS_JAVA_HOME=/path/to/jdk bs-java-run start <service> --env dev --yes
LOG_DIR=/path/to/logs bs-java-run status
BS_STARTUP_TIMEOUT=600 bs-java-run start <service> --env dev --yes
```

LOG_DIR 可覆盖日志目录；未覆盖时普通模式使用配置默认日志目录，工作区默认使用 .bs-java-run/logs/。BS_JAVA_HOME 和私有配置中的 Java 根目录必须指向有效 JDK。启动等待默认 420 秒，可由 BS_STARTUP_TIMEOUT 或 --startup-timeout 覆盖；它是等待上限，不是业务健康检查。

## 故障排查

1. 先确认当前模式和配置来源：工作区检查 <root>/javarun、.bs-java-run/JAVARUN.md、.bs-java-run/JAVARUN.local.md；普通模式检查工具目录的两个 JAVARUN 文件。
2. 执行 status --json，同时查看 PID、端口归属、environmentStatus、fingerprintMatch 和日志路径；不要先杀未知进程。
3. 查看对应 run：history --failed --service <service> --json，必要时用 runId 查询并记录 feedback。
4. 对启动失败，检查本次启动日志中是否有 Started ... in ... seconds、Spring 上下文异常、Bean 定义冲突或缺失 Bean。工具会将常见冲突归类为 bean-conflict，将缺少 Bean/依赖归类为 bean-missing；分类只帮助定位，仍需结合完整日志。
5. 对 Maven 依赖解析失败，保留坐标、仓库、命令和日志，停止自动修复，交给人工处理。
6. 端口冲突时先查 status 和端口 PID；start 不会杀进程，stop 默认不处理非本工具进程，只有确认后使用 --force。

请把构建成功、进程/端口就绪、服务真实请求和业务结果分开报告。
