const https = require("node:https")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const GH_RUN_JSON_FIELDS = "id,status,conclusion,url,displayTitle,createdAt,updatedAt"

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  })
  return result.status === 0
}

function spawnGh(args) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    shell: process.platform === "win32"
  })
}

function isNpmGhToolError(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`
  return (
    /getAvailableArgsOnCmd/i.test(combined) ||
    /node_modules[\\/]+gh[\\/]/i.test(combined) ||
    /volta[\\/]tools[\\/]image[\\/]packages[\\/]gh/i.test(combined)
  )
}

function getWrongGhPackageRemediation() {
  return [
    "PATH 中的 gh 是 npm 包（常见于 Volta: .../packages/gh/node_modules/gh），不是 GitHub 官方 CLI。",
    "该 gh 无法执行 run list / workflow，会导致状态轮询失败。",
    "推荐：在 Cursor 设置 pacvueDeploy.githubToken（或环境变量 GITHUB_TOKEN），勾选 repo + workflow，然后 Reload Window。",
    "或安装官方 CLI：winget install --id GitHub.cli，并把官方 gh 排在 Volta npm gh 之前。"
  ].join("\n")
}

function formatGhPollError(stdout, stderr, fallback) {
  if (isNpmGhToolError(stdout, stderr)) {
    return getWrongGhPackageRemediation()
  }

  const preview = previewCommandOutput(stdout, stderr, 400)
  if (!preview || preview === "(empty)") {
    return fallback
  }

  return `Failed to query workflow run status via gh: ${preview}`
}

function inspectGhCli() {
  if (!commandExists("gh")) {
    return { present: false, official: false, looksLikeNpmGh: false }
  }

  const versionResult = spawnGh(["--version"])
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`.trim()

  if (/github\.com\/cli\/cli/i.test(versionText)) {
    return { present: true, official: true, looksLikeNpmGh: false, versionText }
  }

  const workflowHelp = spawnGh(["workflow", "list", "--help"])
  const helpText = `${workflowHelp.stdout}\n${workflowHelp.stderr}`
  const looksLikeNpmGh =
    isNpmGhToolError(workflowHelp.stdout, workflowHelp.stderr) ||
    (workflowHelp.status !== 0 && /getAvailableArgsOnCmd/i.test(helpText))

  const official =
    workflowHelp.status === 0 &&
    /workflow/i.test(helpText) &&
    !looksLikeNpmGh &&
    /^gh version \d+\.\d+/im.test(versionText)

  return { present: true, official, looksLikeNpmGh: looksLikeNpmGh || (!official && versionResult.status === 0), versionText }
}

function getGithubToken(options = {}) {
  const fromEnv = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim()
  if (fromEnv) {
    return fromEnv
  }

  if (typeof options.getConfiguredToken === "function") {
    return String(options.getConfiguredToken() ?? "").trim()
  }

  return ""
}

function canUseGithubCli() {
  return inspectGhCli().official
}

function canUseGithubApi(options = {}) {
  return Boolean(getGithubToken(options))
}

function hasGithubAuth(options = {}) {
  return canUseGithubApi(options) || canUseGithubCli()
}

function shouldUseGithubApiOnly(options = {}) {
  return !canUseGithubCli() && canUseGithubApi(options)
}

function getGithubAuthSummary(options = {}) {
  if (canUseGithubCli()) {
    return {
      mode: "github-cli",
      ready: true,
      label: "GitHub CLI (gh)",
      transport: "gh"
    }
  }

  if (canUseGithubApi(options)) {
    return {
      mode: "github-token",
      ready: true,
      label: "GitHub Token",
      transport: "github-api"
    }
  }

  const ghInspection = inspectGhCli()
  if (ghInspection.looksLikeNpmGh) {
    return {
      mode: "none",
      ready: false,
      label: "未配置（检测到 npm/Volta gh，请配置 Token）",
      transport: null
    }
  }

  return {
    mode: "none",
    ready: false,
    label: "未配置（需要官方 gh 或 GitHub Token）",
    transport: null
  }
}

