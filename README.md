# Pacvue Commerce Deploy Visual Extension

在 Cursor / VS Code 活动栏提供 **Pacvue Deploy** 面板，用于选择测试分支、workflow 与输入参数，触发 Pacvue Commerce 测试环境 GitHub Actions 发版，并轮询运行状态。

## 功能

- 读取当前工作区 Git 分支，下拉选择目标测试分支
- 扫描 `.github/workflows` 下支持 `workflow_dispatch` 的 workflow（默认匹配名称含「测试环境发版」）
- 根据 workflow inputs 动态生成表单
- 触发发版并展示命令与结果
- 约每分钟轮询 GitHub Actions 状态，支持取消进行中的 run

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
4. 选择 **Target branch**、**Workflow**，填写动态参数
5. 点击 **Run**；在 **Result** 区查看状态与 Run URL
6. 需要时点击 **Cancel**

## VSIX 安装

```bash
cd pacvue-commerce-deploy-extension
npx @vscode/vsce package --allow-missing-repository
```

Cursor / VS Code：**Extensions: Install from VSIX...** → 选择生成的 `pacvue-commerce-deploy-visual-*.vsix` → Reload Window。

## 设置项

| 设置 | 说明 |
|------|------|
| `pacvueDeploy.githubToken` | 无官方 `gh` 或 Windows 上 `gh` 不可靠时推荐；配置后轮询优先走 GitHub API |

也可使用环境变量 `GITHUB_TOKEN` / `GH_TOKEN`（需能被 Cursor 进程读取）。

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

## 本地开发

```bash
code pacvue-commerce-deploy-extension
# F5 启动 Extension Development Host，在调试窗口打开 commerce 仓库并打开 Pacvue Deploy 面板
```

## 说明

- Token 仅存于本机设置或环境变量，扩展不上传
- 可视化扩展与 Cursor Agent 的 deploy skill 共用同一套 `deploy-to-test.js` 能力，入口独立
