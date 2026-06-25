#!/usr/bin/env node

const fs = require("node:fs")
const { spawnSync } = require("node:child_process")

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--triage-result") args.triageResult = argv[++index]
    else if (arg === "--prompt-file") args.promptFile = argv[++index]
    else if (arg === "--help" || arg === "-h") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-parser-fix-agent.js --triage-result .triage/result.json --prompt-file .triage/parser-fix-prompt.md

Set PACVUE_DEPLOY_PARSER_FIX_COMMAND to the command that applies the code fix.
The command may contain {prompt} and {triage} placeholders.
`)
}

function writeGithubOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value).replace(/\r?\n/g, " ")}\n`)
}

function buildCommand(template, args) {
  if (template.includes("{prompt}") || template.includes("{triage}")) {
    return template
      .replace(/\{prompt\}/g, args.promptFile)
      .replace(/\{triage\}/g, args.triageResult)
  }

  return `${template} ${args.promptFile}`
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return 0
  }

  if (!args.triageResult || !args.promptFile) {
    throw new Error("--triage-result and --prompt-file are required.")
  }

  const commandTemplate = String(process.env.PACVUE_DEPLOY_PARSER_FIX_COMMAND || "").trim()
  if (!commandTemplate) {
    const message = "PACVUE_DEPLOY_PARSER_FIX_COMMAND is not configured; parser fix PR generation was skipped."
    console.log(message)
    writeGithubOutput("ran", "false")
    return 0
  }

  const triage = JSON.parse(fs.readFileSync(args.triageResult, "utf8"))
  const command = buildCommand(commandTemplate, args)
  console.log(`Running parser fix command for issue #${triage.issue?.number || "unknown"}...`)

  const result = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      TRIAGE_RESULT: args.triageResult,
      TRIAGE_PROMPT: args.promptFile,
      TRIAGE_ISSUE_NUMBER: String(triage.issue?.number || "")
    }
  })

  writeGithubOutput("ran", "true")
  return result.status || 0
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  }
}
