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
  statusPill: document.getElementById("statusPill"),
  cacheStatus: document.getElementById("cacheStatus"),
  presetsPanel: document.getElementById("presetsPanel"),
  presetsList: document.getElementById("presetsList"),
  savePresetButton: document.getElementById("savePresetButton"),
  historyPanel: document.getElementById("historyPanel"),
  historyList: document.getElementById("historyList"),
  clearHistoryButton: null,
  confirmOverlay: document.getElementById("confirmOverlay"),
  confirmSummary: document.getElementById("confirmSummary"),
  confirmOkButton: document.getElementById("confirmOkButton"),
  confirmCancelButton: document.getElementById("confirmCancelButton"),
  presetNameOverlay: document.getElementById("presetNameOverlay"),
  presetNameInput: document.getElementById("presetNameInput"),
  presetNameOkButton: document.getElementById("presetNameOkButton"),
  presetNameCancelButton: document.getElementById("presetNameCancelButton")
}

let workflows = []
let currentBranch = ""
let isBusy = false
let lastRunRequestId = 0
let deployHistory = []
let deployPresets = []
let githubAuth = null
let pendingDispatch = null
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

function setCacheStatus(text, variant = "idle") {
  elements.cacheStatus.textContent = text
  elements.cacheStatus.dataset.variant = variant
}

