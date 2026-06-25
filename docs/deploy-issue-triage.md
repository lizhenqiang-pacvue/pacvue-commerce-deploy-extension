# Deploy Issue Triage Automation

Pacvue Deploy 插件在发版触发失败或 GitHub Actions run 失败时，会自动在扩展仓库创建标题以 `[auto-triage]` 开头的 Issue。仓库内的 `Deploy Issue Triage` workflow 会继续读取 Issue 内容，判断应该走项目配置处理还是插件解析修复。

这些自动化文件只服务于扩展仓库维护，已通过 `.vscodeignore` 排除在 VSIX 包外，不会进入插件运行时。

## 触发方式

- Issue opened / edited / reopened：只有标题以 `[auto-triage]` 开头时才会执行。
- Manual run：在 GitHub Actions 页面手动运行 `Deploy Issue Triage`，填写 `issue_number`。

手动重跑适合以下场景：

- 更新了 triage 分类规则后，需要重新判断旧 Issue。
- 修改了邮件收件人或邮件服务配置后，需要补发项目配置通知。
- 配置了 parser fix agent 后，希望重新尝试自动生成修复 PR。

## 分类结果

| 分类 | Action | 典型原因 | 自动动作 |
|------|--------|----------|----------|
| `project_config_issue` | `send_project_config_email` | workflow 未同步到远端、choice 值不合法、缺少必填 input、`buildcmd` 不存在 | 打 `project-config` / `needs-project-owner` label，评论诊断；配置收件人后发送邮件 |
| `plugin_parser_issue` | `open_parser_fix_pr` | Issue 快照里的 workflow 看起来符合测试发版约定，但插件没有正确解析或识别 | 打 `parser` / `needs-extension-fix` label，生成 parser fix prompt；配置 agent 命令后创建修复 PR |
| `needs_manual_triage` | `comment_only` | 暂未匹配到已知项目配置或解析问题 | 打 `needs-manual-triage` label，评论基础诊断 |

## 当前识别规则

- GitHub 返回 `Provided value ... not in the list of allowed values`：归类为项目配置问题。若 Issue 快照里包含该选项，通常说明本地 `.github` 配置和 GitHub dispatch 使用的远端 ref 没同步。
- 找不到名称包含 `测试环境发版` 且支持 `workflow_dispatch` 的 workflow：如果快照文本看起来有效但解析失败，归类为插件解析问题；否则归类为项目配置问题。
- 报缺少 required workflow inputs：如果快照里这些 input 有 default 或 choice options，归类为插件解析问题；否则归类为项目配置问题。
- 构建脚本不存在，例如 `ERR_PNPM_NO_SCRIPT`、`Missing script`、`not found in package.json`：归类为项目配置问题。
- 其他情况：进入人工排查。

## GitHub Settings

配置位置：扩展仓库 `Settings` → `Secrets and variables` → `Actions`。

| 类型 | 名称 | 是否必需 | 说明 |
|------|------|----------|------|
| Secret | `PACVUE_DEPLOY_TRIAGE_EMAIL_TO` | 仅邮件必需 | 项目配置问题邮件收件人，支持英文逗号或分号分隔 |
| Variable | `PACVUE_DEPLOY_EMAIL_ENDPOINT` | 可选 | 邮件接口，默认 `https://api.pacvue.com/pacvue-email-service/SendMail` |
| Variable | `PACVUE_DEPLOY_EMAIL_PRODUCT_LINE` | 可选 | 邮件接口 product line，默认 `devops` |
| Variable | `PACVUE_DEPLOY_EMAIL_SETTING_NAME` | 可选 | 邮件接口 setting name，默认 `DONOTREPLY` |
| Variable | `PACVUE_DEPLOY_PARSER_FIX_COMMAND` | 可选 | 解析类问题的自动修复命令；未配置时只生成提示和评论，不会改代码 |

## Parser Fix Command

当分类结果是 `plugin_parser_issue` 时，workflow 会生成：

- `.triage/result.json`：结构化分类结果
- `.triage/parser-fix-prompt.md`：给 agent 的修复提示
- `.triage/pr-body.md`：自动 PR 描述

`PACVUE_DEPLOY_PARSER_FIX_COMMAND` 会收到这些环境变量：

- `TRIAGE_RESULT`：`.triage/result.json`
- `TRIAGE_PROMPT`：`.triage/parser-fix-prompt.md`
- `TRIAGE_ISSUE_NUMBER`：Issue 编号

命令也可以使用占位符：

```text
your-agent-command --prompt {prompt} --triage {triage}
```

其中 `{prompt}` 会替换为 `.triage/parser-fix-prompt.md`，`{triage}` 会替换为 `.triage/result.json`。如果命令执行后产生 git diff，workflow 会创建 `auto/deploy-issue-<issue>-<run>` 分支并打开 PR；如果没有 diff，会在 Issue 下评论说明未产生源码修改。

## 本地验证

可以把某个 Issue 导出成 JSON 后本地跑分类脚本：

```bash
gh issue view 1 \
  --repo lizhenqiang-pacvue/pacvue-commerce-deploy-extension \
  --json number,title,body,url,labels \
  > /tmp/pacvue-deploy-issue.json

node scripts/triage-deploy-issue.js \
  --issue-json /tmp/pacvue-deploy-issue.json \
  --out .triage
```

输出目录会包含：

- `result.json`：分类、证据、建议动作
- `issue-comment.md`：workflow 会评论到 Issue 的诊断内容
- `labels.txt`：workflow 会创建并添加的 labels
- `project-config-email.json`：仅项目配置问题生成
- `parser-fix-prompt.md` / `pr-body.md`：仅插件解析问题生成