function stripBom(text) {
  return String(text ?? "").replace(/^\uFEFF/, "")
}

function previewCommandOutput(stdout, stderr, maxLength = 240) {
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim()
  if (!combined) {
    return "(empty)"
  }

  return combined.length > maxLength ? `${combined.slice(0, maxLength)}...` : combined
}

function parseJsonArrayOutput(stdout) {
  const text = stripBom(String(stdout ?? "").trim())
  if (!text) {
    return null
  }

  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch (_error) {
    const start = text.indexOf("[")
    if (start === -1) {
      return null
    }

    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < text.length; index += 1) {
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

      if (char === "[") {
        depth += 1
      }

      if (char === "]") {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1))
            return Array.isArray(parsed) ? parsed : null
          } catch (_innerError) {
            return null
          }
        }
      }
    }

    return null
  }
}

function mapGhRun(run) {
  if (!run) {
    return null
  }

  return {
    databaseId: run.databaseId ?? run.id,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
    displayTitle: run.displayTitle ?? run.display_title ?? "",
    createdAt: run.createdAt ?? run.created_at,
    updatedAt: run.updatedAt ?? run.updated_at
  }
}

function normalizeWorkflowFileForApi(workflowFile) {
  return path.basename(String(workflowFile ?? "").trim().replace(/\\/g, "/"))
}

function getWorkflowCandidates(workflowFile) {
  const normalized = normalizeWorkflowFileForApi(workflowFile)
  const fullPath = String(workflowFile ?? "").trim().replace(/\\/g, "/")
  return [...new Set([fullPath, normalized].filter(Boolean))]
}

function buildGithubApiConfig(host, owner, repo) {
  const normalizedHost = String(host ?? "").trim().toLowerCase()
  const normalizedRepo = String(repo ?? "").replace(/\.git$/i, "")

  if (normalizedHost === "github.com") {
    return {
      owner,
      repo: normalizedRepo,
      apiHostname: "api.github.com",
      apiPathPrefix: ""
    }
  }

  return {
    owner,
    repo: normalizedRepo,
    apiHostname: host,
    apiPathPrefix: "/api/v3"
  }
}

function parseGithubRemoteUrl(remoteUrl) {
  const trimmed = String(remoteUrl ?? "").trim()
  if (!trimmed) {
    return null
  }

  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch) {
    return buildGithubApiConfig(sshMatch[1], sshMatch[2], sshMatch[3])
  }

  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (httpsMatch) {
    return buildGithubApiConfig(httpsMatch[1], httpsMatch[2], httpsMatch[3])
  }

  return null
}

function buildRepoApiPath(apiConfig, suffix) {
  return `${apiConfig.apiPathPrefix}/repos/${encodeURIComponent(apiConfig.owner)}/${encodeURIComponent(apiConfig.repo)}${suffix}`
}

function shouldFallbackToGhAfterApiError(error) {
  return /not found/i.test(String(error ?? "")) || /\b404\b/.test(String(error ?? ""))
}

function formatApiWorkflowNotFoundError(apiConfig, workflowFile, rawMessage) {
  const workflowLabel = path.basename(String(workflowFile ?? "").replace(/\\/g, "/")) || "workflow"
  return [
    rawMessage || "Not Found",
    `GitHub API could not find workflow "${workflowLabel}" in ${apiConfig.owner}/${apiConfig.repo} (${apiConfig.apiHostname}).`,
    "Check that pacvueDeploy.githubToken can access this repo (repo + workflow) and matches your git origin host.",
    "If deploy was triggered via gh, ensure official GitHub CLI is installed for status polling."
  ].join(" ")
}

function workflowPathMatches(workflowPath, workflowFile) {
  const normalizedFile = String(workflowFile ?? "").trim().replace(/\\/g, "/")
  const normalizedPath = String(workflowPath ?? "").trim().replace(/\\/g, "/")
  const basename = path.basename(normalizedFile)

  return (
    normalizedPath === normalizedFile ||
    normalizedPath.endsWith(`/${basename}`) ||
    normalizedPath.endsWith(normalizedFile)
  )
}