function setBusy(busy) {
  isBusy = busy
  elements.runButton.disabled = busy
  elements.cancelButton.disabled = !busy
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

function clearFailureCard() {
  elements.output.parentElement?.querySelector(".failure-card")?.remove()
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

function requestLastRunConfig() {
  if (isBusy) {
    return
  }

  const form = getForm()
  if (!form.branch || !form.workflow) {
    setCacheStatus("Last config: not loaded")
    return
  }

  lastRunRequestId += 1
  setCacheStatus("Last config: loading…", "running")
  vscode.postMessage({
    type: "queryLastRun",
    payload: { branch: form.branch, workflow: form.workflow, requestId: lastRunRequestId }
  })
}

function ensureSelectOption(select, value) {
  const hasOption = Array.from(select.options).some((option) => option.value === value)
  if (!hasOption) {
    select.appendChild(createOption(value))
  }
}

function getConfigSourceLabel(configSource) {
  const source = typeof configSource === "string" ? configSource : configSource?.source
  if (source === "mixed") return "Last config: from GitHub last run + local cache"
  if (source === "github") return "Last config: from GitHub last run"
  if (source === "cache") return "Last config: from local cache"
  if (source === "unavailable") return "Last config: unavailable"
  return "Last config: none"
}

function getInputSourceLabel(source) {
  if (source === "github") return "Source: GitHub last run"
  if (source === "cache") return "Source: local cache"
  if (source === "history") return "Source: recent deploy history"
  return ""
}

function setInputSourceHint(field, source) {
  const text = getInputSourceLabel(source)
  if (!text) return

  const hint = document.createElement("span")
  hint.className = "input-source-hint"
  hint.textContent = text
  const wrapper = field.closest("label") || field.parentElement
  wrapper?.appendChild(hint)
}

function buildUniformSources(values, source) {
  return Object.fromEntries(Object.keys(values || {}).map((key) => [key, source]))
}

function applyInputValues(values, sources = {}) {
  if (!values || typeof values !== "object") return

  elements.dynamicInputs.querySelectorAll("[data-input-name]").forEach((field) => {
    const name = field.dataset.inputName
    if (!Object.prototype.hasOwnProperty.call(values, name)) return

    const value = values[name]
    if (value === undefined || value === null) return

    const nextValue = String(value)
    if (field.tagName === "SELECT") {
      // A last-run value can fall outside the workflow's static <option> list
      // (e.g. branch=test/sprint/q2-5 when options are only production/master).
      // Setting select.value to a non-existent option is a silent no-op, so add it first.
      ensureSelectOption(field, nextValue)
      field.value = nextValue
      syncSearchableSelect(field)
    } else {
      field.value = nextValue
    }
    setInputSourceHint(field, sources[name])
  })
}

function formatHistoryTime(ts) {
  if (!ts) return ""
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  return `${month}/${day} ${hour}:${minute}`
}

function formatHistoryInputs(inputs) {
  const entries = Object.entries(inputs || {}).filter(([, value]) => value !== undefined && value !== null && value !== "")
  if (!entries.length) return "No inputs"
  return entries.map(([key, value]) => `${key}=${value}`).join(", ")
}

function applyHistoryEntry(entry) {
  if (!entry) return

  ensureSelectOption(elements.branch, entry.branch)
  elements.branch.value = entry.branch || ""
  syncSearchableSelect(elements.branch)

  ensureSelectOption(elements.workflow, entry.workflow)
  elements.workflow.value = entry.workflow || ""
  syncSearchableSelect(elements.workflow)
  renderDynamicInputs(getSelectedWorkflow())
  applyInputValues(entry.inputs, buildUniformSources(entry.inputs, "history"))
  setCacheStatus("History config: applied", "ready")
}

function renderPresets() {
  if (!elements.presetsPanel || !elements.presetsList) return

  elements.presetsList.replaceChildren()
  if (!deployPresets.length) {
    elements.presetsPanel.hidden = true
    return
  }

  elements.presetsPanel.hidden = false
  deployPresets.forEach((entry) => {
    const row = document.createElement("div")
    row.className = "preset-row"

    const meta = document.createElement("div")
    meta.className = "preset-meta"
    meta.textContent = entry.name || "Preset"
    meta.title = `${entry.name || "Preset"}${entry.repoId ? `\n${entry.repoId}` : ""}`

    const sub = document.createElement("div")
    sub.className = "preset-sub"
    sub.textContent = `${entry.workflowName || entry.workflow || "Workflow"} @ ${entry.branch || "branch"}`
    sub.title = sub.textContent

    const inputs = document.createElement("div")
    inputs.className = "preset-inputs"
    inputs.textContent = formatHistoryInputs(entry.inputs)
    inputs.title = inputs.textContent

    const actionRow = document.createElement("div")
    actionRow.className = "preset-actions"

    const apply = document.createElement("button")
    apply.type = "button"
    apply.className = "history-reuse"
    apply.textContent = "Apply"
    apply.addEventListener("click", () => applyHistoryEntry(entry))

    const del = document.createElement("button")
    del.type = "button"
    del.className = "muted-action"
    del.textContent = "Delete"
    del.addEventListener("click", () => vscode.postMessage({ type: "deletePreset", payload: { id: entry.id } }))

    actionRow.append(apply, del)
    row.append(meta, sub, inputs, actionRow)
    elements.presetsList.appendChild(row)
  })
}

function showPresetNameOverlay() {
  if (!elements.presetNameOverlay || !elements.presetNameInput) return

  const form = getForm()
  const workflow = getSelectedWorkflow()
  elements.presetNameInput.value = `${workflow?.name || workflow?.file || "Preset"} @ ${form.branch || "branch"}`
  elements.presetNameOverlay.hidden = false
  elements.presetNameInput.focus()
  elements.presetNameInput.select()
}

function hidePresetNameOverlay() {
  if (elements.presetNameOverlay) {
    elements.presetNameOverlay.hidden = true
  }
}

function saveCurrentPreset() {
  const name = elements.presetNameInput?.value.trim()
  if (!name) return

  hidePresetNameOverlay()
  vscode.postMessage({ type: "savePreset", payload: { ...getForm(), name } })
}

function renderHistory() {
  if (!elements.historyPanel || !elements.historyList) return

  elements.historyList.replaceChildren()
  if (!deployHistory.length) {
    elements.historyPanel.hidden = true
    return
  }

  elements.historyPanel.hidden = false
  deployHistory.forEach((entry) => {
    const row = document.createElement("div")
    row.className = "history-row"

    const meta = document.createElement("div")
    meta.className = "history-meta"
    const title = `${entry.workflowName || entry.workflow || "Workflow"} @ ${entry.branch || "branch"}`
    meta.textContent = title
    meta.title = `${title}${entry.repoId ? `\n${entry.repoId}` : ""}`

    const inputs = document.createElement("div")
    inputs.className = "history-inputs"
    inputs.textContent = formatHistoryInputs(entry.inputs)
    inputs.title = inputs.textContent

    const time = document.createElement("span")
    time.className = "history-ts"
    time.textContent = formatHistoryTime(entry.ts)

    const actionRow = document.createElement("div")
    actionRow.className = "history-actions"

    const reuse = document.createElement("button")
    reuse.type = "button"
    reuse.className = "history-reuse"
    reuse.textContent = "Reuse"
    reuse.addEventListener("click", () => applyHistoryEntry(entry))

    const clear = document.createElement("button")
    clear.type = "button"
    clear.className = "muted-action"
    clear.textContent = "Clear"
    clear.addEventListener("click", () => vscode.postMessage({ type: "clearHistory" }))

    actionRow.append(reuse, clear)
    row.append(meta, inputs, time, actionRow)
    elements.historyList.appendChild(row)
  })
}

function buildConfirmRows(form, workflow) {
  const rows = [
    ["Branch", form.branch],
    ["Workflow", workflow?.name || workflow?.file || form.workflow],
    ["File", workflow?.file || form.workflow]
  ]

  Object.entries(form.inputs || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      rows.push([key, value])
    }
  })

  if (githubAuth?.label) {
    rows.push(["Auth", githubAuth.label])
  }

  return rows
}

