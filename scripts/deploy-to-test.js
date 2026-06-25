const { execFileSync, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const {
  buildDispatchInputs,
  buildGithubApiDispatchPreview,
  canUseGithubCli,
  commandExists,
  dispatchWorkflowViaApi,
  getGithubRepoInfo,
  getGithubToken,
  getLastSuccessfulRunInputs,
  getMissingGithubAuthPayload,
  hasGithubAuth
} = require("./github-api")

const TEST_WORKFLOW_NAME = "测试环境发版"
const TEST_BRANCH_PATTERN = /^(test|sprint)\//
const MERGE_KEYWORD_PATTERN = /(合并|合到|merge)/
const BRANCH_PATTERN = /\b((?:test|sprint)\/[^\s，,]+)/i

/** GitHub/gh expect POSIX-style workflow paths; Windows path.relative uses backslashes. */
function normalizeWorkflowFilePath(workflowFile) {
  return String(workflowFile ?? "").trim().replace(/\\/g, "/")
}

function parseBoolean(value) {
  if (value === undefined) return true
  return value === true || value === "true"
}

function parseScalar(rawValue) {
  const value = String(rawValue ?? "").trim()
  if (value === "true") return true
  if (value === "false") return false
  return value.replace(/^["']|["']$/g, "")
}

function getIndent(line) {
  return line.match(/^ */)[0].length
}

function parseWorkflowFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8")
  const lines = content.split(/\r?\n/)
  const workflow = {
    filePath,
    name: "",
    hasWorkflowDispatch: false,
    inputs: {},
    branchInputName: null
  }

  let inInputs = false
  let inputIndent = null
  let currentInputName = null
  let inOptions = false
  let optionIndent = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    if (!workflow.name && trimmed.startsWith("name:")) {
      workflow.name = parseScalar(trimmed.slice("name:".length))
      continue
    }

    if (/^workflow_dispatch:\s*(?:#.*)?$/.test(trimmed)) {
      workflow.hasWorkflowDispatch = true
      continue
    }

    if (/^inputs:\s*(?:#.*)?$/.test(trimmed) && workflow.hasWorkflowDispatch) {
      inInputs = true
      inputIndent = getIndent(line)
      continue
    }

    if (!inInputs) continue

    const indent = getIndent(line)
    if (indent <= inputIndent && !trimmed.startsWith("- ")) {
      inInputs = false
      currentInputName = null
      inOptions = false
      continue
    }

    const inputMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(?:#.*)?$/)
    if (inputMatch && indent === inputIndent + 2) {
      currentInputName = inputMatch[1]
      workflow.inputs[currentInputName] = { required: false, options: [] }
      inOptions = false
      optionIndent = null
      continue
    }

    if (!currentInputName) continue

    if (/^options:\s*(?:#.*)?$/.test(trimmed)) {
      inOptions = true
      optionIndent = indent
      continue
    }

    if (inOptions && trimmed.startsWith("- ")) {
      workflow.inputs[currentInputName].options.push(parseScalar(trimmed.slice(2)))
      continue
    }

    if (inOptions && indent <= optionIndent) {
      inOptions = false
      optionIndent = null
    }

    const propertyMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (propertyMatch) {
      const [, key, value] = propertyMatch
      workflow.inputs[currentInputName][key] = parseScalar(value)
    }
  }

  workflow.branchInputName = findBranchInputName(workflow.inputs)
  return workflow
}

function findBranchInputName(inputs) {
  const exactMatch = ["branch_manually", "branchManual", "branch_manual"].find((name) => inputs[name])
  if (exactMatch) return exactMatch

  return (
    Object.entries(inputs).find(([name, input]) => {
      const normalizedName = name.toLowerCase()
      return normalizedName.includes("branch") && input.type !== "choice"
    })?.[0] ?? null
  )
}

function discoverWorkflows(repoRoot, options = {}) {
  const workflowDir = path.join(repoRoot, ".github", "workflows")
  const localWorkflows = fs.existsSync(workflowDir)
    ? fs
        .readdirSync(workflowDir)
        .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
        .map((file) => parseWorkflowFile(path.join(workflowDir, file)))
        .filter((workflow) => workflow.hasWorkflowDispatch)
        .filter((workflow) => options.includeAll || workflow.name.includes(TEST_WORKFLOW_NAME))
    : []

  if (hasDeployWorkflow(localWorkflows)) return localWorkflows
  if (!options.includeAll && localWorkflows.length > 0) return localWorkflows

  const ghWorkflows = discoverGhWorkflows(repoRoot, options)
  return ghWorkflows.length > 0 ? ghWorkflows : localWorkflows
}

function hasDeployWorkflow(workflows) {
  return workflows.some((workflow) => workflow.name.includes(TEST_WORKFLOW_NAME))
}

function discoverGhWorkflows(repoRoot, options = {}) {
  if (!canUseGithubCli()) {
    return []
  }

  const result = spawnSync("gh", ["workflow", "list", "--json", "name,path,state"], { cwd: repoRoot, encoding: "utf8" })
  if (result.status !== 0) return []

  try {
    const workflows = JSON.parse(result.stdout)
    if (!Array.isArray(workflows)) return []

    return workflows
      .filter((workflow) => !workflow.state || workflow.state === "active")
      .filter((workflow) => options.includeAll || String(workflow.name || "").includes(TEST_WORKFLOW_NAME))
      .map((workflow) => ({
        filePath: path.resolve(repoRoot, workflow.path || workflow.name),
        name: workflow.name || workflow.path || "",
        hasWorkflowDispatch: true,
        inputs: {},
        branchInputName: null
      }))
  } catch (_error) {
    return []
  }
}

function extractExplicitBranch(userText = "") {
  return userText.match(BRANCH_PATTERN)?.[1] ?? null
}

function detectMode({ userText = "", headBranch = "", explicitBranch = null }) {
  const targetBranch = explicitBranch || extractExplicitBranch(userText)
  const hasMergeIntent = MERGE_KEYWORD_PATTERN.test(userText)

  if (hasMergeIntent && targetBranch && headBranch === targetBranch) {
    return { mode: null, targetBranch, needsClarification: true, reason: "HEAD is already on the target test branch; ask which feature branch to merge." }
  }

  if (hasMergeIntent && targetBranch) return { mode: "C", targetBranch, needsClarification: false }
  if (hasMergeIntent && !targetBranch) return { mode: null, targetBranch: null, needsClarification: true, reason: "Merge intent needs a target test branch." }
  if (targetBranch) return { mode: "B", targetBranch, needsClarification: false }
  if (TEST_BRANCH_PATTERN.test(headBranch)) return { mode: "A", targetBranch: headBranch, needsClarification: false }

  return { mode: null, targetBranch: null, needsClarification: true, reason: "Current branch does not look like a test branch; ask whether to deploy current HEAD or merge into a test branch." }
}

function parseInputPairs(inputPairs = []) {
  return inputPairs.reduce((inputs, pair) => {
    const separatorIndex = pair.indexOf("=")
    if (separatorIndex === -1) throw new Error(`Invalid --input value "${pair}". Use key=value.`)
    const key = pair.slice(0, separatorIndex)
    const value = pair.slice(separatorIndex + 1)
    inputs[key] = value
    return inputs
  }, {})
}

function resolveInputs({ workflow, providedInputs = {}, lastRunInputs = {}, targetBranch = "" }) {
  const resolvedInputs = {}
  const missingRequiredInputs = []
  const suggestions = {}

  for (const [name, input] of Object.entries(workflow.inputs)) {
    if (name === workflow.branchInputName) continue

    if (Object.prototype.hasOwnProperty.call(providedInputs, name)) {
      resolvedInputs[name] = providedInputs[name]
      continue
    }

    if (Object.prototype.hasOwnProperty.call(lastRunInputs, name)) {
      resolvedInputs[name] = lastRunInputs[name]
      continue
    }

    if (Object.prototype.hasOwnProperty.call(input, "default")) {
      resolvedInputs[name] = String(input.default)
      continue
    }

    if (input.required) {
      missingRequiredInputs.push(name)
      if (input.options?.length) suggestions[name] = input.options
    }
  }

  if (workflow.branchInputName) {
    resolvedInputs[workflow.branchInputName] = targetBranch
  }

  return { resolvedInputs, missingRequiredInputs, suggestions }
}

function buildWorkflowCommand({ workflowFile, refBranch, inputs, branchInputName }) {
  const command = ["gh", "workflow", "run", normalizeWorkflowFilePath(workflowFile), "--ref", refBranch]

  for (const [key, value] of Object.entries(inputs)) {
    if (key === branchInputName) continue
    command.push("-f", `${key}=${value}`)
  }

  if (branchInputName) {
    command.push("-f", `${branchInputName}=${refBranch}`)
  }

  return command
}

function quoteShellArg(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function formatCommand(command) {
  return command.map(quoteShellArg).join(" ")
}

function runGit(repoRoot, args, options = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: options.stdio ?? ["ignore", "pipe", "pipe"] }).trim()
}

function getMissingGhPayload() {
  return getMissingGithubAuthPayload()
}

function runGhCommand(args, cwd) {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8" })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  }
}

function validateRemoteBranch(repoRoot, branch) {
  const result = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: repoRoot, encoding: "utf8" })
  return result.status === 0
}

// Maps legacy Chinese run-name labels to workflow input names for backward compatibility.
const DISPLAY_TITLE_KEY_ALIASES = {
  项目名称: "ProjectName",
  环境: "environment",
  分支: "branch"
}

// Parses a run's displayTitle (run-name) into workflow inputs. Expects segments
// separated by "|" or ",", each "key: value" or "key=value". Keys are matched to
// workflow input names verbatim (e.g. ProjectName/environment/buildcmd), with
// legacy Chinese labels (项目名称/环境/分支) mapped via aliases.
function parseDisplayTitle(displayTitle) {
  const parsed = {}
  for (const part of String(displayTitle).split(/[|,]/)) {
    const match = part.match(/^\s*([^:=：]+?)\s*[:=：]\s*(.+?)\s*$/)
    if (!match) continue
    const rawKey = match[1].trim()
    const value = match[2].trim()
    if (!rawKey || !value) continue

    const key = DISPLAY_TITLE_KEY_ALIASES[rawKey] ?? rawKey
    parsed[key] = value
  }
  return parsed
}

function parseArgs(argv) {
  const args = {
    repoRoot: process.cwd(),
    inputPairs: [],
    dryRun: true,
    dispatch: false,
    skipRemoteCheck: false,
    skipLastRunInputs: false,
    listWorkflowsJson: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--repo-root") args.repoRoot = path.resolve(argv[++index])
    else if (arg === "--branch") args.branch = argv[++index]
    else if (arg === "--message") args.message = argv[++index]
    else if (arg === "--workflow") args.workflow = argv[++index]
    else if (arg === "--list-workflows-json") args.listWorkflowsJson = true
    else if (arg === "--input") args.inputPairs.push(argv[++index])
    else if (arg === "--dry-run") args.dryRun = parseBoolean(argv[index + 1]?.startsWith("--") ? undefined : argv[++index])
    else if (arg === "--dispatch") {
      args.dispatch = true
      args.dryRun = false
    } else if (arg === "--skip-remote-check") args.skipRemoteCheck = true
    else if (arg === "--skip-last-run-inputs" || arg === "--no-last-run-inputs") args.skipLastRunInputs = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/deploy-to-test.js [options]

Options:
  --repo-root <path>        Git repo root. Defaults to current working directory.
  --branch <branch>         Target test branch.
  --message <text>          User request text used for mode detection.
  --workflow <file>         Workflow filename or path when multiple workflows match.
  --list-workflows-json     Print matching local workflow metadata as JSON.
  --input key=value         Workflow input. Repeat for multiple inputs.
  --dry-run                 Print plan and command without dispatching. Default.
  --dispatch                Execute gh workflow run after validation.
  --skip-remote-check       Skip origin branch existence check.
  --skip-last-run-inputs    Skip gh run list lookup for previous workflow inputs.
`)
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2))
}

function selectWorkflow(workflows, requestedWorkflow) {
  if (requestedWorkflow) {
    const normalized = requestedWorkflow.replace(/\\/g, "/")
    const workflow = workflows.find((item) => item.filePath.replace(/\\/g, "/").endsWith(normalized) || path.basename(item.filePath) === normalized)
    if (!workflow) throw new Error(`Workflow "${requestedWorkflow}" was not found among workflow_dispatch workflows.`)
    return workflow
  }

  if (workflows.length === 0) throw new Error(`No workflow with name containing "${TEST_WORKFLOW_NAME}" was found.`)
  if (workflows.length > 1) {
    const names = workflows.map((workflow) => `${workflow.filePath} (${workflow.name})`).join("\n")
    throw new Error(`Multiple matching workflows found. Re-run with --workflow.\n${names}`)
  }

  return workflows[0]
}

function formatWorkflowMetadata(repoRoot, workflow) {
  return {
    file: normalizeWorkflowFilePath(path.relative(repoRoot, workflow.filePath)),
    name: workflow.name,
    hasWorkflowDispatch: workflow.hasWorkflowDispatch,
    isDefaultDeployWorkflow: workflow.name.includes(TEST_WORKFLOW_NAME),
    branchInputName: workflow.branchInputName,
    inputs: workflow.inputs
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return 0
  }

  const repoRoot = args.repoRoot
  if (args.listWorkflowsJson) {
    const workflows = discoverWorkflows(repoRoot, { includeAll: true }).map((workflow) => formatWorkflowMetadata(repoRoot, workflow))
    printJson({ ok: workflows.length > 0, repoRoot, workflows })
    return workflows.length > 0 ? 0 : 2
  }

  if (!commandExists("git")) throw new Error("git is required.")
  if (args.dispatch && !hasGithubAuth()) {
    printJson(getMissingGithubAuthPayload())
    return 2
  }

  const headBranch = runGit(repoRoot, ["branch", "--show-current"])
  const explicitBranch = args.branch || extractExplicitBranch(args.message || "")
  const modeInfo = detectMode({ userText: args.message || "", headBranch, explicitBranch })
  const targetBranch = explicitBranch || modeInfo.targetBranch

  if (modeInfo.needsClarification || !targetBranch) {
    printJson({ ok: false, needsClarification: true, mode: modeInfo.mode, reason: modeInfo.reason, headBranch })
    return 2
  }

  if (!args.skipRemoteCheck && !validateRemoteBranch(repoRoot, targetBranch)) {
    printJson({ ok: false, reason: `Remote branch "${targetBranch}" was not found on origin.`, targetBranch })
    return 2
  }

  const workflows = discoverWorkflows(repoRoot, { includeAll: Boolean(args.workflow) })
  const workflow = selectWorkflow(workflows, args.workflow)
  if (!workflow.hasWorkflowDispatch) throw new Error(`Workflow "${workflow.filePath}" does not use workflow_dispatch.`)

  const workflowFile = normalizeWorkflowFilePath(path.relative(repoRoot, workflow.filePath))
  const providedInputs = parseInputPairs(args.inputPairs)
  const lastRunInputs = args.skipLastRunInputs
    ? {}
    : await getLastSuccessfulRunInputs({
        repoRoot,
        workflowFile,
        targetBranch,
        runGhCommand,
        runGit,
        parseDisplayTitle
      })
  const inputResolution = resolveInputs({ workflow, providedInputs, lastRunInputs, targetBranch })
  const dispatchInputs = buildDispatchInputs(inputResolution.resolvedInputs, workflow.branchInputName, targetBranch)
  const command = buildWorkflowCommand({
    workflowFile,
    refBranch: targetBranch,
    inputs: inputResolution.resolvedInputs,
    branchInputName: workflow.branchInputName
  })
  const useGithubApi = !canUseGithubCli()
  let commandPreview = formatCommand(command)

  if (useGithubApi) {
    const apiConfig = getGithubRepoInfo(repoRoot, runGit)
    commandPreview = buildGithubApiDispatchPreview({
      apiConfig,
      workflowFile,
      refBranch: targetBranch,
      inputs: dispatchInputs
    })
  }

  const output = {
    ok: inputResolution.missingRequiredInputs.length === 0,
    mode: modeInfo.mode,
    workflow: {
      file: workflowFile,
      name: workflow.name,
      branchInputName: workflow.branchInputName,
      branchStrategy: workflow.branchInputName ? "input-and-ref" : "ref-only"
    },
    headBranch,
    targetBranch,
    resolvedInputs: inputResolution.resolvedInputs,
    lastRunInputs,
    missingRequiredInputs: inputResolution.missingRequiredInputs,
    suggestions: inputResolution.suggestions,
    command,
    commandPreview,
    transport: useGithubApi ? "github-api" : "gh",
    dryRun: args.dryRun
  }

  printJson(output)

  if (inputResolution.missingRequiredInputs.length > 0) {
    return args.dispatch ? 2 : 0
  }

  if (args.dispatch) {
    if (canUseGithubCli()) {
      const result = spawnSync(command[0], command.slice(1), { cwd: repoRoot, encoding: "utf8" })
      if (result.stdout) {
        process.stderr.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`)
      }
      if (result.stderr) {
        process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`)
      }
      if (result.status !== 0) return result.status || 1
      return 0
    }

    const apiConfig = getGithubRepoInfo(repoRoot, runGit)
    const token = getGithubToken()
    const dispatchResult = await dispatchWorkflowViaApi({
      apiConfig,
      workflowFile,
      refBranch: targetBranch,
      inputs: dispatchInputs,
      token
    })

    if (!dispatchResult.ok) {
      printJson({
        ok: false,
        reason: dispatchResult.reason,
        transport: "github-api",
        ...(dispatchResult.remediation ? { remediation: dispatchResult.remediation } : {})
      })
      return 2
    }
  }

  return 0
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}

module.exports = {
  buildWorkflowCommand,
  detectMode,
  discoverWorkflows,
  extractExplicitBranch,
  formatWorkflowMetadata,
  normalizeWorkflowFilePath,
  parseDisplayTitle,
  parseWorkflowFile,
  resolveInputs
}