async function buildWorkflowApiIdCandidates(apiConfig, workflowFile, token) {
  const normalizedFile = String(workflowFile ?? "").trim().replace(/\\/g, "/")
  const basename = normalizeWorkflowFileForApi(workflowFile)
  const candidates = []

  const listResponse = await githubApiRequest(
    "GET",
    `${buildRepoApiPath(apiConfig, "/actions/workflows")}?per_page=100`,
    null,
    token,
    apiConfig
  )

  if (listResponse.ok) {
    const matchedWorkflow = (listResponse.body?.workflows ?? []).find((workflow) => workflowPathMatches(workflow.path, workflowFile))
    if (matchedWorkflow?.id) {
      candidates.push(String(matchedWorkflow.id))
    }
  }

  if (basename) {
    candidates.push(basename)
  }

  if (normalizedFile && normalizedFile !== basename) {
    candidates.push(normalizedFile)
  }

  return [...new Set(candidates.filter(Boolean))]
}

function getGithubRepoInfo(repoRoot, runGit) {
  const remoteUrl = runGit(repoRoot, ["remote", "get-url", "origin"])
  const repo = parseGithubRemoteUrl(remoteUrl)
  if (!repo) {
    throw new Error(`Could not parse GitHub owner/repo from origin remote: ${remoteUrl || "(empty)"}`)
  }

  return repo
}

function githubApiRequest(method, apiPath, body, token, apiConfig = buildGithubApiConfig("github.com", "", "")) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ""
    const request = https.request(
      {
        hostname: apiConfig.apiHostname,
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "pacvue-commerce-deploy-extension",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
              }
            : {})
        }
      },
      (response) => {
        let raw = ""
        response.on("data", (chunk) => {
          raw += chunk
        })
        response.on("end", () => {
          let parsed = null
          if (raw) {
            try {
              parsed = JSON.parse(raw)
            } catch (_error) {
              parsed = raw
            }
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode ?? 0,
            body: parsed
          })
        })
      }
    )

    request.on("error", reject)
    if (payload) {
      request.write(payload)
    }
    request.end()
  })
}

function buildDispatchInputs(resolvedInputs, branchInputName, targetBranch) {
  const inputs = { ...(resolvedInputs ?? {}) }
  if (branchInputName) {
    inputs[branchInputName] = targetBranch
  }
  return inputs
}

function getGithubApiErrorRemediation(reason) {
  const message = String(reason ?? "")
  if (!/organization SAML enforcement/i.test(message)) {
    return null
  }

  return [
    "Personal Access Token 尚未为 Pacvue 组织完成 SAML SSO 授权（与 workflow 参数无关）。",
    "Token 方式修复：",
    "  1. 打开 https://github.com/settings/tokens",
    "  2. 找到 pacvueDeploy.githubToken / GITHUB_TOKEN 对应的 Token",
    "  3. 点击 Configure SSO 或 Enable SSO，在 Pacvue 旁 Authorize 并完成企业 SSO",
    "  4. Cursor Reload Window 后重新 Run",
    "或改用官方 GitHub CLI（登录时会处理 SSO）：",
    "  macOS: brew install gh && gh auth login",
    "  Windows: winget install --id GitHub.cli && gh auth login"
  ]
}

function buildGithubApiDispatchPreview({ apiConfig, workflowFile, refBranch, inputs }) {
  const workflowId = normalizeWorkflowFileForApi(workflowFile)
  return `GitHub API POST ${buildRepoApiPath(apiConfig, `/actions/workflows/${workflowId}/dispatches`)} ref=${refBranch} inputs=${JSON.stringify(inputs)}`
}

