/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi()

const elements = {
  branch: document.getElementById("branch"),
  workflow: document.getElementById("workflow"),
  dynamicInputs: document.getElementById("dynamicInputs"),
  runButton: document.getElementById("runButton"),
  cancelButton: document.getElementById("cancelButton"),
  copyButton: document.getElementById("copyButton"),
  output: document.getElementById("output"),
  statusPill: document.getElementById("statusPill")
}

let workflows = []
let currentBranch = ""
const searchableSelects = new WeakMap()

function getSelectedWorkflow() {
  return workflows.find((workflow) => workflow.file === elements.workflow.value) || workflows[0] || null
}

function getForm() {
  const inputs = {}
  elements.dynamicInputs.querySelectorAll("[data-input-name]").forEach((field) => {
    inputs[field.dataset.inputName] = field.value.trim()
  })

  return {
    branch: elements.branch.value.trim(),
    workflow: elements.workflow.value,
    inputs
  }
}

function setStatus(text, variant = "idle") {
  elements.statusPill.textContent = text
  elements.statusPill.dataset.variant = variant
}

function setBusy(isBusy) {
  elements.runButton.disabled = isBusy
  elements.cancelButton.disabled = !isBusy
}

function setDeployEnabled(isEnabled) {
  elements.branch.disabled = !isEnabled
  elements.workflow.disabled = !isEnabled
  setSearchableSelectDisabled(elements.branch, !isEnabled)
  setSearchableSelectDisabled(elements.workflow, !isEnabled)
  elements.runButton.disabled = !isEnabled
  elements.cancelButton.disabled = true
}

