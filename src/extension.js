const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const vscode = require("vscode")
const {
  cancelWorkflowRun,
  createDeployFailureIssue,
  getGithubAuthSummary,
  getGithubRepoInfo,
  getWorkflowRunJobsSummary,
  hasGithubAuth,
  queryLatestWorkflowRun
} = require("../scripts/github-api")

const VIEW_ID = "pacvueCommerceDeployView"
const RUN_STATUS_POLL_INTERVAL_MS = 60 * 1000
const DEPLOY_HISTORY_KEY = "pacvueDeploy.deployHistory"
const DEPLOY_HISTORY_LIMIT = 10
const DEPLOY_PRESETS_KEY = "pacvueDeploy.presets"
const DEPLOY_PRESETS_LIMIT = 20

function activate(context) {
  const provider = new DeployViewProvider(context)

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }))
  context.subscriptions.push(vscode.commands.registerCommand("pacvueDeploy.focus", () => vscode.commands.executeCommand("workbench.view.extension.pacvueDeploy")))
}

function deactivate() {}

class DeployViewProvider {
  constructor(context) {
    this.context = context
    this.pollTimer = null
    this.activeRun = null
  }

  // Builds a globalState key scoped per repo + workflow + branch so that cached
  // inputs from different projects/workflows/branches never collide.
  lastInputsKey(repoId, workflow, branch) {
    return `pacvueDeploy.lastInputs::${repoId}::${workflow || ""}::${branch}`
  }

  // Resolves a stable repo identity (owner/repo) for the cache key, falling back
  // to the workspace path when the origin remote can't be parsed.
  getRepoId(workspaceRoot) {
    try {
      const repo = getGithubRepoInfo(workspaceRoot, (repoRoot, gitArgs) => runGitCommand(gitArgs, repoRoot).stdout.trim())
      if (repo?.owner && repo?.repo) {
        return `${repo.owner}/${repo.repo}`
      }
    } catch (_error) {
      // fall through to path-based id
    }
    return workspaceRoot
  }

  // Persists the inputs submitted for a successful deploy, keyed per repo/workflow/branch.
  saveLastInputs(workspaceRoot, workflow, branch, inputs) {
    if (!workspaceRoot || !branch) return
    const cleaned = {}
    for (const [key, value] of Object.entries(inputs || {})) {
      if (value === undefined || value === null || value === "") continue
      cleaned[key] = value
    }
    if (Object.keys(cleaned).length === 0) return
    const cacheKey = this.lastInputsKey(this.getRepoId(workspaceRoot), workflow, branch)
    this.context.globalState.update(cacheKey, cleaned)
  }

  // Reads previously cached inputs for a repo/workflow/branch (empty object if none).
  readLastInputs(workspaceRoot, workflow, branch) {
    if (!workspaceRoot || !branch) return {}
    const cacheKey = this.lastInputsKey(this.getRepoId(workspaceRoot), workflow, branch)
    const cached = this.context.globalState.get(cacheKey)
    return cached && typeof cached === "object" ? cached : {}
  }

  getDeployHistory() {
    const history = this.context.globalState.get(DEPLOY_HISTORY_KEY, [])
    return Array.isArray(history) ? history : []
  }

  async appendDeployHistory(workspaceRoot, form, parsed) {
    const ts = Date.now()
    const repoId = this.getRepoId(workspaceRoot)
    const entry = {
      id: String(ts),
      ts,
      repoId,
      branch: parsed?.targetBranch || form.branch,
      workflow: form.workflow,
      workflowName: parsed?.workflow?.name || form.workflow,
      inputs: { ...(form.inputs || {}) }
    }
    const signature = JSON.stringify({ repoId: entry.repoId, branch: entry.branch, workflow: entry.workflow, inputs: entry.inputs })
    const next = [entry, ...this.getDeployHistory().filter((item) => JSON.stringify({ repoId: item.repoId, branch: item.branch, workflow: item.workflow, inputs: item.inputs || {} }) !== signature)].slice(0, DEPLOY_HISTORY_LIMIT)
    await this.context.globalState.update(DEPLOY_HISTORY_KEY, next)
    return next
  }

  async clearDeployHistory() {
    await this.context.globalState.update(DEPLOY_HISTORY_KEY, [])
  }

  getDeployPresets() {
    const presets = this.context.globalState.get(DEPLOY_PRESETS_KEY, [])
    return Array.isArray(presets) ? presets : []
  }

  async saveDeployPreset(workspaceRoot, form, name) {
    const repoId = this.getRepoId(workspaceRoot)
    const workflowMetadata = workspaceRoot ? getWorkflowMetadata(findDeployScript(workspaceRoot, this.context.extensionPath), workspaceRoot) : { workflows: [] }
    const workflow = workflowMetadata.workflows.find((item) => item.file === form.workflow)
    const entry = {
      id: String(Date.now()),
      name,
      repoId,
      branch: form.branch,
      workflow: form.workflow,
      workflowName: workflow?.name || form.workflow,
      inputs: { ...(form.inputs || {}) }
    }
    const next = [entry, ...this.getDeployPresets().filter((item) => item.id !== entry.id)].slice(0, DEPLOY_PRESETS_LIMIT)
    await this.context.globalState.update(DEPLOY_PRESETS_KEY, next)
    return next
  }