async function dispatchWorkflowViaApi({ apiConfig, workflowFile, refBranch, inputs, token }) {
  const workflowIds = await buildWorkflowApiIdCandidates(apiConfig, workflowFile, token)
  let lastMessage = "GitHub API dispatch failed."

  for (const workflowId of workflowIds) {
    const response = await githubApiRequest(
      "POST",
      buildRepoApiPath(apiConfig, `/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`),
      {
        ref: refBranch,
        inputs
      },
      token,
      apiConfig
    )

    if (response.ok) {
      return { ok: true, transport: "github-api" }
    }

    lastMessage = response.body?.message || `GitHub API dispatch failed with status ${response.statusCode}.`
    if (response.statusCode !== 404) {
      break
    }
  }

  const remediation = getGithubApiErrorRemediation(lastMessage)
  return {
    ok: false,
    reason: lastMessage,
    transport: "github-api",
    ...(remediation ? { remediation } : {})
  }
}

function mapGithubRun(run) {
  return {
    databaseId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    displayTitle: run.display_title || run.name || "",
    createdAt: run.created_at,
    updatedAt: run.updated_at
  }
}

async function getLatestWorkflowRunViaApi({ apiConfig, workflowFile, targetBranch, token }) {
  const workflowIds = await buildWorkflowApiIdCandidates(apiConfig, workflowFile, token)
  let lastMessage = "GitHub API run lookup failed."

  for (const workflowId of workflowIds) {
    const response = await githubApiRequest(
      "GET",
      `${buildRepoApiPath(apiConfig, `/actions/workflows/${encodeURIComponent(workflowId)}/runs`)}?branch=${encodeURIComponent(targetBranch)}&per_page=1`,
      null,
      token,
      apiConfig
    )

    if (!response.ok) {
      lastMessage = response.body?.message || `GitHub API run lookup failed with status ${response.statusCode}.`
      if (response.statusCode === 404) {
        continue
      }

      return { ok: false, error: lastMessage }
    }

    const run = response.body?.workflow_runs?.[0]
    if (!run) {
      return { ok: false, error: "Workflow run has not appeared yet. Next status check runs in 1 minute." }
    }

    return { ok: true, transport: "github-api", ...mapGithubRun(run) }
  }

  return {
    ok: false,
    error: formatApiWorkflowNotFoundError(apiConfig, workflowFile, lastMessage)
  }
}

async function getLastSuccessfulRunInputsViaApi({ apiConfig, workflowFile, targetBranch, token, parseDisplayTitle }) {
  const workflowIds = await buildWorkflowApiIdCandidates(apiConfig, workflowFile, token)

  for (const workflowId of workflowIds) {
    const response = await githubApiRequest(
      "GET",
      `${buildRepoApiPath(apiConfig, `/actions/workflows/${encodeURIComponent(workflowId)}/runs`)}?branch=${encodeURIComponent(targetBranch)}&status=success&per_page=20`,
      null,
      token,
      apiConfig
    )

    if (!response.ok) {
      continue
    }

    const runs = response.body?.workflow_runs ?? []
    const matchingRun =
      runs.find((run) => String(run.display_title || "").includes(`分支:${targetBranch}`)) || runs[0]

    return parseDisplayTitle(matchingRun?.display_title || "")
  }

  return {}
}

async function cancelWorkflowRunViaApi({ apiConfig, runId, token }) {
  const response = await githubApiRequest(
    "POST",
    buildRepoApiPath(apiConfig, `/actions/runs/${encodeURIComponent(String(runId))}/cancel`),
    null,
    token,
    apiConfig
  )

  if (!response.ok) {
    return {
      ok: false,
      error: response.body?.message || `GitHub API cancel failed with status ${response.statusCode}.`
    }
  }

  return { ok: true, transport: "github-api" }
}

function getLatestWorkflowRunViaGh({ workflowFile, targetBranch, runGhCommand, cwd }) {
  const workflowCandidates = getWorkflowCandidates(workflowFile)
  let lastError = "Failed to query workflow run status."

  for (const workflow of workflowCandidates) {
    const result = runGhCommand(
      [
        "run",
        "list",
        "--workflow",
        workflow,
        "--branch",
        targetBranch,
        "--limit",
        "1",
        "--json",
        GH_RUN_JSON_FIELDS
      ],
      cwd
    )

    if (result.status !== 0) {
      lastError = formatGhPollError(result.stdout, result.stderr, lastError)
      continue
    }

    const runs = parseJsonArrayOutput(result.stdout)
    if (!runs) {
      lastError = formatGhPollError(result.stdout, result.stderr, "Failed to parse gh run list output.")
      continue
    }

    const mappedRun = mapGhRun(runs[0])
    if (!mappedRun?.databaseId) {
      lastError = "Workflow run has not appeared yet. Next status check runs in 1 minute."
      continue
    }

    return { ok: true, transport: "gh", ...mappedRun }
  }

  return { ok: false, error: lastError }
}

