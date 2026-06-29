# Pacvue Commerce Deploy Visual Extension

在 Cursor / VS Code 活动栏提供 **Pacvue Deploy** 面板，用于选择测试分支、workflow 与输入参数，触发 Pacvue Commerce 测试环境 GitHub Actions 发版，并轮询运行状态。

## 最近更新（0.3.26）

- **面板 UI 精简**：移除右上角全局状态和主表单 Cancel，按钮改为自适应宽度，主操作区更紧凑。
- **Recent Deploys 按状态显示按钮**：进行中的记录隐藏 Clear 并显示 Cancel；已有结果的记录隐藏 Cancel 和 Clear。
- **只轮询最新发版**：旧的 Recent Deploys 记录不再查询状态；只有刚点击 Run 生成的最新记录会按间隔查询并更新进行中、成功、失败或取消状态。
- **加载稳定性修复**：打开面板时不再立即恢复历史轮询，避免启动阶段被 GitHub 状态查询拖住；初始化失败时会在 Result 区显示错误信息。
- **Recent Deploys 单条状态**：发版状态现在更新在 Recent Deploys 对应记录上，避免多条发版共用右上角单一状态导致显示不准确。
- **Recent Deploys 项目隔离**：Recent Deploys 现在按当前 Commerce 仓库单独保存，不再和其他项目共用历史记录。
- **发版确认**：点击 **Run** 后会先展示确认页，确认目标分支、workflow 与输入参数后再点击 **Confirm Deploy** 触发 GitHub Actions。
- **上次配置回填**：选择分支和 workflow 后，插件会读取同仓库、同 workflow、同分支的上次发版配置；来源会显示为 `Last config: from GitHub last run`、`from local cache`、`from GitHub last run + local cache` 或 `unavailable`。
- **Recent Deploys**：本机保存最近成功发版配置，可一键复用，也可清空历史。
- **Presets**：可把当前分支、workflow、输入参数保存为预设，后续一键套用或删除。
- **失败诊断卡片**：workflow run 失败后，Result 区会展示失败阶段、可能原因、失败 job / step、Run URL，并支持复制诊断信息。
- **自动 Issue + 自动分流**：触发失败或 run 失败会自动创建 `[auto-triage]` Issue；仓库内的 `Deploy Issue Triage` workflow 会继续判断是项目配置问题还是插件解析问题，详见 [Deploy Issue Triage Automation](docs/deploy-issue-triage.md)。

## 功能

- 读取当前工作区 Git 分支，下拉选择目标测试分支
- 扫描 `.github/workflows` 下支持 `workflow_dispatch` 的 workflow（默认匹配名称含「测试环境发版」）
- 根据 workflow inputs 动态生成表单
- 自动回填上次发版输入，并标识配置来源
- 支持保存预设、复用最近发版历史
- 点击 Run 后二次确认，避免误发错误分支或参数
- 触发发版并展示命令、状态、Run URL 与结果
- 约每分钟轮询 GitHub Actions 状态，支持取消进行中的 run
- 发版失败时在 Result 区展示诊断卡片，并自动在扩展仓库创建 GitHub Issue（含 run URL、失败 job 摘要、项目 `.github` 配置快照，供 Agent 排查）

## 环境要求

- Cursor / VS Code `^1.85.0`
- Node.js 16+
- 已 clone Pacvue Commerce 仓库（工作区根目录为仓库根）
- 部署脚本位于以下路径之一：
  - `pacvue-commerce-deploy-plugin/scripts/deploy-to-test.js`
  - 或扩展内置 `scripts/deploy-to-test.js`
- **GitHub 认证（二选一，无 gh 时用 Token 即可）**

| 方式 | 适用 | 配置 |
|------|------|------|
| **A. GitHub Token** | 未安装 GitHub CLI | `pacvueDeploy.githubToken` 或 `GITHUB_TOKEN` / `GH_TOKEN`（`repo` + `workflow`），**Reload Window** |
| **B. 官方 GitHub CLI** | 已安装 `gh` | `gh auth login` |