  async deleteDeployPreset(id) {
    const next = this.getDeployPresets().filter((item) => item.id !== id)
    await this.context.globalState.update(DEPLOY_PRESETS_KEY, next)
    return next
  }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    }
    webviewView.webview.html = this.getHtml(webviewView.webview)

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "ready") {
        await this.postInitialState(webviewView)
        return
      }

      if (message.type === "dryRun" || message.type === "dispatch") {
        await this.runDeployCommand(webviewView, message.type, message.payload)
        return
      }

      if (message.type === "queryLastRun") {
        await this.queryLastRunConfig(webviewView, message.payload)
        return
      }

      if (message.type === "clearHistory") {
        await this.clearDeployHistory()
        webviewView.webview.postMessage({ type: "history", payload: { entries: [] } })
        return
      }

      if (message.type === "savePreset") {
        const workspaceRoot = getWorkspaceRoot()
        const name = String(message.payload?.name ?? "").trim()
        if (workspaceRoot && name) {
          const entries = await this.saveDeployPreset(workspaceRoot, message.payload, name)
          webviewView.webview.postMessage({ type: "presets", payload: { entries } })
        }
        return
      }

      if (message.type === "deletePreset") {
        const entries = await this.deleteDeployPreset(String(message.payload?.id ?? ""))
        webviewView.webview.postMessage({ type: "presets", payload: { entries } })
        return
      }

      if (message.type === "openExternal" && message.url) {
        await vscode.env.openExternal(vscode.Uri.parse(String(message.url)))
        return
      }

      if (message.type === "cancel") {
        await this.cancelDeployCommand(webviewView)
      }
    })
  }

  async queryLastRunConfig(webviewView, payload = {}) {
    const { branch, workflow, requestId } = payload
    const emptyResult = {
      type: "lastRunConfig",
      payload: { requestId, branch, workflow, ok: false, resolvedInputs: {}, lastRunInputs: {} }
    }

    const workspaceRoot = getWorkspaceRoot()
    if (!workspaceRoot || !branch) {
      webviewView.webview.postMessage(emptyResult)
      return
    }

    const scriptPath = findDeployScript(workspaceRoot, this.context.extensionPath)
    if (!scriptPath) {
      webviewView.webview.postMessage(emptyResult)
      return
    }

    const args = buildScriptArgs(scriptPath, { branch, workflow, inputs: {} }, "dry-run", { skipLastRunInputs: false })
    const result = await runCommandAsync("node", args, workspaceRoot)
    const parsed = parseJsonOutput(result.stdout)

    // GitHub can't expose a past run's dispatch inputs, so fall back to the inputs
    // this plugin cached on the last successful deploy of the same repo/workflow/branch.
    // GitHub-parsed values (from run-name) still win where available.
    const cachedInputs = this.readLastInputs(workspaceRoot, workflow, branch)
    const githubLastRunInputs = parsed?.lastRunInputs ?? {}
    const lastRunInputs = { ...cachedInputs, ...githubLastRunInputs }
    const inputSources = buildInputSources(cachedInputs, githubLastRunInputs)
    const configSource = buildConfigSource(cachedInputs, githubLastRunInputs)

    webviewView.webview.postMessage({
      type: "lastRunConfig",
      payload: {
        requestId,
        branch,
        workflow,
        ok: result.status === 0 && Boolean(parsed),
        resolvedInputs: parsed?.resolvedInputs ?? {},
        lastRunInputs,
        inputSources,
        configSource
      }
    })
  }

  async postInitialState(webviewView) {
    const workspaceRoot = getWorkspaceRoot()
    const branchResult = workspaceRoot
      ? await getBranchOptions(workspaceRoot)
      : buildEmptyBranchResult("Open a folder workspace to load Git branches.", buildBranchDiagnosis({ workspaceRoot: null }))
    const currentBranch = branchResult.currentBranch || ""
    const scriptPath = workspaceRoot ? findDeployScript(workspaceRoot, this.context.extensionPath) : null
    const workflowMetadata = workspaceRoot && scriptPath ? getWorkflowMetadata(scriptPath, workspaceRoot) : { workflows: [], error: null }

    webviewView.webview.postMessage({
      type: "state",
      payload: {
        workspaceRoot,
        currentBranch,
        branchOptions: branchResult.branches,
        branchError: branchResult.error,
        branchDebug: branchResult.debug ?? null,
        branchDiagnosis: branchResult.diagnosis ?? null,
        scriptPath,
        workflows: workflowMetadata.workflows,
        workflowError: workflowMetadata.error,
        githubAuth: getGithubAuthSummary(getGithubTransportOptions()),
        deployHistory: this.getDeployHistory(),
        deployPresets: this.getDeployPresets()
      }
    })
  }

  async runDeployCommand(webviewView, action, form) {
    const workspaceRoot = getWorkspaceRoot()
    if (!workspaceRoot) {
      webviewView.webview.postMessage({ type: "result", payload: { ok: false, error: "Open a Pacvue commerce workspace before deploying." } })
      return
    }

    const scriptPath = findDeployScript(workspaceRoot, this.context.extensionPath)
    if (!scriptPath) {
      webviewView.webview.postMessage({
        type: "result",
        payload: {
          ok: false,
          error: "Could not find pacvue-commerce-deploy-plugin/scripts/deploy-to-test.js in this workspace."
        }
      })
      return
    }

    const args = buildScriptArgs(scriptPath, form, action)
    webviewView.webview.postMessage({ type: "running", payload: { action, command: ["node", ...args].join(" ") } })

    const result = runCommand("node", args, workspaceRoot)
    const parsed = enrichDeployParsedResult(parseJsonOutput(result.stdout), form)
    const ok = result.status === 0 && (parsed?.ok ?? true)
    const command = ["node", ...args].join(" ")

    if (action === "dispatch" && ok) {
      this.saveLastInputs(workspaceRoot, form.workflow, form.branch, form.inputs)
      const deployHistory = await this.appendDeployHistory(workspaceRoot, form, parsed)
      webviewView.webview.postMessage({ type: "history", payload: { entries: deployHistory } })
      webviewView.webview.postMessage({
        type: "runStatus",
        payload: {
          state: "in_progress",
          status: "queued",
          conclusion: null,
          parsed,
          command,
          message: "Deploy workflow is in progress. Next status check runs in 1 minute."
        }
      })
      this.startRunStatusPolling(webviewView, workspaceRoot, parsed, command)
      return
    }

    webviewView.webview.postMessage({
      type: "result",
      payload: {
        ok,
        status: result.status,
        action,
        parsed,
        stdout: result.stdout,
        stderr: result.stderr,
        command
      }
    })

    if (action === "dispatch" && !ok) {
      void this.reportDeployFailure({
        failureType: "trigger",
        workspaceRoot,
        parsed,
        command,
        message: [parsed?.reason, ...(Array.isArray(parsed?.remediation) ? parsed.remediation : [])].filter(Boolean).join("\n") || result.stderr || result.stdout
      })
    }
  }

  startRunStatusPolling(webviewView, workspaceRoot, parsed, command) {
    this.stopRunStatusPolling()

    const workflowFile = normalizeWorkflowFileForGh(parsed?.workflow?.file)
    const targetBranch = parsed?.targetBranch
    if (!workflowFile || !targetBranch) {
      webviewView.webview.postMessage({
        type: "runStatus",
        payload: {
          state: "unknown",
          status: "unknown",
          conclusion: null,
          parsed,
          command,
          message: "Workflow was triggered, but run status cannot be polled because workflow or branch metadata is missing."
        }
      })
      return
    }

    this.activeRun = {
      workspaceRoot,
      workflowFile,
      targetBranch,
      parsed,
      command
    }

    const poll = async () => {
      const run = await getLatestWorkflowRunWithFallback(workspaceRoot, workflowFile, targetBranch)
      if (!run.ok) {
        webviewView.webview.postMessage({
          type: "runStatus",
          payload: {
            state: "in_progress",
            status: "polling",
            conclusion: null,
            parsed,
            command,
            message: run.error || "Workflow is still in progress. Next status check runs in 1 minute."
          }
        })
        return
      }

      if (!isWorkflowRunInProgress(run.status)) {
        this.stopRunStatusPolling()
        const state = getCompletedRunState(run)
        const jobsSummary = state === "failed" ? await getRunJobsSummaryForDiagnosis(workspaceRoot, run) : null
        const failureDiagnosis = state === "failed" ? buildFailureDiagnosis({ run, parsed, conclusion: run.conclusion, jobsSummary }) : null

        webviewView.webview.postMessage({
          type: "runStatus",
          payload: {
            state,
            status: run.status,
            conclusion: run.conclusion,
            run,
            parsed,
            command,
            message: getCompletedRunMessage(state),
            jobsSummary,
            failureDiagnosis
          }
        })

        if (state === "failed") {
          void this.reportDeployFailure({
            failureType: "run",
            workspaceRoot,
            parsed,
            command,
            run,
            conclusion: run.conclusion,
            message: getCompletedRunMessage(state),
            jobsSummary
          })
        } else if (state === "success") {
          void this.notifyDeploySuccess({
            parsed,
            run
          })
        }
        return
      }

      webviewView.webview.postMessage({
        type: "runStatus",
        payload: {
          state: "in_progress",
          status: run.status,
          conclusion: run.conclusion,
          run,
          parsed,
          command,
          message: "Deploy workflow is still in progress. Next status check runs in 1 minute."
        }
      })
    }

    void poll()
    this.pollTimer = setInterval(() => {
      void poll()
    }, RUN_STATUS_POLL_INTERVAL_MS)
  }

  stopRunStatusPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.activeRun = null
  }

  async cancelDeployCommand(webviewView) {
    if (!this.activeRun) {
      webviewView.webview.postMessage({
        type: "runStatus",
        payload: {
          state: "failed",
          status: "cancel_failed",
          conclusion: "failure",
          message: "No in-progress deploy workflow is available to cancel."
        }
      })
      return
    }

    const { workspaceRoot, workflowFile, targetBranch, parsed, command } = this.activeRun
    const run = await getLatestWorkflowRunWithFallback(workspaceRoot, workflowFile, targetBranch)
    if (!run.ok) {
      webviewView.webview.postMessage({
        type: "runStatus",
        payload: {
          state: "in_progress",
          status: "cancel_pending",
          conclusion: null,
          parsed,
          command,
          message: run.error || "Could not find workflow run to cancel yet. Polling will continue."
        }
      })
      return
    }

    if (!isWorkflowRunInProgress(run.status)) {
      this.stopRunStatusPolling()
      const state = getCompletedRunState(run)
      webviewView.webview.postMessage({
        type: "runStatus",
        payload: {
          state,
          status: run.status,
          conclusion: run.conclusion,
          run,
          parsed,
          command,
          message: getCompletedRunMessage(state)
        }
      })

      if (state === "success") {
        void this.notifyDeploySuccess({ parsed, run })
      }
      return
    }

    const cancelResult = await cancelWorkflowRunWithFallback(workspaceRoot, run.databaseId)

    webviewView.webview.postMessage({
      type: "runStatus",
      payload: {
        state: "in_progress",
        status: cancelResult.ok ? "cancelling" : "cancel_failed",
        conclusion: null,
        run,
        parsed,
        command,
        message: cancelResult.ok
          ? "Cancel requested. Waiting for GitHub to confirm cancellation."
          : cancelResult.error || "Failed to cancel workflow run."
      }
    })
  }

  async reportDeployFailure(details) {
    const config = vscode.workspace.getConfiguration("pacvueDeploy")
    if (!config.get("createIssueOnFailure", true)) {
      return null
    }

    const transportOptions = getGithubTransportOptions()
    if (!hasGithubAuth(transportOptions)) {
      return null
    }

    const runId = details.run?.databaseId
    if (runId) {
      const reportedRunIds = this.context.globalState.get("reportedDeployFailureRunIds", [])
      if (reportedRunIds.includes(runId)) {
        return null
      }
    }

    const issueRepo = String(config.get("issueRepo") ?? "").trim() || getIssueRepoFromPackage(this.context)
    if (!issueRepo) {
      return null
    }

    const commerceRepo = getCommerceRepoSlug(details.workspaceRoot, transportOptions)
    const githubSnapshot = collectGithubDirectorySnapshot(details.workspaceRoot, {
      priorityWorkflowFile: details.parsed?.workflow?.file
    })
    let jobsSummary = details.jobsSummary ?? null

    if (jobsSummary === null && runId && details.workspaceRoot) {
      jobsSummary = await getWorkflowRunJobsSummary({
        repoRoot: details.workspaceRoot,
        runId,
        getConfiguredToken: transportOptions.getConfiguredToken,
        runGit: (repoRoot, args) => runGitCommand(args, repoRoot).stdout.trim()
      })
    }

    const result = await createDeployFailureIssue({
      issueRepoSlug: issueRepo,
      payload: {
        ...details,
        commerceRepo,
        githubSnapshot,
        jobsSummary,
        extensionVersion: this.context.extension.packageJSON?.version ?? null
      },
      getConfiguredToken: transportOptions.getConfiguredToken,
      runGhCommand: (args, cwd) => runCommand("gh", args, cwd)
    })

    if (!result.ok) {
      const issueError = result.error || "Unknown error while creating deploy failure issue."
      await vscode.window.showErrorMessage(
        `Failed to create deploy failure issue in ${issueRepo}: ${issueError}`,
        "Open Settings"
      ).then((selection) => {
        if (selection === "Open Settings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", "pacvueDeploy.githubToken")
        }
      })
      return result
    }

    if (runId) {
      const reportedRunIds = this.context.globalState.get("reportedDeployFailureRunIds", [])
      await this.context.globalState.update("reportedDeployFailureRunIds", [...reportedRunIds.filter((id) => id !== runId).slice(-99), runId])
    }

    if (result.issueUrl) {
      const openAction = "Open Issue"
      const selection = await vscode.window.showInformationMessage(
        `Deploy failure reported as GitHub issue${result.issueNumber ? ` #${result.issueNumber}` : ""} in ${issueRepo}.`,
        openAction
      )

      if (selection === openAction) {
        await vscode.env.openExternal(vscode.Uri.parse(result.issueUrl))
      }
    }

    return result
  }

  async notifyDeploySuccess(details) {
    const config = vscode.workspace.getConfiguration("pacvueDeploy")
    if (!config.get("notifyOnDeploySuccess", true)) {
      return
    }

    const runId = details.run?.databaseId
    if (runId) {
      const notifiedRunIds = this.context.globalState.get("notifiedDeploySuccessRunIds", [])
      if (notifiedRunIds.includes(runId)) {
        return
      }
    }

    const workflowName = details.parsed?.workflow?.name || details.parsed?.workflow?.file || "workflow"
    const targetBranch = details.parsed?.targetBranch || ""
    const runUrl = details.run?.url
    const openRunAction = "Open Run"
    const actions = runUrl ? [openRunAction] : []

    const selection = await vscode.window.showInformationMessage(
      `Deploy succeeded: ${workflowName}${targetBranch ? ` @ ${targetBranch}` : ""}`,
      ...actions
    )

    if (selection === openRunAction && runUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(runUrl))
    }

    if (runId) {
      const notifiedRunIds = this.context.globalState.get("notifiedDeploySuccessRunIds", [])
      await this.context.globalState.update("notifiedDeploySuccessRunIds", [
        ...notifiedRunIds.filter((id) => id !== runId).slice(-99),
        runId
      ])
    }
  }

  getHtml(webview) {
    const nonce = createNonce()
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css"))

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Pacvue Commerce Deploy</title>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">Pacvue Commerce</p>
        <h1>Deploy</h1>
      </div>
      <span class="status-pill" id="statusPill">Idle</span>
    </section>

    <section class="panel">
      <label>
        <span>Target branch</span>
        <select id="branch">
          <option value="">Loading branches...</option>
        </select>
      </label>

      <label>
        <span>Workflow</span>
        <select id="workflow">
          <option value="">Loading workflows...</option>
        </select>
      </label>

      <div id="dynamicInputs" class="grid"></div>

      <p class="cache-status" id="cacheStatus">Last config: not loaded</p>

      <div class="actions">
        <button id="runButton">Run</button>
        <button id="cancelButton" class="danger" disabled>Cancel</button>
      </div>
      <button id="savePresetButton" class="muted-action save-preset-btn">Save as Preset</button>
    </section>

    <details class="panel presets-panel" id="presetsPanel" hidden>
      <summary>Presets</summary>
      <div id="presetsList" class="presets-list"></div>
    </details>

    <details class="panel history-panel" id="historyPanel" hidden>
      <summary>Recent Deploys</summary>
      <div id="historyList" class="history-list"></div>
    </details>

    <section class="output" aria-live="polite">
      <div class="output-header">
        <span>Result</span>
        <button id="copyButton">Copy</button>
      </div>
      <pre id="output">Click Run to trigger the selected GitHub Actions workflow.</pre>
    </section>

    <div id="confirmOverlay" class="confirm-overlay" hidden>
      <div class="confirm-card panel">
        <p class="eyebrow">发版确认</p>
        <div id="confirmSummary" class="confirm-summary"></div>
        <div class="actions">
          <button id="confirmOkButton">Confirm Deploy</button>
          <button id="confirmCancelButton" class="danger">Cancel</button>
        </div>
      </div>
    </div>

    <div id="presetNameOverlay" class="confirm-overlay" hidden>
      <div class="confirm-card panel">
        <p class="eyebrow">保存预设</p>
        <label>
          <span>Preset name</span>
          <input id="presetNameInput" type="text" placeholder="e.g. 项目A测试环境">
        </label>
        <div class="actions">
          <button id="presetNameOkButton">Save</button>
          <button id="presetNameCancelButton" class="danger">Cancel</button>
        </div>
      </div>
    </div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function buildScriptArgs(scriptPath, form, action, { skipLastRunInputs = true } = {}) {
  const args = [
    scriptPath,
    "--branch",
    form.branch
  ]

  if (skipLastRunInputs) {
    args.push("--skip-last-run-inputs")
  }

  if (form.workflow) {
    args.push("--workflow", form.workflow)
  }

  for (const [key, value] of Object.entries(form.inputs || {})) {
    if (value === "") continue
    args.push("--input", `${key}=${value}`)
  }

  args.push(action === "dispatch" ? "--dispatch" : "--dry-run")
  return args
}

function getWorkspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
}