async function queryLatestWorkflowRunViaApiWithRepo({ repoRoot, workflowFile, targetBranch, getConfiguredToken, runGit }) {
  const tokenOptions = { getConfiguredToken }
  if (!canUseGithubApi(tokenOptions)) {
    return null
  }

  try {
    const repo = getGithubRepoInfo(repoRoot, runGit)
    return await getLatestWorkflowRunViaApi({
      apiConfig: repo,
      workflowFile,
      targetBranch,
      token: getGithubToken(tokenOptions)
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to query workflow run status via GitHub API."
    }
  }
}

async function queryLatestWorkflowRun({ repoRoot, workflowFile, targetBranch, runGhCommand, getConfiguredToken, runGit }) {
  const tokenOptions = { getConfiguredToken }
  const hasToken = canUseGithubApi(tokenOptions)
  const hasOfficialGh = canUseGithubCli()
  let lastError = null

  if (hasToken) {
    const apiResult = await queryLatestWorkflowRunViaApiWithRepo({
      repoRoot,
      workflowFile,
      targetBranch,
      getConfiguredToken,
      runGit
    })

    if (apiResult?.ok) {
      return apiResult
    }

    lastError = apiResult?.error ?? null

    if (!hasOfficialGh || !shouldFallbackToGhAfterApiError(lastError)) {
      return {
        ok: false,
        error: lastError || "Failed to query workflow run status via GitHub API."
      }
    }
  }

  if (hasOfficialGh && typeof runGhCommand === "function") {
    const ghResult = getLatestWorkflowRunViaGh({
      workflowFile,
      targetBranch,
      runGhCommand,
      cwd: repoRoot
    })

    if (ghResult.ok) {
      return ghResult
    }

    lastError = ghResult.error || lastError
  } else if (!hasToken && inspectGhCli().looksLikeNpmGh) {
    return { ok: false, error: getWrongGhPackageRemediation() }
  }

  if (!hasToken && !hasOfficialGh) {
    return {
      ok: false,
      error:
        lastError ||
        "Install GitHub CLI (gh) or configure pacvueDeploy.githubToken / GITHUB_TOKEN to poll workflow status."
    }
  }

  return {
    ok: false,
    error: lastError || "Failed to query workflow run status."
  }
}

async function cancelWorkflowRun({ repoRoot, runId, runGhCommand, getConfiguredToken, runGit }) {
  const tokenOptions = { getConfiguredToken }
  const hasToken = canUseGithubApi(tokenOptions)
  const hasOfficialGh = canUseGithubCli()
  let lastError = null

  if (hasToken) {
    try {
      const repo = getGithubRepoInfo(repoRoot, runGit)
      const apiResult = await cancelWorkflowRunViaApi({
        apiConfig: repo,
        runId,
        token: getGithubToken(tokenOptions)
      })

      if (apiResult.ok) {
        return apiResult
      }

      lastError = apiResult.error
      if (!hasOfficialGh) {
        return { ok: false, error: lastError }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Failed to cancel workflow run via GitHub API."
      if (!hasOfficialGh) {
        return { ok: false, error: lastError }
      }
    }
  }

  if (hasOfficialGh && typeof runGhCommand === "function") {
    const result = runGhCommand(["run", "cancel", String(runId)], repoRoot)
    if (result.status === 0) {
      return { ok: true, transport: "gh" }
    }

    lastError = formatGhPollError(result.stdout, result.stderr, lastError || "Failed to cancel workflow run via gh.")
  } else if (!hasToken && inspectGhCli().looksLikeNpmGh) {
    return { ok: false, error: getWrongGhPackageRemediation() }
  }

  if (!hasToken && !hasOfficialGh) {
    return {
      ok: false,
      error:
        lastError ||
        "Install GitHub CLI (gh) or configure pacvueDeploy.githubToken / GITHUB_TOKEN to cancel workflow runs."
    }
  }

  return {
    ok: false,
    error: lastError || "Failed to cancel workflow run."
  }
}

async function getLastSuccessfulRunInputs({ repoRoot, workflowFile, targetBranch, runGhCommand, runGit, parseDisplayTitle }) {
  if (canUseGithubCli() && typeof runGhCommand === "function") {
    const workflowName = normalizeWorkflowFileForApi(workflowFile)
    const result = runGhCommand(
      ["run", "list", "--workflow", workflowName, "--status=success", "--limit", "20", "--json", "displayTitle"],
      repoRoot
    )

    if (result.status === 0) {
      const runs = parseJsonArrayOutput(result.stdout)
      if (runs?.length) {
        const matchingRun = runs.find((run) => run.displayTitle?.includes(`分支:${targetBranch}`)) || runs[0]
        return parseDisplayTitle(matchingRun?.displayTitle || "")
      }
    }
  }

  if (!canUseGithubApi()) {
    return {}
  }

  try {
    const repo = getGithubRepoInfo(repoRoot, runGit)
    return await getLastSuccessfulRunInputsViaApi({
      apiConfig: repo,
      workflowFile,
      targetBranch,
      token: getGithubToken(),
      parseDisplayTitle
    })
  } catch (_error) {
    return {}
  }
}

function getMissingGithubAuthPayload() {
  return {
    ok: false,
    reason: "未检测到可用的 GitHub 认证方式，无法触发 GitHub Actions workflow。",
    remediation: [
      "方案 A：安装 GitHub 官方 CLI（不是 npm 包 gh）",
      "  Windows: winget install --id GitHub.cli",
      "  macOS: brew install gh",
      "  安装后执行: gh auth login",
      "  若 Volta 装有 npm gh，请把官方 gh 排在 PATH 前面",
      "方案 B：不安装 gh，改用 GitHub Token",
      "  1. 在 GitHub Settings > Developer settings > Personal access tokens 创建 Token",
      "  2. 勾选 repo 与 workflow 权限",
      "  3. 设置环境变量 GITHUB_TOKEN，或在 VS Code / Cursor 设置 pacvueDeploy.githubToken",
      "  4. Reload Window 后重试"
    ]
  }
}

function parseOwnerRepoSlug(repoSlug) {
  const match = String(repoSlug ?? "")
    .trim()
    .match(/^([^/]+)\/([^/]+)$/)

  if (!match) {
    throw new Error(`Invalid GitHub repository slug: ${repoSlug || "(empty)"}`)
  }

  return buildGithubApiConfig("github.com", match[1], match[2].replace(/\.git$/i, ""))
}

function buildDeployFailureIssueTitle(payload) {
  const workflowName = payload.parsed?.workflow?.name || payload.parsed?.workflow?.file || "workflow"
  const targetBranch = payload.parsed?.targetBranch || payload.targetBranch || "unknown-branch"
  const runId = payload.run?.databaseId

  if (payload.failureType === "trigger") {
    return `[auto-triage] Deploy trigger failed: ${workflowName} @ ${targetBranch}`
  }

  return `[auto-triage] Deploy failed: ${workflowName} @ ${targetBranch}${runId ? ` (run #${runId})` : ""}`
}

function getGithubFileFenceLanguage(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase()

  if (ext === ".yml" || ext === ".yaml") {
    return "yaml"
  }

  if (ext === ".json") {
    return "json"
  }

  if (ext === ".sh") {
    return "bash"
  }

  if (ext === ".md") {
    return "markdown"
  }

  return "text"
}

function buildGithubFilesIssueSection(githubSnapshot) {
  if (!githubSnapshot || githubSnapshot.missing) {
    return "_No `.github` directory found in the current workspace._"
  }

  if (!Array.isArray(githubSnapshot.files) || !githubSnapshot.files.length) {
    return "_No readable files found under `.github`._"
  }

  const sections = githubSnapshot.files.map((file) => {
    if (!file.content) {
      return `### \`${file.path}\`\n\n_Skipped: ${file.skipped || "unavailable"} (${file.size ?? 0} bytes)._`
    }

    const lang = getGithubFileFenceLanguage(file.path)
    const truncatedNote = file.truncated ? "\n\n_Content truncated for issue size limits._" : ""

    return `### \`${file.path}\`${truncatedNote}\n\n\`\`\`${lang}\n${file.content}\n\`\`\``
  })

  const footer =
    typeof githubSnapshot.totalDiscovered === "number" && githubSnapshot.totalDiscovered > githubSnapshot.files.length
      ? `\n\n_Showing ${githubSnapshot.files.length} of ${githubSnapshot.totalDiscovered} files under \`.github\`._`
      : ""

  return `${sections.join("\n\n")}${footer}`
}

function buildDeployFailureIssueBody(payload) {
  const workflowFile = payload.parsed?.workflow?.file || ""
  const workflowName = payload.parsed?.workflow?.name || workflowFile || "unknown"
  const targetBranch = payload.parsed?.targetBranch || payload.targetBranch || ""
  const commerceRepo = payload.commerceRepo || "unknown"
  const runUrl = payload.run?.url || ""
  const conclusion = payload.run?.conclusion || payload.conclusion || ""
  const errorMessage = payload.message || payload.error || ""
  const command = payload.command || ""
  const jobsSummary = Array.isArray(payload.jobsSummary) ? payload.jobsSummary : []
  const githubSnapshot = payload.githubSnapshot ?? null

  const failedStepsBlock =
    jobsSummary.length > 0
      ? jobsSummary
          .map((job) => {
            const failedSteps = Array.isArray(job.failedSteps) ? job.failedSteps.join(", ") : ""
            return `- **${job.name}** (${job.conclusion || "unknown"})${failedSteps ? `: ${failedSteps}` : ""}`
          })
          .join("\n")
      : "_No failed job details were available from GitHub Actions API._"

  const structuredPayload = {
    type: payload.failureType === "trigger" ? "deploy_trigger_failure" : "deploy_run_failure",
    commerceRepo,
    workflow: workflowFile,
    workflowName,
    targetBranch,
    runId: payload.run?.databaseId ?? null,
    runUrl: runUrl || null,
    conclusion: conclusion || null,
    command: command || null,
    errorMessage: errorMessage || null,
    extensionVersion: payload.extensionVersion || null,
    reportedAt: new Date().toISOString(),
    githubFiles: Array.isArray(githubSnapshot?.files)
      ? githubSnapshot.files.map((file) => ({
          path: file.path,
          size: file.size ?? null,
          truncated: Boolean(file.truncated),
          skipped: file.skipped || null
        }))
      : []
  }

  return [
    "## Summary",
    payload.failureType === "trigger"
      ? "Pacvue Deploy failed to trigger the GitHub Actions workflow."
      : "Pacvue Deploy workflow run completed with a non-success result.",
    "",
    "## Context",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Commerce repo | \`${commerceRepo}\` |`,
    `| Workflow | \`${workflowName}\` |`,
    `| Workflow file | \`${workflowFile || "n/a"}\` |`,
    `| Target branch | \`${targetBranch || "n/a"}\` |`,
    runUrl ? `| Run URL | ${runUrl} |` : "| Run URL | n/a |",
    conclusion ? `| Conclusion | \`${conclusion}\` |` : null,
    "",
    "## Error",
    "",
    "```text",
    errorMessage || "(no error message captured)",
    "```",
    "",
    "## Failed jobs",
    "",
    failedStepsBlock,
    "",
    "## Project `.github` configuration",
    "",
    buildGithubFilesIssueSection(githubSnapshot),
    "",
    command
      ? ["## Command", "", "```bash", command, "```", ""].join("\n")
      : null,
    "## Payload",
    "",
    "```json",
    JSON.stringify(structuredPayload, null, 2),
    "```",
    "",
    "_Auto-created by Pacvue Commerce Deploy extension. Label or assign for agent triage._"
  ]
    .filter(Boolean)
    .join("\n")
}

async function getWorkflowRunJobsSummary({ repoRoot, runId, getConfiguredToken, runGit }) {
  const tokenOptions = { getConfiguredToken }
  if (!canUseGithubApi(tokenOptions) || !runId) {
    return null
  }

  try {
    const apiConfig = getGithubRepoInfo(repoRoot, runGit)
    const response = await githubApiRequest(
      "GET",
      buildRepoApiPath(apiConfig, `/actions/runs/${encodeURIComponent(String(runId))}/jobs`),
      null,
      getGithubToken(tokenOptions),
      apiConfig
    )

    if (!response.ok) {
      return null
    }

    return (response.body?.jobs ?? [])
      .map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        failedSteps: (job.steps ?? []).filter((step) => step.conclusion === "failure").map((step) => step.name)
      }))
      .filter((job) => job.conclusion === "failure" || job.failedSteps.length > 0)
  } catch (_error) {
    return null
  }
}

