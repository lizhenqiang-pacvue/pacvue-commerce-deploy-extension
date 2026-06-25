#!/usr/bin/env node

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { parseWorkflowFile } = require("./deploy-to-test")

const TEST_DEPLOY_WORKFLOW_NAME = "测试环境发版"

function parseArgs(argv) {
  const args = {
    outDir: ".triage"
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--event") args.eventPath = argv[++index]
    else if (arg === "--issue-json") args.issueJsonPath = argv[++index]
    else if (arg === "--issue-body-file") args.issueBodyFile = argv[++index]
    else if (arg === "--issue-title") args.issueTitle = argv[++index]
    else if (arg === "--issue-number") args.issueNumber = Number(argv[++index])
    else if (arg === "--issue-url") args.issueUrl = argv[++index]
    else if (arg === "--out") args.outDir = argv[++index]
    else if (arg === "--help" || arg === "-h") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/triage-deploy-issue.js --event "$GITHUB_EVENT_PATH" --out .triage
  node scripts/triage-deploy-issue.js --issue-json issue.json --out .triage
`)
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function readIssue(args) {
  if (args.eventPath) {
    const event = readJsonFile(args.eventPath)
    if (!event.issue) throw new Error("GitHub event does not contain an issue payload.")
    return normalizeIssue(event.issue)
  }

  if (args.issueJsonPath) {
    return normalizeIssue(readJsonFile(args.issueJsonPath))
  }

  const body = args.issueBodyFile ? fs.readFileSync(args.issueBodyFile, "utf8") : ""
  return normalizeIssue({
    number: args.issueNumber,
    title: args.issueTitle || "",
    body,
    url: args.issueUrl || ""
  })
}

function normalizeIssue(issue) {
  return {
    number: issue.number ?? null,
    title: issue.title || "",
    body: issue.body || "",
    url: issue.url || issue.html_url || ""
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function extractHeadingSection(body, heading) {
  const marker = `## ${heading}`
  const start = body.indexOf(marker)
  if (start === -1) return ""

  const nextHeading = body.indexOf("\n## ", start + marker.length)
  return body.slice(start, nextHeading === -1 ? body.length : nextHeading)
}

function extractFencedBlock(section, language) {
  const langPart = language ? escapeRegExp(language) : "[A-Za-z0-9_-]*"
  const match = section.match(new RegExp("```" + langPart + "\\s*\\n([\\s\\S]*?)\\n```", "i"))
  return match?.[1] ?? ""
}

function extractPayload(body) {
  const section = extractHeadingSection(body, "Payload")
  const jsonText = extractFencedBlock(section, "json")
  if (!jsonText) return null

  try {
    return JSON.parse(jsonText)
  } catch (_error) {
    return null
  }
}

function extractErrorMessage(body, payload) {
  const payloadError = String(payload?.errorMessage || "").trim()
  if (payloadError) return payloadError

  const section = extractHeadingSection(body, "Error")
  return extractFencedBlock(section, "text").trim()
}

function extractProjectGithubFiles(body) {
  const section = extractHeadingSection(body, "Project `.github` configuration")
  if (!section) return []

  const files = []
  const regex = /### `([^`]+)`[\s\S]*?```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)\n```/g
  let match = regex.exec(section)
  while (match) {
    files.push({
      path: match[1],
      language: match[2] || "text",
      content: match[3]
    })
    match = regex.exec(section)
  }

  return files
}

function tokenizeCommand(command) {
  const tokens = []
  let current = ""
  let quote = null
  let escaped = false

  for (const char of String(command || "")) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === "\\") {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function parseCommandInputs(command) {
  const tokens = tokenizeCommand(command)
  const inputs = {}

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "--input") continue

    const pair = tokens[index + 1] || ""
    const separatorIndex = pair.indexOf("=")
    if (separatorIndex === -1) continue

    inputs[pair.slice(0, separatorIndex)] = pair.slice(separatorIndex + 1)
    index += 1
  }

  return inputs
}

