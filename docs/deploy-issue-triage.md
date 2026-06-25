# Deploy Issue Triage Automation

This repository can triage Pacvue Deploy auto-created issues and route them into two paths:

- `project_config_issue`: the commerce project's workflow/config is invalid or out of sync. The workflow labels the issue, comments with the diagnosis, and sends an email when recipients are configured.
- `plugin_parser_issue`: the commerce workflow appears valid, but the extension did not parse or recognize it. The workflow generates an agent prompt and can open a fix PR when an agent command is configured.

## GitHub Settings

Required for project config email:

- Secret `PACVUE_DEPLOY_TRIAGE_EMAIL_TO`: comma- or semicolon-separated recipient list.

Optional email variables:

- Variable `PACVUE_DEPLOY_EMAIL_ENDPOINT`: defaults to `https://api.pacvue.com/pacvue-email-service/SendMail`.
- Variable `PACVUE_DEPLOY_EMAIL_PRODUCT_LINE`: defaults to `devops`.
- Variable `PACVUE_DEPLOY_EMAIL_SETTING_NAME`: defaults to `DONOTREPLY`.

Optional parser fix automation:

- Variable `PACVUE_DEPLOY_PARSER_FIX_COMMAND`: shell command that applies a source fix from the generated prompt.

The parser command receives:

- `TRIAGE_RESULT`: path to `.triage/result.json`
- `TRIAGE_PROMPT`: path to `.triage/parser-fix-prompt.md`
- `TRIAGE_ISSUE_NUMBER`: issue number

The command may also use placeholders:

```text
your-agent-command --prompt {prompt} --triage {triage}
```

If the command produces a git diff, the workflow pushes a branch and opens a PR.

## Manual Re-run

Use the `Deploy Issue Triage` workflow and provide an issue number. This is useful after changing classifier rules or email recipients.