async function createDeployFailureIssue({ issueRepoSlug, payload, getConfiguredToken, runGhCommand }) {
  const tokenOptions = { getConfiguredToken }
  const title = buildDeployFailureIssueTitle(payload)
  const body = buildDeployFailureIssueBody(payload)

  if (canUseGithubApi(tokenOptions)) {
    try {
      const apiConfig = parseOwnerRepoSlug(issueRepoSlug)
      const response = await githubApiRequest(
        "POST",
        buildRepoApiPath(apiConfig, "/issues"),
        { title, body },
        getGithubToken(tokenOptions),
        apiConfig
      )

      if (response.ok) {
        return {
          ok: true,
          transport: "github-api",
          issueNumber: response.body?.number,
          issueUrl: response.body?.html_url
        }
      }

      return {
        ok: false,
        error: response.body?.message || `GitHub API issue create failed with status ${response.statusCode}.`
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to create deploy failure issue via GitHub API."
      }
    }
  }

  if (canUseGithubCli() && typeof runGhCommand === "function") {
    const result = runGhCommand(
      ["issue", "create", "--repo", issueRepoSlug, "--title", title, "--body", body],
      process.cwd()
    )

    if (result.status === 0) {
      const issueUrl = String(result.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^https?:\/\//i.test(line))

      return {
        ok: true,
        transport: "gh",
        issueUrl: issueUrl || null
      }
    }

    return {
      ok: false,
      error: previewCommandOutput(result.stdout, result.stderr, "Failed to create deploy failure issue via gh.")
    }
  }

  return {
    ok: false,
    error: "Configure pacvueDeploy.githubToken or install official GitHub CLI to create deploy failure issues."
  }
}

module.exports = {
  buildDeployFailureIssueBody,
  buildDeployFailureIssueTitle,
  buildGithubFilesIssueSection,
  buildDispatchInputs,
  buildGithubApiDispatchPreview,
  cancelWorkflowRun,
  createDeployFailureIssue,
  cancelWorkflowRunViaApi,
  canUseGithubApi,
  canUseGithubCli,
  commandExists,
  inspectGhCli,
  dispatchWorkflowViaApi,
  getGithubRepoInfo,
  getGithubAuthSummary,
  getGithubToken,
  getLastSuccessfulRunInputs,
  getWorkflowRunJobsSummary,
  getLatestWorkflowRunViaApi,
  getLatestWorkflowRunViaGh,
  getMissingGithubAuthPayload,
  hasGithubAuth,
  mapGhRun,
  normalizeWorkflowFileForApi,
  parseGithubRemoteUrl,
  parseOwnerRepoSlug,
  parseJsonArrayOutput,
  queryLatestWorkflowRun,
  queryLatestWorkflowRunViaApiWithRepo,
  shouldUseGithubApiOnly
}