function parseWorkflowSnapshot(file) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacvue-deploy-triage-"))
  const tempFile = path.join(tempDir, path.basename(file.path || "workflow.yml") || "workflow.yml")

  try {
    fs.writeFileSync(tempFile, file.content || "", "utf8")
    return parseWorkflowFile(tempFile)
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function workflowTextLooksLikeWorkflowDispatch(content) {
  return /^\s*workflow_dispatch\s*:/m.test(content || "")
}

function workflowTextLooksLikeTestDeploy(content) {
  const nameMatch = String(content || "").match(/^\s*name\s*:\s*(.+)$/m)
  return Boolean(nameMatch && nameMatch[1].includes(TEST_DEPLOY_WORKFLOW_NAME))
}

function findWorkflowFile(files, workflowPath) {
  const normalized = String(workflowPath || "").replace(/\\/g, "/")
  return (
    files.find((file) => file.path === normalized) ||
    files.find((file) => file.path.endsWith(`/${path.basename(normalized)}`)) ||
    files.find((file) => workflowTextLooksLikeTestDeploy(file.content) && workflowTextLooksLikeWorkflowDispatch(file.content)) ||
    null
  )
}

function snapshotContainsOption(workflowFile, parsedWorkflow, inputName, value) {
  const options = parsedWorkflow?.inputs?.[inputName]?.options || []
  if (options.includes(value)) return true

  const content = String(workflowFile?.content || "")
  const inputStart = content.search(new RegExp("^\\s*" + escapeRegExp(inputName) + "\\s*:", "m"))
  const inputBlock = inputStart === -1 ? content : content.slice(inputStart)
  return new RegExp("^\\s*-\\s*" + escapeRegExp(value) + "\\s*(?:#.*)?$", "m").test(inputBlock)
}

function classifyProvidedValueError({ issue, payload, errorMessage, workflowFile, parsedWorkflow }) {
  const match = errorMessage.match(/Provided value '([^']+)' for input '([^']+)' not in the list of allowed values/i)
  if (!match) return null

  const [, value, inputName] = match
  const snapshotHasValue = snapshotContainsOption(workflowFile, parsedWorkflow, inputName, value)
  const commandInputs = parseCommandInputs(payload?.command || "")
  const selectedValue = commandInputs[inputName] || value
  const reason = snapshotHasValue
    ? `GitHub rejected ${inputName}=${selectedValue}, although the issue snapshot contains that option. The workflow configuration used by GitHub for dispatch is not in sync with the local workspace or selected ref.`
    : `GitHub rejected ${inputName}=${selectedValue} because the selected workflow does not declare it as an allowed choice.`

  return buildResult({
    issue,
    payload,
    classification: "project_config_issue",
    action: "send_project_config_email",
    confidence: snapshotHasValue ? "high" : "high",
    reason,
    labels: ["auto-triage", "project-config", "needs-project-owner"],
    evidence: [
      `Rejected input: ${inputName}`,
      `Rejected value: ${selectedValue}`,
      snapshotHasValue ? "Issue snapshot contains the option, so the likely cause is unpushed or stale remote workflow config." : "Issue snapshot does not contain the option."
    ],
    projectAdvice: [
      "Push the workflow change to the branch/ref that Pacvue Deploy dispatches.",
      "If the workflow_dispatch input is type: choice, make sure the selected value exists in the remote workflow file used by GitHub Actions.",
      "Reload the plugin after the remote workflow config is updated."
    ]
  })
}

function classifyMissingWorkflow({ issue, payload, errorMessage, workflowFile, parsedWorkflow }) {
  if (!/No workflow with name containing|No Pacvue test deploy workflow|Workflow ".+?" was not found/i.test(errorMessage)) {
    return null
  }

  const textLooksValid = workflowFile && workflowTextLooksLikeTestDeploy(workflowFile.content) && workflowTextLooksLikeWorkflowDispatch(workflowFile.content)
  const parserLooksValid =
    parsedWorkflow &&
    !parsedWorkflow.parseError &&
    parsedWorkflow.hasWorkflowDispatch &&
    String(parsedWorkflow.name || "").includes(TEST_DEPLOY_WORKFLOW_NAME)

  if (textLooksValid && !parserLooksValid) {
    return buildResult({
      issue,
      payload,
      classification: "plugin_parser_issue",
      action: "open_parser_fix_pr",
      confidence: "medium",
      reason: "The issue snapshot appears to contain a valid Pacvue test deploy workflow, but the extension did not recognize it.",
      labels: ["auto-triage", "parser", "needs-extension-fix"],
      evidence: [
        `Workflow file: ${workflowFile.path}`,
        parsedWorkflow?.parseError ? `Parser error: ${parsedWorkflow.parseError}` : "Parser did not produce expected workflow metadata."
      ]
    })
  }

  return buildResult({
    issue,
    payload,
    classification: "project_config_issue",
    action: "send_project_config_email",
    confidence: "medium",
    reason: "No workflow matching the Pacvue test deploy convention was found in the project configuration.",
    labels: ["auto-triage", "project-config", "needs-project-owner"],
    evidence: workflowFile ? [`Workflow file inspected: ${workflowFile.path}`] : ["No matching workflow file was included in the issue snapshot."],
    projectAdvice: [
      `Add or rename a workflow so its name contains "${TEST_DEPLOY_WORKFLOW_NAME}".`,
      "Ensure the workflow uses workflow_dispatch.",
      "Ensure required dispatch inputs have defaults or selectable options."
    ]
  })
}

function classifyMissingInputs({ issue, payload, errorMessage, workflowFile, parsedWorkflow }) {
  const match = errorMessage.match(/Required workflow inputs are missing:\s*(.+)/i)
  if (!match) return null

  const missingInputs = match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const allResolvable =
    parsedWorkflow &&
    !parsedWorkflow.parseError &&
    missingInputs.length > 0 &&
    missingInputs.every((name) => {
      const input = parsedWorkflow.inputs?.[name]
      return input && (Object.prototype.hasOwnProperty.call(input, "default") || input.options?.length)
    })

  if (allResolvable) {
    return buildResult({
      issue,
      payload,
      classification: "plugin_parser_issue",
      action: "open_parser_fix_pr",
      confidence: "medium",
      reason: "The extension reported missing required inputs, but the workflow snapshot provides defaults or options for them.",
      labels: ["auto-triage", "parser", "needs-extension-fix"],
      evidence: missingInputs.map((name) => `Resolvable input reported missing: ${name}`)
    })
  }

  return buildResult({
    issue,
    payload,
    classification: "project_config_issue",
    action: "send_project_config_email",
    confidence: "medium",
    reason: "The workflow has required inputs that Pacvue Deploy could not resolve automatically.",
    labels: ["auto-triage", "project-config", "needs-project-owner"],
    evidence: missingInputs.map((name) => `Missing required input: ${name}`),
    projectAdvice: [
      "Add a default value or choice options for required workflow_dispatch inputs.",
      "If a required value must be entered manually, document the expected value in the workflow input description."
    ]
  })
}

function classifyBuildScriptFailure({ issue, payload, errorMessage }) {
  if (!/(ERR_PNPM_NO_SCRIPT|Missing script|Command .* not found|not found in package\.json)/i.test(errorMessage)) {
    return null
  }

  return buildResult({
    issue,
    payload,
    classification: "project_config_issue",
    action: "send_project_config_email",
    confidence: "medium",
    reason: "The deploy workflow selected a build command that is not defined by the project.",
    labels: ["auto-triage", "project-config", "needs-project-owner"],
    evidence: [errorMessage.split(/\r?\n/)[0]].filter(Boolean),
    projectAdvice: [
      "Choose a buildcmd that exists in the project package.json scripts.",
      "If the command is intentional, add the missing script before deploying."
    ]
  })
}

function classifyIssue(issue) {
  const payload = extractPayload(issue.body) || {}
  const errorMessage = extractErrorMessage(issue.body, payload)
  const githubFiles = extractProjectGithubFiles(issue.body)
  const workflowFile = findWorkflowFile(githubFiles, payload.workflow)
  const parsedWorkflow = workflowFile ? parseWorkflowSnapshot(workflowFile) : null

  return (
    classifyProvidedValueError({ issue, payload, errorMessage, workflowFile, parsedWorkflow }) ||
    classifyMissingWorkflow({ issue, payload, errorMessage, workflowFile, parsedWorkflow }) ||
    classifyMissingInputs({ issue, payload, errorMessage, workflowFile, parsedWorkflow }) ||
    classifyBuildScriptFailure({ issue, payload, errorMessage }) ||
    buildResult({
      issue,
      payload,
      classification: "needs_manual_triage",
      action: "comment_only",
      confidence: "low",
      reason: "The issue did not match a known deploy parser or project configuration pattern.",
      labels: ["auto-triage", "needs-manual-triage"],
      evidence: [errorMessage.split(/\r?\n/)[0]].filter(Boolean)
    })
  )
}

function buildResult({ issue, payload, classification, action, confidence, reason, labels, evidence = [], projectAdvice = [] }) {
  return {
    schemaVersion: 1,
    issue,
    payload,
    classification,
    action,
    confidence,
    reason,
    labels,
    evidence,
    projectAdvice,
    shouldSendEmail: action === "send_project_config_email",
    shouldOpenParserFixPr: action === "open_parser_fix_pr",
    email: action === "send_project_config_email" ? buildProjectConfigEmail({ issue, payload, reason, evidence, projectAdvice }) : null
  }
}

function buildProjectConfigEmail({ issue, payload, reason, evidence, projectAdvice }) {
  const commerceRepo = payload.commerceRepo || "unknown repo"
  const workflow = payload.workflowName || payload.workflow || "unknown workflow"
  const branch = payload.targetBranch || "unknown branch"

  const bodyText = [
    `Pacvue Deploy detected a project workflow configuration issue.`,
    ``,
    `Issue: ${issue.url || `#${issue.number}`}`,
    `Commerce repo: ${commerceRepo}`,
    `Workflow: ${workflow}`,
    `Target branch: ${branch}`,
    ``,
    `Reason: ${reason}`,
    ``,
    evidence.length ? `Evidence:\n${evidence.map((item) => `- ${item}`).join("\n")}` : null,
    projectAdvice.length ? `Suggested project-side fix:\n${projectAdvice.map((item) => `- ${item}`).join("\n")}` : null
  ]
    .filter(Boolean)
    .join("\n")

  return {
    subject: `[Pacvue Deploy] Project workflow config needs attention: ${commerceRepo}`,
    bodyText
  }
}

function buildIssueComment(result) {
  const lines = [
    "## Pacvue Deploy triage",
    "",
    `- Classification: \`${result.classification}\``,
    `- Action: \`${result.action}\``,
    `- Confidence: \`${result.confidence}\``,
    `- Reason: ${result.reason}`
  ]

  if (result.evidence.length) {
    lines.push("", "### Evidence", "", ...result.evidence.map((item) => `- ${item}`))
  }

  if (result.projectAdvice.length) {
    lines.push("", "### Project-side fix", "", ...result.projectAdvice.map((item) => `- ${item}`))
  }

  if (result.shouldOpenParserFixPr) {
    lines.push("", "A parser-fix prompt was generated for the repository automation. If the agent command is configured, this workflow will open a PR with the code change.")
  }

  if (result.shouldSendEmail) {
    lines.push("", "A project configuration email will be sent when `PACVUE_DEPLOY_TRIAGE_EMAIL_TO` is configured.")
  }

  return `${lines.join("\n")}\n`
}

function buildParserFixPrompt(result) {
  return [
    `Fix Pacvue Deploy parser issue from GitHub issue #${result.issue.number}.`,
    "",
    "Goal:",
    "- Modify the extension source so this issue is handled automatically next time.",
    "- Keep the fix scoped to parser/diagnostic behavior.",
    "- Add or update lightweight tests/scripts when practical.",
    "",
    "Issue:",
    result.issue.url || "(no issue URL)",
    "",
    "Classification:",
    JSON.stringify(
      {
        classification: result.classification,
        confidence: result.confidence,
        reason: result.reason,
        evidence: result.evidence
      },
      null,
      2
    ),
    "",
    "Structured deploy payload:",
    "```json",
    JSON.stringify(result.payload || {}, null, 2),
    "```"
  ].join("\n")
}

function writeArtifacts(result, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
  fs.writeFileSync(path.join(outDir, "issue-comment.md"), buildIssueComment(result))
  fs.writeFileSync(path.join(outDir, "labels.txt"), `${result.labels.join("\n")}\n`)

  if (result.email) {
    fs.writeFileSync(path.join(outDir, "project-config-email.json"), `${JSON.stringify(result.email, null, 2)}\n`)
  }

  if (result.shouldOpenParserFixPr) {
    fs.writeFileSync(path.join(outDir, "parser-fix-prompt.md"), buildParserFixPrompt(result))
    fs.writeFileSync(
      path.join(outDir, "pr-body.md"),
      [`Auto-generated parser fix for issue #${result.issue.number}.`, "", result.issue.url || "", "", buildIssueComment(result)].join("\n")
    )
  }
}

function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return

  const outputs = {
    issue_number: result.issue.number || "",
    classification: result.classification,
    action: result.action,
    confidence: result.confidence,
    labels: result.labels.join(","),
    should_send_email: result.shouldSendEmail ? "true" : "false",
    should_open_parser_fix_pr: result.shouldOpenParserFixPr ? "true" : "false"
  }

  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
      .join("\n") + "\n"
  )
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return 0
  }

  const issue = readIssue(args)
  const result = classifyIssue(issue)
  writeArtifacts(result, args.outDir)
  writeGithubOutputs(result)
  console.log(JSON.stringify(result, null, 2))
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  classifyIssue,
  extractPayload,
  extractProjectGithubFiles,
  parseCommandInputs
}