function findDeployScript(workspaceRoot, extensionRoot) {
  const candidates = [
    path.join(workspaceRoot, "pacvue-commerce-deploy-plugin", "scripts", "deploy-to-test.js"),
    path.resolve(extensionRoot, "..", "pacvue-commerce-deploy-plugin", "scripts", "deploy-to-test.js"),
    path.join(extensionRoot, "scripts", "deploy-to-test.js")
  ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function getWorkflowMetadata(scriptPath, workspaceRoot) {
  const result = runCommand("node", [scriptPath, "--list-workflows-json"], workspaceRoot)
  const parsed = parseJsonOutput(result.stdout)

  return {
    workflows: Array.isArray(parsed?.workflows) ? parsed.workflows : [],
    error: result.status === 0 ? null : result.stderr || parsed?.reason || "No Pacvue test deploy workflows were found."
  }
}

function getGitExecutable() {
  const configuredPath = vscode.workspace.getConfiguration("git").get("path")
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "cmd", "git.exe"),
      path.join(process.env.LocalAppData || "", "Programs", "Git", "cmd", "git.exe")
    ]
    const existing = candidates.find((candidate) => candidate && fs.existsSync(candidate))
    if (existing) return existing
  }

  return "git"
}

function applyGithubTokenToEnv(env) {
  if (String(env.GITHUB_TOKEN ?? "").trim() || String(env.GH_TOKEN ?? "").trim()) {
    return env
  }

  const configuredToken = String(vscode.workspace.getConfiguration("pacvueDeploy").get("githubToken") ?? "").trim()
  if (configuredToken) {
    env.GITHUB_TOKEN = configuredToken
  }

  return env
}