function showConfirm(form, workflow) {
  if (!elements.confirmOverlay || !elements.confirmSummary) return

  pendingDispatch = { form: { branch: form.branch, workflow: form.workflow, inputs: { ...form.inputs } } }
  elements.confirmSummary.replaceChildren()
  buildConfirmRows(form, workflow).forEach(([labelText, valueText]) => {
    const row = document.createElement("div")
    row.className = "confirm-row"

    const label = document.createElement("span")
    label.className = "confirm-label"
    label.textContent = labelText

    const value = document.createElement("span")
    value.className = "confirm-value"
    value.textContent = String(valueText ?? "")

    row.append(label, value)
    elements.confirmSummary.appendChild(row)
  })

  elements.confirmOverlay.hidden = false
  elements.confirmOkButton?.focus()
}

function hideConfirm() {
  if (elements.confirmOverlay) {
    elements.confirmOverlay.hidden = true
  }
  pendingDispatch = null
}

function buildDiagnosticText(diagnosis, payload) {
  const lines = [
    "Deploy Failed",
    `Conclusion: ${diagnosis.conclusion || payload.conclusion || "failure"}`,
    `Stage: ${diagnosis.stage || "unknown"}`,
    `Likely reason: ${diagnosis.likelyReason || payload.message || "unknown"}`,
    diagnosis.workflowName ? `Workflow: ${diagnosis.workflowName}` : null,
    diagnosis.targetBranch ? `Target branch: ${diagnosis.targetBranch}` : null,
    diagnosis.runId ? `Run ID: ${diagnosis.runId}` : null,
    diagnosis.runUrl ? `Run URL: ${diagnosis.runUrl}` : null
  ].filter(Boolean)

  if (diagnosis.jobsSummary?.length) {
    lines.push("", "Failed jobs:")
    diagnosis.jobsSummary.forEach((job) => {
      const steps = job.failedSteps?.length ? ` (${job.failedSteps.join(", ")})` : ""
      lines.push(`- ${job.name}${steps}`)
    })
  }

  return lines.join("\n")
}

function appendFailureRow(card, labelText, valueText) {
  if (!valueText) return

  const row = document.createElement("div")
  row.className = "failure-card-row"

  const label = document.createElement("span")
  label.className = "failure-card-label"
  label.textContent = labelText

  const value = document.createElement("span")
  value.className = "failure-card-value"
  value.textContent = String(valueText)

  row.append(label, value)
  card.appendChild(row)
}

function renderFailureDiagnosisCard(diagnosis, payload) {
  clearFailureCard()
  const card = document.createElement("div")
  card.className = "failure-card"

  const header = document.createElement("div")
  header.className = "failure-card-header"
  header.textContent = `Deploy Failed${diagnosis.conclusion ? ` · ${diagnosis.conclusion}` : ""}`
  card.appendChild(header)

  appendFailureRow(card, "Stage", diagnosis.stage)
  appendFailureRow(card, "Reason", diagnosis.likelyReason)
  appendFailureRow(card, "Workflow", diagnosis.workflowName)
  appendFailureRow(card, "Branch", diagnosis.targetBranch)
  appendFailureRow(card, "Run ID", diagnosis.runId)

  if (diagnosis.runUrl) {
    const row = document.createElement("div")
    row.className = "failure-card-row"
    const label = document.createElement("span")
    label.className = "failure-card-label"
    label.textContent = "Run URL"
    const link = document.createElement("button")
    link.type = "button"
    link.className = "failure-card-link"
    link.textContent = diagnosis.runUrl
    link.addEventListener("click", () => vscode.postMessage({ type: "openExternal", url: diagnosis.runUrl }))
    row.append(label, link)
    card.appendChild(row)
  }

  if (diagnosis.jobsSummary?.length) {
    const jobs = document.createElement("div")
    jobs.className = "failure-card-jobs"
    diagnosis.jobsSummary.forEach((job) => {
      const item = document.createElement("div")
      item.className = "failure-card-job"
      const steps = job.failedSteps?.length ? ` (${job.failedSteps.join(", ")})` : ""
      item.textContent = `${job.name}${steps}`
      jobs.appendChild(item)
    })
    card.appendChild(jobs)
  }

  const actions = document.createElement("div")
  actions.className = "failure-card-actions"

  if (diagnosis.runUrl) {
    const openRun = document.createElement("button")
    openRun.type = "button"
    openRun.className = "failure-card-action"
    openRun.textContent = "Open Run on GitHub"
    openRun.addEventListener("click", () => vscode.postMessage({ type: "openExternal", url: diagnosis.runUrl }))
    actions.appendChild(openRun)
  }

  const copy = document.createElement("button")
  copy.type = "button"
  copy.className = "failure-card-action"
  copy.textContent = "Copy diagnostic info"
  copy.addEventListener("click", () => navigator.clipboard.writeText(buildDiagnosticText(diagnosis, payload)))
  actions.appendChild(copy)
  card.appendChild(actions)

  elements.output.textContent = buildDiagnosticText(diagnosis, payload)
  elements.output.parentElement?.appendChild(card)
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

  if (action === "dispatch") {
    showConfirm(form, workflow)
    return
  }

  vscode.postMessage({ type: action, payload: form })
}