function writeOutput(value) {
  elements.output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function createOption(value, label = value) {
  const option = document.createElement("option")
  option.value = value
  option.textContent = label
  return option
}

function getSelectedOptionLabel(select) {
  return select.selectedOptions[0]?.textContent || select.value || "Select..."
}

function closeSearchableSelect(select) {
  const state = searchableSelects.get(select)
  if (!state) return

  state.wrapper.classList.remove("open")
  state.menu.hidden = true
}

function closeOtherSearchableSelects(activeSelect) {
  document.querySelectorAll(".searchable-select.open").forEach((wrapper) => {
    const select = wrapper.previousElementSibling
    if (select && select !== activeSelect) {
      closeSearchableSelect(select)
    }
  })
}

function renderSearchableOptions(select) {
  const state = searchableSelects.get(select)
  if (!state) return

  const query = state.search.value.trim().toLowerCase()
  const matchingOptions = Array.from(select.options).filter((option) => !query || option.textContent.toLowerCase().includes(query) || option.value.toLowerCase().includes(query))

  state.list.replaceChildren()
  if (!matchingOptions.length) {
    const empty = document.createElement("div")
    empty.className = "searchable-empty"
    empty.textContent = "No matches"
    state.list.appendChild(empty)
    return
  }

  matchingOptions.forEach((option) => {
    const item = document.createElement("button")
    item.type = "button"
    item.className = "searchable-option"
    item.textContent = option.textContent
    item.dataset.selected = String(option.value === select.value)
    item.addEventListener("click", () => {
      select.value = option.value
      select.dispatchEvent(new Event("change"))
      closeSearchableSelect(select)
    })
    state.list.appendChild(item)
  })
}

function syncSearchableSelect(select) {
  const state = searchableSelects.get(select)
  if (!state) return

  state.trigger.textContent = getSelectedOptionLabel(select)
  state.trigger.disabled = select.disabled
  renderSearchableOptions(select)
}

function setSearchableSelectDisabled(select, isDisabled) {
  const state = searchableSelects.get(select)
  if (state) {
    state.trigger.disabled = isDisabled
  }
}

function enhanceSearchableSelect(select, searchPlaceholder = "Search...") {
  if (searchableSelects.has(select)) {
    syncSearchableSelect(select)
    return
  }

  select.classList.add("native-select")
  const wrapper = document.createElement("div")
  wrapper.className = "searchable-select"

  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "searchable-trigger"

  const menu = document.createElement("div")
  menu.className = "searchable-menu"
  menu.hidden = true

  const search = document.createElement("input")
  search.type = "search"
  search.className = "searchable-input"
  search.placeholder = searchPlaceholder

  const list = document.createElement("div")
  list.className = "searchable-list"

  menu.append(search, list)
  wrapper.append(trigger, menu)
  select.after(wrapper)

  searchableSelects.set(select, { wrapper, trigger, menu, search, list })

  trigger.addEventListener("click", () => {
    const isOpen = wrapper.classList.contains("open")
    closeOtherSearchableSelects(select)
    wrapper.classList.toggle("open", !isOpen)
    menu.hidden = isOpen
    if (!isOpen) {
      search.value = ""
      renderSearchableOptions(select)
      search.focus()
    }
  })

  search.addEventListener("input", () => renderSearchableOptions(select))
  select.addEventListener("change", () => syncSearchableSelect(select))
  document.addEventListener("click", (event) => {
    if (!wrapper.contains(event.target)) {
      closeSearchableSelect(select)
    }
  })

  syncSearchableSelect(select)
}

function renderWorkflowOptions() {
  elements.workflow.replaceChildren()

  if (!workflows.length) {
    elements.workflow.appendChild(createOption("", "No matching workflows found"))
    renderDynamicInputs(null)
    setDeployEnabled(false)
    return
  }

  workflows.forEach((workflow) => {
    elements.workflow.appendChild(createOption(workflow.file, workflow.name || workflow.file))
  })
  const defaultWorkflow = workflows.find((workflow) => workflow.isDefaultDeployWorkflow) || workflows[0]
  elements.workflow.value = defaultWorkflow.file
  syncSearchableSelect(elements.workflow)
  renderDynamicInputs(defaultWorkflow)
  setDeployEnabled(true)
}

function renderBranchOptions(branchOptions) {
  const branches = Array.isArray(branchOptions) ? branchOptions : []
  elements.branch.replaceChildren()

  if (!branches.length) {
    elements.branch.appendChild(createOption("", "No branches found"))
    syncSearchableSelect(elements.branch)
    return
  }

  branches.forEach((branch) => {
    elements.branch.appendChild(createOption(branch))
  })
  elements.branch.value = branches.includes(currentBranch) ? currentBranch : branches[0]
  syncSearchableSelect(elements.branch)
}

function formatBranchErrorOutput(branchError, branchDebug, branchDiagnosis) {
  if (branchDiagnosis) {
    return formatBranchDiagnosisText(branchDiagnosis)
  }

  if (!branchDebug) {
    return branchError
  }

  return `${branchError}\n\nDiagnostics:\n${JSON.stringify(branchDebug, null, 2)}`
}

function formatBranchDiagnosisText(diagnosis) {
  if (!diagnosis) {
    return ""
  }

  const lines = [
    "Target branch 加载失败",
    "",
    "原因：",
    diagnosis.reason,
    "",
    "已检查：",
    ...(Array.isArray(diagnosis.checks) ? diagnosis.checks.map((item) => `- ${item}`) : []),
    "",
    "建议排查：",
    ...(Array.isArray(diagnosis.suggestions) ? diagnosis.suggestions.map((item, index) => `${index + 1}. ${item}`) : [])
  ]

  if (diagnosis.technicalDetails) {
    lines.push("", "技术详情（可复制给同事排查）：", JSON.stringify(diagnosis.technicalDetails, null, 2))
  }

  return lines.join("\n")
}

function renderDynamicInputs(workflow) {
  elements.dynamicInputs.replaceChildren()
  if (!workflow) return

  const entries = Object.entries(workflow.inputs || {}).filter(([name]) => name !== workflow.branchInputName)
  if (!entries.length) {
    const emptyMessage = document.createElement("p")
    emptyMessage.textContent = "This workflow does not define additional inputs."
    elements.dynamicInputs.appendChild(emptyMessage)
    return
  }

  entries.forEach(([name, input]) => {
    const label = document.createElement("label")
    const title = document.createElement("span")
    title.textContent = `${name}${input.required ? " *" : ""}`
    label.appendChild(title)

    const field = input.type === "choice" && input.options?.length ? document.createElement("select") : document.createElement("input")
    field.dataset.inputName = name
    field.required = Boolean(input.required)
    field.title = input.description || name

    if (field.tagName === "SELECT") {
      input.options.forEach((optionValue) => field.appendChild(createOption(optionValue)))
      field.value = input.default || input.options[0] || ""
    } else {
      field.type = "text"
      field.placeholder = input.description || name
      field.value = input.default || ""
    }

    label.appendChild(field)
    if (field.tagName === "SELECT") {
      enhanceSearchableSelect(field, `Search ${name}...`)
    }
    elements.dynamicInputs.appendChild(label)
  })
}

function formatTransportLine(parsed) {
  if (parsed?.transport === "github-api") {
    return "Transport: GitHub API (Token)"
  }

  if (parsed?.transport === "gh") {
    return "Transport: GitHub CLI (gh)"
  }

  return null
}

function getDeployCommandLine(payload) {
  const parsed = payload.parsed
  if (parsed?.commandPreview) {
    return parsed.commandPreview
  }

  if (Array.isArray(parsed?.command)) {
    return parsed.command.join(" ")
  }

  if (typeof parsed?.command === "string") {
    return parsed.command
  }

  return payload.command || ""
}

function formatResultOutput(payload) {
  const commandPreview = getDeployCommandLine(payload)
  const workflowName = payload.parsed?.workflow?.name || "Selected workflow"
  const targetBranch = payload.parsed?.targetBranch || ""
  const transportLine = formatTransportLine(payload.parsed)
  const parsedMessage = [payload.parsed?.reason, ...(Array.isArray(payload.parsed?.remediation) ? payload.parsed.remediation : [])].filter(Boolean).join("\n")
  const rawOutput = [payload.stdout, payload.stderr].filter(Boolean).join("\n\n").trim()

  if (payload.ok) {
    return [
      `Deploy workflow triggered successfully.`,
      "",
      `Status: Triggered`,
      transportLine,
      `Workflow: ${workflowName}`,
      targetBranch ? `Target branch: ${targetBranch}` : null,
      commandPreview ? `Command: ${commandPreview}` : null
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [`Deploy workflow failed to trigger.`, "", `Status: Failed`, commandPreview ? `Command: ${commandPreview}` : null, parsedMessage || rawOutput || JSON.stringify(payload, null, 2)].filter(Boolean).join("\n")
}

function formatRunStatusOutput(payload) {
  const commandPreview = getDeployCommandLine(payload)
  const workflowName = payload.parsed?.workflow?.name || "Selected workflow"
  const targetBranch = payload.parsed?.targetBranch || ""
  const transportLine = formatTransportLine(payload.parsed)
  const runUrl = payload.run?.url
  const runId = payload.run?.databaseId
  const pollTransport = payload.run?.transport === "github-api" ? "GitHub API" : payload.run?.transport === "gh" ? "GitHub CLI" : null

  if (payload.state === "success") {
    return [
      payload.message || "Deploy workflow completed successfully.",
      "",
      `Status: Success`,
      transportLine,
      pollTransport ? `Poll: ${pollTransport}` : null,
      `Workflow: ${workflowName}`,
      targetBranch ? `Target branch: ${targetBranch}` : null,
      runId ? `Run ID: ${runId}` : null,
      runUrl ? `Run URL: ${runUrl}` : null,
      commandPreview ? `Command: ${commandPreview}` : null
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (payload.state === "failed") {
    return [
      `Deploy workflow completed with a non-success result.`,
      "",
      `Status: ${payload.conclusion || "Failed"}`,
      `Workflow: ${workflowName}`,
      targetBranch ? `Target branch: ${targetBranch}` : null,
      runId ? `Run ID: ${runId}` : null,
      runUrl ? `Run URL: ${runUrl}` : null,
      commandPreview ? `Command: ${commandPreview}` : null,
      payload.message
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (payload.state === "cancelled") {
    return [
      `Deploy workflow was cancelled.`,
      "",
      `Status: Cancelled`,
      `Workflow: ${workflowName}`,
      targetBranch ? `Target branch: ${targetBranch}` : null,
      runId ? `Run ID: ${runId}` : null,
      runUrl ? `Run URL: ${runUrl}` : null,
      commandPreview ? `Command: ${commandPreview}` : null,
      payload.message
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [
    `Deploy workflow is in progress.`,
    "",
    `Status: In Progress`,
    payload.status ? `GitHub status: ${payload.status}` : null,
    transportLine,
    pollTransport ? `Poll: ${pollTransport}` : null,
    `Workflow: ${workflowName}`,
    targetBranch ? `Target branch: ${targetBranch}` : null,
    runId ? `Run ID: ${runId}` : null,
    runUrl ? `Run URL: ${runUrl}` : null,
    payload.message,
    commandPreview ? `Command: ${commandPreview}` : null
  ]
    .filter(Boolean)
    .join("\n")
}

function submit(action) {
  const form = getForm()
  const workflow = getSelectedWorkflow()
  if (!form.branch) {
    setStatus("Branch required", "error")
    writeOutput("Target branch is required.")
    return
  }

  if (!workflow) {
    setStatus("Workflow required", "error")
    writeOutput("No Pacvue test deploy workflow is available in this workspace.")
    return
  }

  const missingInputs = Object.entries(workflow.inputs || [])
    .filter(([name, input]) => name !== workflow.branchInputName && input.required && !form.inputs[name])
    .map(([name]) => name)

  if (missingInputs.length) {
    setStatus("Inputs required", "error")
    writeOutput(`Required workflow inputs are missing: ${missingInputs.join(", ")}`)
    return
  }

  vscode.postMessage({ type: action, payload: form })
}

elements.runButton.addEventListener("click", () => submit("dispatch"))
elements.cancelButton.addEventListener("click", () => vscode.postMessage({ type: "cancel" }))
elements.copyButton.addEventListener("click", () => navigator.clipboard.writeText(elements.output.textContent))
elements.workflow.addEventListener("change", () => renderDynamicInputs(getSelectedWorkflow()))
enhanceSearchableSelect(elements.branch, "Search branches...")
enhanceSearchableSelect(elements.workflow, "Search workflows...")

window.addEventListener("message", (event) => {
  const { type, payload } = event.data

  if (type === "state") {
    workflows = Array.isArray(payload.workflows) ? payload.workflows : []
    currentBranch = payload.currentBranch || ""
    renderBranchOptions(payload.branchOptions)
    renderWorkflowOptions()
    if (!payload.scriptPath) {
      setStatus("Script missing", "error")
      return
    }
    if (!payload.branchOptions?.length) {
      setStatus("No branches", "error")
      writeOutput(formatBranchErrorOutput(
        payload.branchError || "No Git branches were found. Open a Git repository folder and reload the panel.",
        payload.branchDebug,
        payload.branchDiagnosis
      ))
      return
    }
    if (!workflows.length) {
      setStatus("No workflows", "error")
      writeOutput(payload.workflowError || "No workflow with name containing 测试环境发版 was found.")
      return
    }
    if (payload.githubAuth && !payload.githubAuth.ready) {
      setStatus("Auth required", "error")
      writeOutput(
        [
          "Deploy requires GitHub authentication.",
          `Current: ${payload.githubAuth.label}`,
          "",
          "Option A (no GitHub CLI): set pacvueDeploy.githubToken or GITHUB_TOKEN (repo + workflow), then Reload Window.",
          "Option B: install official GitHub CLI and run gh auth login."
        ].join("\n")
      )
      return
    }
    setStatus("Ready", "ready")
    if (payload.githubAuth?.ready) {
      writeOutput(`Ready. GitHub auth: ${payload.githubAuth.label}`)
    }
    return
  }

  if (type === "running") {
    setBusy(true)
    setStatus("In Progress", "running")
    writeOutput(`Triggering deploy workflow...\n\n${payload.command}`)
    return
  }

  if (type === "runStatus") {
    const isInProgress = payload.state === "in_progress"
    setBusy(isInProgress)
    setStatus(
      payload.state === "success" ? "Success" : payload.state === "failed" ? "Failed" : payload.state === "cancelled" ? "Cancelled" : "In Progress",
      payload.state === "failed" || payload.state === "cancelled" ? "error" : payload.state === "success" ? "ready" : "running"
    )
    writeOutput(formatRunStatusOutput(payload))
    return
  }

  if (type === "result") {
    setBusy(false)
    setStatus(payload.ok ? "In Progress" : "Failed", payload.ok ? "running" : "error")
    writeOutput(formatResultOutput(payload))
  }
})

vscode.postMessage({ type: "ready" })
