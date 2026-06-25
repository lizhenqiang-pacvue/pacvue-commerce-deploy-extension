#!/usr/bin/env node

const fs = require("node:fs")
const https = require("node:https")
const path = require("node:path")

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--triage-result") args.triageResult = argv[++index]
    else if (arg === "--email-json") args.emailJson = argv[++index]
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/send-project-config-email.js --triage-result .triage/result.json
`)
}

function splitRecipients(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function textToHtml(text) {
  return `<pre style="font-family: Menlo, Consolas, monospace; white-space: pre-wrap;">${escapeHtml(text)}</pre>`
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const body = JSON.stringify(payload)
    const request = https.request(
      {
        hostname: parsedUrl.hostname,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let raw = ""
        response.on("data", (chunk) => {
          raw += chunk
        })
        response.on("end", () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            body: raw
          })
        })
      }
    )

    request.on("error", reject)
    request.write(body)
    request.end()
  })
}

function readEmailPayload(args) {
  if (args.emailJson) {
    return JSON.parse(fs.readFileSync(args.emailJson, "utf8"))
  }

  if (!args.triageResult) {
    throw new Error("--triage-result or --email-json is required.")
  }

  const result = JSON.parse(fs.readFileSync(args.triageResult, "utf8"))
  if (!result.email) {
    throw new Error("Triage result does not contain an email payload.")
  }
  return result.email
}

function writeGithubOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value).replace(/\r?\n/g, " ")}\n`)
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return 0
  }

  const email = readEmailPayload(args)
  const recipients = splitRecipients(process.env.PACVUE_DEPLOY_TRIAGE_EMAIL_TO)
  const endpoint = process.env.PACVUE_DEPLOY_EMAIL_ENDPOINT || "https://api.pacvue.com/pacvue-email-service/SendMail"
  const outDir = path.dirname(args.triageResult || args.emailJson || ".")
  const resultFile = path.join(outDir, "email-result.md")

  if (!recipients.length) {
    const message = "Project config email skipped because PACVUE_DEPLOY_TRIAGE_EMAIL_TO is not configured."
    fs.writeFileSync(resultFile, `${message}\n`)
    writeGithubOutput("sent", "false")
    console.log(message)
    return 0
  }

  const payload = {
    Receiver: recipients,
    Subject: email.subject,
    BodyContent: email.bodyHtml || textToHtml(email.bodyText),
    ProductLine: process.env.PACVUE_DEPLOY_EMAIL_PRODUCT_LINE || "devops",
    EmailSettingName: process.env.PACVUE_DEPLOY_EMAIL_SETTING_NAME || "DONOTREPLY"
  }

  if (args.dryRun || process.env.PACVUE_DEPLOY_EMAIL_DRY_RUN === "true") {
    fs.writeFileSync(resultFile, `Dry run: would send project config email to ${recipients.join(", ")}.\n`)
    writeGithubOutput("sent", "false")
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }

  const response = await postJson(endpoint, payload)
  if (!response.ok) {
    throw new Error(`Email API failed with status ${response.statusCode}: ${response.body}`)
  }

  fs.writeFileSync(resultFile, `Project config email sent to ${recipients.join(", ")}.\n`)
  writeGithubOutput("sent", "true")
  console.log(`Project config email sent to ${recipients.join(", ")}.`)
  return 0
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error))
      process.exitCode = 1
    })
}