- 发版、轮询、取消在两种方式下均可用
- 同时配置时：有官方 `gh` 发版可走 CLI；轮询**优先 Token API**，API 失败且为 404 等可回退 `gh`
- 仅 Token 时：**不会**误用 PATH 上的 npm/Volta 假 `gh`

> **Windows**：Volta/npm 的 `gh` 不是官方 CLI。无官方 gh 时请用 **方式 A（Token）**。

## 面板使用步骤

1. 打开 Pacvue Commerce 仓库根目录
2. 活动栏 → **Pacvue Deploy**
3. 展开 **使用说明**（可选）查看简要指引
4. 选择 **Target branch**、**Workflow**，等待 `Last config` 状态完成加载
5. 按需要调整动态参数，或从 **Presets** / **Recent Deploys** 中复用配置
6. 点击 **Run**，在确认页核对参数后点击 **Confirm Deploy**
7. 在 **Result** 区查看状态与 Run URL；需要时点击 **Cancel**
8. 如果 run 失败，查看失败诊断卡片；插件会自动创建 `[auto-triage]` Issue（默认开启）

### 配置回填、历史与预设

- `Last config` 会优先读取 GitHub 上该分支、workflow 的最近运行信息；GitHub 无法返回完整 dispatch inputs 时，会合并插件本机缓存的上次成功发版输入。
- `Recent Deploys` 按当前 Commerce 仓库单独保存在本机 VS Code / Cursor global state 中，用于快速复用最近成功发版参数，不会和其他项目混用。
- `Presets` 也只保存在本机；适合保存常用项目、环境、buildcmd 组合。
- 历史和预设不会随 VSIX 上传，也不会写入 Commerce 仓库。

## 安装

### 从 GitHub Releases 安装（推荐）