function getCommandEnv() {
  const env = applyGithubTokenToEnv({ ...process.env })

  if (process.platform !== "win32") {
    return env
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path"
  const extraPaths = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "cmd"),
    path.join(process.env.LocalAppData || "", "Programs", "Git", "cmd")
  ].filter((entry) => entry && fs.existsSync(entry))

  env[pathKey] = [...extraPaths, env[pathKey] || ""].filter(Boolean).join(path.delimiter)
  return env
}

function runGitCommand(args, cwd) {
  return runCommand(getGitExecutable(), args, cwd)
}

function splitCommandOutput(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, "").trim())
    .filter(Boolean)
}

function normalizeBranchName(branch) {
  return branch
    .replace(/^\*\s+/, "")
    .replace(/^remotes\//, "")
    .replace(/^origin\//, "")
    .trim()
}

function isValidBranchName(branch) {
  return Boolean(branch) && branch !== "HEAD" && branch !== "origin/HEAD" && !branch.includes("HEAD ->")
}

function parsePlainBranchOutput(stdout) {
  return splitCommandOutput(stdout).map(normalizeBranchName).filter(isValidBranchName)
}

function normalizeFsPath(value) {
  return path.normalize(String(value ?? "")).toLowerCase()
}

function findGitRepository(gitApi, workspaceRoot) {
  if (!gitApi?.repositories?.length) {
    return null
  }

  const normalizedRoot = normalizeFsPath(workspaceRoot)
  return (
    gitApi.repositories.find((repo) => {
      const repoRoot = normalizeFsPath(repo.rootUri.fsPath)
      return normalizedRoot === repoRoot || normalizedRoot.startsWith(`${repoRoot}${path.sep}`)
    }) || gitApi.repositories[0]
  )
}

function collectBranchNamesFromRefs(refs = []) {
  const branches = new Set()

  for (const ref of refs) {
    const normalized = normalizeBranchName(String(ref?.name ?? ""))
    if (isValidBranchName(normalized)) {
      branches.add(normalized)
    }
  }

  return branches
}

function buildEmptyBranchResult(error, diagnosis) {
  return {
    branches: [],
    currentBranch: "",
    error,
    debug: diagnosis?.technicalDetails ?? null,
    diagnosis
  }
}

function inspectGitWorkspace(workspaceRoot) {
  const git = getGitExecutable()
  const insideWorkTree = runGitCommand(["rev-parse", "--is-inside-work-tree"], workspaceRoot)
  const topLevel = runGitCommand(["rev-parse", "--show-toplevel"], workspaceRoot)
  const showCurrent = runGitCommand(["branch", "--show-current"], workspaceRoot)

  return {
    gitExecutable: git,
    gitExecutableExists: git === "git" ? null : fs.existsSync(git),
    isInsideWorkTree: insideWorkTree.status === 0 ? insideWorkTree.stdout.trim() : null,
    topLevel: topLevel.status === 0 ? topLevel.stdout.trim() : null,
    topLevelError: topLevel.status !== 0 ? (topLevel.stderr || topLevel.stdout).trim() : null,
    currentBranch: showCurrent.status === 0 ? showCurrent.stdout.trim() : null,
    currentBranchError: showCurrent.status !== 0 ? (showCurrent.stderr || showCurrent.stdout).trim() : null
  }
}

function buildBranchDiagnosis({ workspaceRoot, gitApiResult = null, spawnResult = null, gitInspect = null }) {
  const checks = []
  const suggestions = []
  let reason = "未能加载 Git 分支列表。"
  let category = "unknown"

  if (!workspaceRoot) {
    return {
      reason: "未打开文件夹工作区，扩展无法读取 Git 分支。",
      category: "no-workspace",
      checks: ["工作区路径: (empty)"],
      suggestions: [
        "使用 File > Open Folder 打开 Pacvue Commerce 仓库根目录（包含 .git 的目录）。",
        "不要只打开单个文件；需要打开整个仓库文件夹。",
        "打开后重新加载窗口，再打开 Pacvue Deploy 面板。"
      ],
      technicalDetails: { workspaceRoot: null }
    }
  }

  checks.push(`工作区路径: ${workspaceRoot}`)

  if (gitInspect) {
    checks.push(`Git 可执行文件: ${gitInspect.gitExecutable}`)
    if (gitInspect.gitExecutableExists === false) {
      checks.push("Git 可执行文件是否存在: false")
    }
    checks.push(`git rev-parse --is-inside-work-tree: ${gitInspect.isInsideWorkTree ?? "failed"}`)
    checks.push(`git rev-parse --show-toplevel: ${gitInspect.topLevel ?? gitInspect.topLevelError ?? "failed"}`)
    checks.push(`git branch --show-current: ${gitInspect.currentBranch ?? gitInspect.currentBranchError ?? "failed"}`)
  }

  const gitApiDebug = gitApiResult?.debug ?? null
  const gitSpawnDebug = spawnResult?.debug ?? null

  if (gitApiDebug) {
    checks.push(`VS Code Git API 来源: ${gitApiDebug.source ?? "git-api"}`)
    if (typeof gitApiDebug.repositoryCount === "number") {
      checks.push(`VS Code Git 扩展检测到的仓库数: ${gitApiDebug.repositoryCount}`)
    }
    if (gitApiDebug.repositoryRoot) {
      checks.push(`VS Code Git 仓库根目录: ${gitApiDebug.repositoryRoot}`)
    }
    if (typeof gitApiDebug.localRefCount === "number") {
      checks.push(`VS Code Git 本地分支数: ${gitApiDebug.localRefCount}`)
    }
    if (typeof gitApiDebug.remoteRefCount === "number") {
      checks.push(`VS Code Git 远程分支数: ${gitApiDebug.remoteRefCount}`)
    }
  } else if (gitApiResult === null) {
    checks.push("VS Code Git 扩展: 未找到 (vscode.git)")
  }

  if (gitSpawnDebug) {
    checks.push(`Git 命令来源: ${gitSpawnDebug.source ?? "git-spawn"}`)
    if (typeof gitSpawnDebug.forEachRefStatus === "number") {
      checks.push(`git for-each-ref 退出码: ${gitSpawnDebug.forEachRefStatus}`)
    }
    if (gitSpawnDebug.forEachRefStderr) {
      checks.push(`git for-each-ref 错误: ${gitSpawnDebug.forEachRefStderr}`)
    }
    if (typeof gitSpawnDebug.forEachRefStdoutLength === "number") {
      checks.push(`git for-each-ref 输出长度: ${gitSpawnDebug.forEachRefStdoutLength}`)
    }
    if (typeof gitSpawnDebug.localStatus === "number") {
      checks.push(`git branch --list 退出码: ${gitSpawnDebug.localStatus}`)
    }
    if (typeof gitSpawnDebug.remoteStatus === "number") {
      checks.push(`git branch -r --list 退出码: ${gitSpawnDebug.remoteStatus}`)
    }
    if (gitSpawnDebug.localStderr) {
      checks.push(`git branch --list 错误: ${gitSpawnDebug.localStderr}`)
    }
    if (gitSpawnDebug.remoteStderr) {
      checks.push(`git branch -r --list 错误: ${gitSpawnDebug.remoteStderr}`)
    }
  }

  const repositoryRoot = gitApiDebug?.repositoryRoot ?? gitInspect?.topLevel ?? null
  if (repositoryRoot && normalizeFsPath(repositoryRoot) !== normalizeFsPath(workspaceRoot)) {
    category = "workspace-mismatch"
    reason = "当前打开的文件夹与 Git 仓库根目录不一致，可能导致分支列表为空。"
    suggestions.push(`请改为打开 Git 仓库根目录: ${repositoryRoot}`)
    suggestions.push("在集成终端执行 git rev-parse --show-toplevel，确认路径与 VS Code 打开的工作区一致。")
  } else if (gitApiResult === null) {
    category = "git-extension-missing"
    reason = "未找到 VS Code 内置 Git 扩展，且 Git 命令 fallback 也未能读取分支。"
    suggestions.push("确认 Cursor / VS Code 已启用 Git 相关功能。")
    suggestions.push("Windows 可在设置 git.path 指向 git.exe，例如 C:\\Program Files\\Git\\cmd\\git.exe")
  } else if (gitApiDebug && typeof gitApiDebug.repositoryCount === "number" && gitApiDebug.repositoryCount === 0) {
    category = "no-git-repo"
    reason = "VS Code Git 扩展未识别当前工作区为 Git 仓库。"
    suggestions.push("确认打开的是包含 .git 的仓库根目录。")
    suggestions.push("查看左侧 Source Control 是否显示分支名；若没有，说明 IDE 也未识别此目录为 Git 仓库。")
  } else if (gitInspect?.isInsideWorkTree !== "true") {
    category = "not-git-worktree"
    reason = "当前工作区路径不在 Git 工作树内。"
    suggestions.push("在集成终端进入仓库根目录后执行 git rev-parse --show-toplevel。")
    suggestions.push("用 Open Folder 打开该命令输出的目录。")
  } else if (gitSpawnDebug?.forEachRefStderr || gitSpawnDebug?.localStderr || gitSpawnDebug?.remoteStderr) {
    const spawnMessage = gitSpawnDebug.forEachRefStderr || gitSpawnDebug.localStderr || gitSpawnDebug.remoteStderr || ""
    if (/enoent|not found|不是内部或外部命令|cannot find/i.test(spawnMessage)) {
      category = "git-not-found"
      reason = "扩展进程无法调用 Git 可执行文件（终端可用但 Extension Host 可能 PATH 不同）。"
      suggestions.push("在 VS Code / Cursor 设置中配置 git.path 为 git.exe 完整路径。")
      suggestions.push("配置后 Reload Window，再重新打开 Deploy 面板。")
    } else {
      category = "git-command-failed"
      reason = "Git 命令执行失败，无法读取分支列表。"
      suggestions.push("在 VS Code 集成终端执行 git branch --list 与 git for-each-ref --format=\"%(refname:short)\" refs/heads refs/remotes/origin 对比结果。")
    }
  } else if (gitApiDebug && gitApiDebug.localRefCount === 0 && gitApiDebug.remoteRefCount === 0) {
    category = "empty-repository"
    reason = "Git 仓库已识别，但未发现任何本地或远程分支。"
    suggestions.push("确认仓库已完成 clone 且存在 commits。")
    suggestions.push("尝试 git fetch --all 后再刷新面板。")
  } else {
    category = "empty-branch-list"
    reason = gitApiResult?.error || spawnResult?.error || "Git 命令与 VS Code Git API 均未返回可用分支。"
    suggestions.push("在集成终端确认 git branch --list 有输出。")
    suggestions.push("确认 VS Code 打开的工作区与终端执行命令的目录一致。")
    suggestions.push("Reload Window 后重试；若仍失败，将下方技术详情发给排查同事。")
  }

  if (!suggestions.length) {
    suggestions.push("在集成终端执行 git branch --list，确认分支存在。")
    suggestions.push("Reload Window 后重新打开 Pacvue Deploy 面板。")
  }

  return {
    reason,
    category,
    checks,
    suggestions,
    technicalDetails: {
      workspaceRoot,
      repositoryRoot,
      gitApiError: gitApiResult?.error ?? null,
      gitSpawnError: spawnResult?.error ?? null,
      gitApi: gitApiDebug,
      gitSpawn: gitSpawnDebug,
      gitInspect
    }
  }
}

async function getBranchOptionsFromGitApi(workspaceRoot) {
  const gitExtension = vscode.extensions.getExtension("vscode.git")
  if (!gitExtension) {
    return {
      branches: [],
      currentBranch: "",
      error: "VS Code Git extension (vscode.git) is not available.",
      debug: { source: "git-api", workspaceRoot, gitExtensionAvailable: false }
    }
  }

  if (!gitExtension.isActive) {
    await gitExtension.activate()
  }

  const gitApi = gitExtension.exports?.getAPI?.(1)
  const repository = findGitRepository(gitApi, workspaceRoot)
  if (!repository) {
    return {
      branches: [],
      currentBranch: "",
      error: "VS Code Git extension did not detect a repository for the open workspace.",
      debug: { source: "git-api", workspaceRoot, repositoryCount: gitApi?.repositories?.length ?? 0 }
    }
  }

  const [localRefs, remoteRefs] = await Promise.all([
    repository.getBranches({ remote: false }),
    repository.getBranches({ remote: true })
  ])
  const branches = collectBranchNamesFromRefs([...(localRefs ?? []), ...(remoteRefs ?? [])])
  const currentBranch = normalizeBranchName(repository.state?.HEAD?.name ?? "")

  if (currentBranch && isValidBranchName(currentBranch)) {
    branches.add(currentBranch)
  }

  return {
    branches: [...branches],
    currentBranch,
    error: branches.size ? null : "VS Code Git extension returned no branches for this repository.",
    debug: {
      source: "git-api",
      repositoryRoot: repository.rootUri.fsPath,
      localRefCount: localRefs?.length ?? 0,
      remoteRefCount: remoteRefs?.length ?? 0
    }
  }
}

function getBranchOptionsFromGitCommand(workspaceRoot, currentBranch = "") {
  const git = getGitExecutable()
  const normalizedCurrent = normalizeBranchName(currentBranch)
  const forEachRefResult = runCommand(
    git,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
    workspaceRoot
  )

  let branchNames = []
  if (forEachRefResult.status === 0 && forEachRefResult.stdout.trim()) {
    branchNames = splitCommandOutput(forEachRefResult.stdout).map(normalizeBranchName).filter(isValidBranchName)
  } else {
    const localResult = runCommand(git, ["branch", "--list"], workspaceRoot)
    const remoteResult = runCommand(git, ["branch", "-r", "--list"], workspaceRoot)

    if (localResult.status !== 0 && remoteResult.status !== 0) {
      const spawnError = localResult.stderr || remoteResult.stderr
      return {
        branches: normalizedCurrent ? [normalizedCurrent] : [],
        currentBranch: normalizedCurrent,
        error:
          spawnError ||
          "Failed to read Git branches. On Windows, install Git for Windows or set the VS Code setting `git.path` to git.exe.",
        debug: {
          source: "git-spawn",
          gitExecutable: git,
          workspaceRoot,
          forEachRefStatus: forEachRefResult.status,
          forEachRefStderr: forEachRefResult.stderr.trim(),
          forEachRefStdoutLength: forEachRefResult.stdout.length,
          localStatus: localResult.status,
          localStderr: localResult.stderr.trim(),
          remoteStatus: remoteResult.status,
          remoteStderr: remoteResult.stderr.trim()
        }
      }
    }

    branchNames = [...parsePlainBranchOutput(localResult.stdout), ...parsePlainBranchOutput(remoteResult.stdout)]
  }

  const resolvedCurrent =
    normalizedCurrent || normalizeBranchName(runGitCommand(["branch", "--show-current"], workspaceRoot).stdout)
  const branches = [...new Set([resolvedCurrent, ...branchNames].filter(isValidBranchName))]
  return {
    branches,
    currentBranch: resolvedCurrent,
    error: branches.length ? null : "No Git branches were found in this workspace.",
    debug: {
      source: "git-spawn",
      gitExecutable: git,
      workspaceRoot,
      forEachRefStatus: forEachRefResult.status,
      forEachRefStderr: forEachRefResult.stderr.trim(),
      forEachRefStdoutLength: forEachRefResult.stdout.length,
      localBranchCount: parsePlainBranchOutput(runCommand(git, ["branch", "--list"], workspaceRoot).stdout).length,
      remoteBranchCount: parsePlainBranchOutput(runCommand(git, ["branch", "-r", "--list"], workspaceRoot).stdout).length,
      branchCount: branches.length
    }
  }
}

async function getBranchOptions(workspaceRoot) {
  const gitInspect = inspectGitWorkspace(workspaceRoot)
  const gitApiResult = await getBranchOptionsFromGitApi(workspaceRoot)
  if (gitApiResult?.branches?.length) {
    return gitApiResult
  }

  const spawnResult = getBranchOptionsFromGitCommand(workspaceRoot, gitApiResult?.currentBranch ?? "")
  if (spawnResult.branches.length) {
    return spawnResult
  }

  const diagnosis = buildBranchDiagnosis({ workspaceRoot, gitApiResult, spawnResult, gitInspect })

  return {
    branches: [],
    currentBranch: gitApiResult?.currentBranch || spawnResult.currentBranch || gitInspect.currentBranch || "",
    error: diagnosis.reason,
    debug: diagnosis.technicalDetails,
    diagnosis
  }
}

function isWorkflowRunInProgress(status) {
  return ["queued", "in_progress", "waiting", "pending", "requested"].includes(status)
}

function getCompletedRunState(run) {
  if (run.conclusion === "success") return "success"
  if (run.conclusion === "cancelled") return "cancelled"
  return "failed"
}

function getCompletedRunMessage(state) {
  if (state === "success") return "Deploy workflow completed successfully."
  if (state === "cancelled") return "Deploy workflow was cancelled."
  return "Deploy workflow completed with a non-success conclusion."
}

function buildInputSources(cachedInputs, githubLastRunInputs) {
  const sources = {}
  Object.keys(cachedInputs || {}).forEach((key) => {
    sources[key] = "cache"
  })
  Object.keys(githubLastRunInputs || {}).forEach((key) => {
    sources[key] = "github"
  })
  return sources
}

function buildConfigSource(cachedInputs, githubLastRunInputs) {
  const cacheCount = Object.keys(cachedInputs || {}).length
  const githubCount = Object.keys(githubLastRunInputs || {}).length
  return {
    source: githubCount > 0 ? (cacheCount > 0 ? "mixed" : "github") : cacheCount > 0 ? "cache" : "none",
    cacheCount,
    githubCount
  }
}

async function getRunJobsSummaryForDiagnosis(workspaceRoot, run) {
  const runId = run?.databaseId
  if (!workspaceRoot || !runId) return null

  const transportOptions = getGithubTransportOptions()
  if (!hasGithubAuth(transportOptions)) return null

  return getWorkflowRunJobsSummary({
    repoRoot: workspaceRoot,
    runId,
    getConfiguredToken: transportOptions.getConfiguredToken,
    runGit: (repoRoot, args) => runGitCommand(args, repoRoot).stdout.trim()
  })
}

function buildFailureDiagnosis({ run, parsed, conclusion, jobsSummary }) {
  const jobs = Array.isArray(jobsSummary) ? jobsSummary : []
  return {
    conclusion: conclusion || "failure",
    stage: inferFailureStage(jobs, conclusion),
    likelyReason: inferLikelyReason(jobs, conclusion, parsed),
    workflowName: parsed?.workflow?.name || parsed?.workflow?.file || "Selected workflow",
    targetBranch: parsed?.targetBranch || "",
    runId: run?.databaseId ?? null,
    runUrl: run?.url ?? null,
    jobsSummary: jobs
  }
}

function inferFailureStage(jobsSummary, conclusion) {
  if (conclusion === "cancelled") return "Cancelled"
  const firstJob = jobsSummary?.[0]
  if (!firstJob) return "Workflow run"
  const firstStep = firstJob.failedSteps?.[0]
  return firstStep ? `${firstJob.name} > ${firstStep}` : firstJob.name
}

function inferLikelyReason(jobsSummary, conclusion, parsed) {
  if (conclusion === "cancelled") return "Workflow was cancelled before completion."
  const firstJob = jobsSummary?.[0]
  if (!firstJob) {
    return parsed?.reason || "Workflow completed with a non-success conclusion. Open the GitHub run for details."
  }

  const firstStep = firstJob.failedSteps?.[0]
  if (firstStep) return `Step "${firstStep}" failed in job "${firstJob.name}".`
  return `Job "${firstJob.name}" failed.`
}

function normalizeWorkflowFileForGh(workflowFile) {
  return String(workflowFile ?? "").trim().replace(/\\/g, "/")
}

function enrichDeployParsedResult(parsed, form) {
  const workflowFile = normalizeWorkflowFileForGh(parsed?.workflow?.file || form.workflow)
  const targetBranch = String(parsed?.targetBranch || form.branch || "").trim()

  if (!parsed && !workflowFile && !targetBranch) {
    return null
  }

  return {
    ...(parsed || {}),
    ok: parsed?.ok ?? Boolean(workflowFile && targetBranch && !(parsed?.missingRequiredInputs?.length)),
    targetBranch,
    workflow: {
      ...(parsed?.workflow || {}),
      file: workflowFile,
      name: parsed?.workflow?.name || workflowFile
    }
  }
}

function getGithubTransportOptions() {
  return {
    getConfiguredToken: () => vscode.workspace.getConfiguration("pacvueDeploy").get("githubToken"),
    runGit: (repoRoot, args) => runGitCommand(args, repoRoot).stdout.trim(),
    runGhCommand: (args, cwd) => runCommand("gh", args, cwd)
  }
}

function getIssueRepoFromPackage(context) {
  const repository = context.extension.packageJSON?.repository
  const repositoryUrl = typeof repository === "string" ? repository : repository?.url
  if (!repositoryUrl) {
    return ""
  }

  const match = String(repositoryUrl).match(/github\.com[:/]([^/]+)\/([^/.]+)/i)
  return match ? `${match[1]}/${match[2]}` : ""
}

function getCommerceRepoSlug(workspaceRoot, transportOptions) {
  if (!workspaceRoot) {
    return "unknown"
  }

  try {
    const repo = getGithubRepoInfo(workspaceRoot, transportOptions.runGit)
    return `${repo.owner}/${repo.repo}`
  } catch (_error) {
    return workspaceRoot
  }
}

const GITHUB_SNAPSHOT_TEXT_EXTENSIONS = new Set([".yml", ".yaml", ".json", ".md", ".sh", ".txt", ".xml", ".properties"])

function normalizeGithubSnapshotPath(filePath) {
  return String(filePath ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
}

function isLikelyGithubTextFile(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return GITHUB_SNAPSHOT_TEXT_EXTENSIONS.has(extension)
}

function collectGithubDirectorySnapshot(workspaceRoot, options = {}) {
  if (!workspaceRoot) {
    return { missing: true, files: [], totalDiscovered: 0 }
  }

  const githubDir = path.join(workspaceRoot, ".github")
  if (!fs.existsSync(githubDir)) {
    return { missing: true, files: [], totalDiscovered: 0 }
  }

  const discovered = []

  const walk = (directory) => {
    for (const entryName of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, entryName)
      const stats = fs.statSync(fullPath)

      if (stats.isDirectory()) {
        walk(fullPath)
        continue
      }

      if (!stats.isFile()) {
        continue
      }

      discovered.push({
        fullPath,
        path: normalizeGithubSnapshotPath(path.relative(workspaceRoot, fullPath)),
        size: stats.size
      })
    }
  }

  walk(githubDir)

  const priorityWorkflow = normalizeGithubSnapshotPath(options.priorityWorkflowFile)
  const priorityWorkflowBase = priorityWorkflow ? path.basename(priorityWorkflow) : ""
  const rankEntry = (entry) => {
    if (
      priorityWorkflow &&
      (entry.path === priorityWorkflow || path.basename(entry.path) === priorityWorkflowBase)
    ) {
      return 0
    }

    if (entry.path.startsWith(".github/workflows/")) {
      return 1
    }

    return 2
  }

  discovered.sort((left, right) => {
    const rankDiff = rankEntry(left) - rankEntry(right)
    return rankDiff !== 0 ? rankDiff : left.path.localeCompare(right.path)
  })

  const maxFiles = 40
  const maxFileChars = 12000
  const maxSectionChars = 45000
  const maxFileBytes = 200 * 1024
  const files = []
  let totalChars = 0

  for (const entry of discovered) {
    if (files.length >= maxFiles) {
      break
    }

    if (!isLikelyGithubTextFile(entry.fullPath)) {
      files.push({
        path: entry.path,
        content: null,
        skipped: "unsupported file type",
        size: entry.size
      })
      continue
    }

    if (entry.size > maxFileBytes) {
      files.push({
        path: entry.path,
        content: null,
        skipped: "file too large",
        size: entry.size
      })
      continue
    }

    let content = fs.readFileSync(entry.fullPath, "utf8")
    if (content.includes("\u0000")) {
      files.push({
        path: entry.path,
        content: null,
        skipped: "binary file",
        size: entry.size
      })
      continue
    }

    let truncated = false
    if (content.length > maxFileChars) {
      content = `${content.slice(0, maxFileChars)}\n... (truncated)`
      truncated = true
    }

    if (totalChars + content.length > maxSectionChars) {
      files.push({
        path: entry.path,
        content: null,
        skipped: "issue body size limit",
        size: entry.size
      })
      break
    }

    totalChars += content.length
    files.push({
      path: entry.path,
      content,
      truncated,
      size: entry.size
    })
  }

  return {
    missing: false,
    files,
    totalDiscovered: discovered.length
  }
}

async function getLatestWorkflowRunWithFallback(workspaceRoot, workflowFile, targetBranch) {
  return queryLatestWorkflowRun({
    repoRoot: workspaceRoot,
    workflowFile: normalizeWorkflowFileForGh(workflowFile),
    targetBranch,
    ...getGithubTransportOptions()
  })
}

async function cancelWorkflowRunWithFallback(workspaceRoot, runId) {
  return cancelWorkflowRun({
    repoRoot: workspaceRoot,
    runId,
    ...getGithubTransportOptions()
  })
}

function runCommand(command, args, cwd) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    env: getCommandEnv()
  })

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  }
}

function runCommandAsync(command, args, cwd) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      env: getCommandEnv()
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr: stderr || error.message })
    })
    child.on("close", (code) => {
      resolve({ status: code ?? 1, stdout, stderr })
    })
  })
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim()
  if (!text.startsWith("{")) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch (_error) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === "\\") {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
        continue
      }

      if (char === "{") {
        depth += 1
      }

      if (char === "}") {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(0, index + 1))
          } catch (_innerError) {
            return null
          }
        }
      }
    }

    return null
  }
}

function createNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let nonce = ""
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return nonce
}

module.exports = {
  activate,
  deactivate
}