elements.runButton.addEventListener("click", () => submit("dispatch"))
elements.cancelButton.addEventListener("click", () => vscode.postMessage({ type: "cancel" }))
elements.copyButton.addEventListener("click", () => navigator.clipboard.writeText(elements.output.textContent))
elements.confirmOkButton?.addEventListener("click", () => {
  if (!pendingDispatch) return
  const form = pendingDispatch.form
  hideConfirm()
  vscode.postMessage({ type: "dispatch", payload: form })
})
elements.confirmCancelButton?.addEventListener("click", () => hideConfirm())
elements.savePresetButton?.addEventListener("click", () => showPresetNameOverlay())
elements.presetNameOkButton?.addEventListener("click", () => saveCurrentPreset())
elements.presetNameCancelButton?.addEventListener("click", () => hidePresetNameOverlay())
elements.presetNameInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    saveCurrentPreset()
  }
})
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return
  if (elements.confirmOverlay && !elements.confirmOverlay.hidden) {
    hideConfirm()
    return
  }
  if (elements.presetNameOverlay && !elements.presetNameOverlay.hidden) {
    hidePresetNameOverlay()
  }
})
elements.branch.addEventListener("change", () => {
  requestLastRunConfig()
})
elements.workflow.addEventListener("change", () => {
  renderDynamicInputs(getSelectedWorkflow())
  requestLastRunConfig()
})
enhanceSearchableSelect(elements.branch, "Search branches...")
enhanceSearchableSelect(elements.workflow, "Search workflows...")

window.addEventListener("message", (event) => {
  const { type, payload } = event.data

  if (type === "state") {
    workflows = Array.isArray(payload.workflows) ? payload.workflows : []
    currentBranch = payload.currentBranch || ""
    deployHistory = Array.isArray(payload.deployHistory) ? payload.deployHistory : []
    deployPresets = Array.isArray(payload.deployPresets) ? payload.deployPresets : []
    githubAuth = payload.githubAuth || null
    renderBranchOptions(payload.branchOptions)
    renderWorkflowOptions()
    renderPresets()
    renderHistory()
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
    requestLastRunConfig()
    return
  }

  if (type === "history") {
    deployHistory = Array.isArray(payload.entries) ? payload.entries : []
    renderHistory()
    return
  }

  if (type === "presets") {
    deployPresets = Array.isArray(payload.entries) ? payload.entries : []
    renderPresets()
    return
  }

  if (type === "lastRunConfig") {
    if (isBusy) {
      return
    }
    if (payload.requestId !== lastRunRequestId) {
      return
    }

    const form = getForm()
    if (payload.branch !== form.branch || payload.workflow !== form.workflow) {
      return
    }

    // Only backfill from the actual last-run history. When a branch has no
    // history, lastRunInputs is empty, so the user's already-entered values are
    // left untouched instead of being reset to workflow defaults.
    applyInputValues(payload.lastRunInputs, payload.inputSources)
    setCacheStatus(getConfigSourceLabel(payload.ok ? payload.configSource : "unavailable"), payload.ok ? "ready" : "error")
    return
  }

  if (type === "running") {
    hideConfirm()
    clearFailureCard()
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
    clearFailureCard()
    if (payload.state === "failed" && payload.failureDiagnosis) {
      renderFailureDiagnosisCard(payload.failureDiagnosis, payload)
    } else {
      writeOutput(formatRunStatusOutput(payload))
    }
    return
  }

  if (type === "result") {
    clearFailureCard()
    setBusy(false)
    setStatus(payload.ok ? "In Progress" : "Failed", payload.ok ? "running" : "error")
    writeOutput(formatResultOutput(payload))
  }
})

vscode.postMessage({ type: "ready" })