1. 打开 [Releases](https://github.com/lizhenqiang-pacvue/pacvue-commerce-deploy-extension/releases) 页面
2. 下载最新版本的 `pacvue-commerce-deploy-visual-*.vsix`
3. Cursor / VS Code：**Extensions: Install from VSIX...** → 选择下载的 `.vsix` 文件
4. **Reload Window** 后，活动栏会出现 **Pacvue Deploy** 面板

### 本地打包（可选）

```bash
cd pacvue-commerce-deploy-extension
npx @vscode/vsce package --allow-missing-repository
```

Cursor / VS Code：**Extensions: Install from VSIX...** → 选择生成的 `pacvue-commerce-deploy-visual-*.vsix` → Reload Window。

## 设置项

| 设置 | 说明 |
|------|------|
| `pacvueDeploy.githubToken` | 无官方 `gh` 或 Windows 上 `gh` 不可靠时推荐；配置后轮询优先走 GitHub API |
| `pacvueDeploy.createIssueOnFailure` | 发版触发失败或 workflow run 失败时，自动在扩展仓库创建 Issue（默认 `true`） |
| `pacvueDeploy.issueRepo` | Issue 目标仓库，格式 `owner/repo`；留空则使用扩展 `package.json` 中的 repository |
| `pacvueDeploy.notifyOnDeploySuccess` | workflow run 成功时弹出 VS Code 通知（默认 `true`） |

也可使用环境变量 `GITHUB_TOKEN` / `GH_TOKEN`（需能被 Cursor 进程读取）。

### 自动 Issue（Agent 排查）

触发失败或 Actions run 失败（非 cancelled）时，扩展会在 [扩展仓库 Issues](https://github.com/lizhenqiang-pacvue/pacvue-commerce-deploy-extension/issues) 创建标题以 `[auto-triage]` 开头的 Issue，内容包括：

- Commerce 仓库、workflow、目标分支
- GitHub Actions Run URL
- 失败 job / step 摘要
- 当前 Commerce 项目 `.github` 目录下的 CI 配置原文（workflow 优先展示，便于 Agent 对照各项目不规范配置）
- 结构化 JSON payload（供后续 Agent 读取）

同一 `runId` 只会创建一次 Issue。Token / `gh` 需能在 **扩展仓库**（默认 `lizhenqiang-pacvue/pacvue-commerce-deploy-extension`）创建 Issue，仅有 Commerce 仓库权限不够。

> **注意**：只有扩展检测到 workflow run 最终状态为 **Failed** 时才会建 Issue。若轮询报错一直显示 `In Progress`，说明尚未拿到 run 结果，也不会建 Issue（请升级到最新版 VSIX 并配置 Token 轮询）。

### Issue 自动分流（仓库维护）

扩展仓库内提供 `Deploy Issue Triage` GitHub Actions workflow，用于处理 `[auto-triage]` Issue：

- `project_config_issue`：项目 workflow、choice、必填 input、buildcmd 等配置不符合约定，workflow 会打 label、评论诊断，并在配置收件人后发送邮件。
- `plugin_parser_issue`：项目配置看起来有效，但插件解析或识别失败，workflow 会生成修复提示；如果配置了自动修复命令，会创建修复分支和 PR。
- `needs_manual_triage`：暂未匹配到已知规则，只评论基础诊断并打人工排查 label。

配置方式和手动重跑说明见 [docs/deploy-issue-triage.md](docs/deploy-issue-triage.md)。

## 命令行验证（可选）

```bash
node pacvue-commerce-deploy-plugin/scripts/deploy-to-test.js --list-workflows-json

node pacvue-commerce-deploy-plugin/scripts/deploy-to-test.js \
  --branch "test/sprint/q2-bus-3" \
  --workflow ".github/workflows/commerce-newui-test.yml" \
  --input ProjectName=commerce-newui-html-dev \
  --input environment=us-test \
  --input buildcmd=buildcommerce \
  --skip-last-run-inputs \
  --dry-run
```

## 常见问题

### 找不到部署脚本

确认工作区或扩展目录中存在 `scripts/deploy-to-test.js`。

### workflow 列表为空

确认 `.github/workflows` 下有带 `workflow_dispatch` 的 yml，且名称匹配「测试环境发版」（或通过 workflow 下拉选择）。

### 轮询报错 / Failed to parse gh run list

- 多为 PATH 上的 npm `gh`（Volta）或 `gh` 未登录
- **处理**：配置 `pacvueDeploy.githubToken` 并 Reload，或安装官方 GitHub CLI

### Run 权限失败

```bash
gh auth status
```

或检查 PAT 是否具备目标仓库的 `repo`、`workflow` 权限。

### SAML SSO：`Resource protected by organization SAML enforcement`

表示 Token 已配置，但**未对 Pacvue 组织授权 SSO**（与分支、workflow 参数无关）。

1. 打开 [GitHub Token 设置](https://github.com/settings/tokens)
2. 找到正在使用的 PAT → **Configure SSO** / **Enable SSO**
3. 在 **Pacvue** 旁点击 **Authorize**，完成企业 SSO 登录
4. Cursor **Reload Window** 后重试

或安装官方 `gh` 并 `gh auth login`（登录流程会处理组织 SSO）。

### 参数不知如何填

以 workflow 文件中 `workflow_dispatch.inputs` 为准；扩展会尽量沿用该分支上次成功运行的输入作为默认值（可通过 `--skip-last-run-inputs` 跳过）。

### 插件里看不到新功能

确认已安装 `pacvue-commerce-deploy-visual-0.3.26.vsix` 或更新版本，并执行 **Developer: Reload Window**。如果仍看不到 **Presets**、**Recent Deploys**、确认页或失败诊断卡片，先卸载旧版扩展后重新从 VSIX 安装。

## 本地开发

```bash
code pacvue-commerce-deploy-extension
# F5 启动 Extension Development Host，在调试窗口打开 commerce 仓库并打开 Pacvue Deploy 面板
```

## 说明

- Token 仅存于本机设置或环境变量，扩展不上传
- 可视化扩展与 Cursor Agent 的 deploy skill 共用同一套 `deploy-to-test.js` 能力，入口独立
- `.github/workflows`、`docs` 与 triage scripts 是扩展仓库维护自动化，已通过 `.vscodeignore` 排除在 VSIX 包外，不属于插件运行时代码
