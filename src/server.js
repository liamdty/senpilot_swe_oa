require("dotenv").config();

const AdmZip = require("adm-zip");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACTS_DIR = path.join(ROOT_DIR, "artifacts");
const SEARCH_SCRIPT = path.join(ROOT_DIR, "src", "search.js");
const DOWNLOAD_LIMIT = process.env.DOWNLOAD_LIMIT || "10";

const DOCUMENT_TABS = Object.freeze({
  EXHIBITS: "Exhibits",
  KEY_DOCUMENTS: "Key Documents",
  OTHER_DOCUMENTS: "Other Documents",
  TRANSCRIPTS: "Transcripts",
  RECORDINGS: "Recordings",
  HEARINGS: "Hearings",
  RELATED_MATTERS: "Related Matters",
});

const TAB_ALIASES = new Map([
  ["exhibits", DOCUMENT_TABS.EXHIBITS],
  ["exhibit", DOCUMENT_TABS.EXHIBITS],
  ["key_documents", DOCUMENT_TABS.KEY_DOCUMENTS],
  ["key documents", DOCUMENT_TABS.KEY_DOCUMENTS],
  ["key", DOCUMENT_TABS.KEY_DOCUMENTS],
  ["other_documents", DOCUMENT_TABS.OTHER_DOCUMENTS],
  ["other documents", DOCUMENT_TABS.OTHER_DOCUMENTS],
  ["other", DOCUMENT_TABS.OTHER_DOCUMENTS],
  ["transcripts", DOCUMENT_TABS.TRANSCRIPTS],
  ["transcript", DOCUMENT_TABS.TRANSCRIPTS],
  ["recordings", DOCUMENT_TABS.RECORDINGS],
  ["recording", DOCUMENT_TABS.RECORDINGS],
  ["hearings", DOCUMENT_TABS.HEARINGS],
  ["hearing", DOCUMENT_TABS.HEARINGS],
  ["related_matters", DOCUMENT_TABS.RELATED_MATTERS],
  ["related matters", DOCUMENT_TABS.RELATED_MATTERS],
  ["related", DOCUMENT_TABS.RELATED_MATTERS],
]);

const app = express();
const queue = [];
let activeJob = null;

app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.json({ limit: "25mb" }));

function normalizeTabName(tabName) {
  const key = String(tabName || "").trim().toLowerCase().replace(/-/g, "_");
  const tab = TAB_ALIASES.get(key) || TAB_ALIASES.get(key.replace(/_/g, " "));
  if (!tab) {
    throw new Error(`Unknown document type "${tabName}". Valid types: ${Array.from(TAB_ALIASES.keys()).join(", ")}`);
  }
  return tab;
}

function artifactSafeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function extractEmailAddress(value) {
  const text = String(value || "").trim();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function field(body, ...names) {
  for (const name of names) {
    if (body[name] !== undefined && body[name] !== null && String(body[name]).trim() !== "") {
      return String(body[name]).trim();
    }
  }
  return "";
}

function parseMessageHeaders(value) {
  if (!value) return new Map();

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed
        .filter((header) => Array.isArray(header) && header.length >= 2)
        .map(([name, headerValue]) => [String(name).toLowerCase(), String(headerValue)])
    );
  } catch {
    return new Map();
  }
}

function getInboundMessageId(body) {
  const directMessageId = field(body, "Message-Id", "Message-ID", "message-id");
  if (directMessageId) return directMessageId;

  const headers = parseMessageHeaders(field(body, "message-headers"));
  return headers.get("message-id") || "";
}

function replySubject(subject, matterNo, tab) {
  const cleanSubject = subject && subject !== "(empty)" ? subject : `UARB documents for ${matterNo} - ${tab}`;
  return /^re:/i.test(cleanSubject) ? cleanSubject : `Re: ${cleanSubject}`;
}

function parseRequestText(subject, plainText) {
  const cleanSubject = subject && subject !== "(empty)" ? subject : "";
  const source = `${cleanSubject}\n${plainText || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  const match = source.match(/\b(M\d+)\b\s+(.+)/i);
  if (!match) {
    throw new Error('Expected email text like "M12205 other_documents".');
  }

  const matterNo = match[1].toUpperCase();
  const requestedType = match[2].trim().replace(/\s+/g, " ");
  const tab = normalizeTabName(requestedType);
  return { matterNo, requestedType, tab, tabSlug: artifactSafeName(tab) };
}

function validateMailgunSignature(body) {
  const signingKey = process.env.MAILGUN_SIGNING_KEY;
  if (!signingKey) return true;

  const timestamp = field(body, "timestamp");
  const token = field(body, "token");
  const signature = field(body, "signature");
  if (!timestamp || !token || !signature) return false;

  const digest = crypto.createHmac("sha256", signingKey).update(timestamp + token).digest("hex");
  if (digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

function enqueueJob(job) {
  queue.push(job);
  setImmediate(processNextJob);
}

async function processNextJob() {
  if (activeJob || queue.length === 0) return;

  activeJob = queue.shift();
  try {
    await handleInboundJob(activeJob);
  } catch (err) {
    console.error(`Job ${activeJob.id} failed:`, err);
    await sendFailureReply(activeJob, err).catch((replyErr) => {
      console.error(`Job ${activeJob.id} failure reply failed:`, replyErr);
    });
  } finally {
    activeJob = null;
    setImmediate(processNextJob);
  }
}

function runSearchScript(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SEARCH_SCRIPT, job.matterNo, job.requestedType], {
      cwd: ROOT_DIR,
      env: { ...process.env, DOWNLOAD_LIMIT, ARTIFACTS_DIR: job.artifactsDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`search.js exited ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function createDownloadsZip(job) {
  const downloadDir = path.join(job.artifactsDir, `${job.matterNo}-${job.tabSlug}-downloads`);
  const reportPath = path.join(job.artifactsDir, `${job.matterNo}-${job.tabSlug}-downloads.json`);
  const zipPath = path.join(job.artifactsDir, `${job.matterNo}-${job.tabSlug}-${job.id}.zip`);

  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  if (!report.succeeded) {
    throw new Error(`No documents downloaded for ${job.matterNo} ${job.tab}.`);
  }
  if (report.failed > 0 || report.succeeded !== report.requested) {
    const failedDocs = (report.downloads || [])
      .filter((download) => !download.ok)
      .map((download) => `${download.docNo}: ${download.error || "unknown error"}`)
      .join("\n");
    throw new Error(
      `Downloaded ${report.succeeded} of ${report.requested} selected documents for ${job.matterNo} ${job.tab}.\n${failedDocs}`
    );
  }

  const zip = new AdmZip();
  zip.addLocalFolder(downloadDir);
  zip.addLocalFile(reportPath);
  zip.writeZip(zipPath);
  return { zipPath, report };
}

async function handleInboundJob(job) {
  console.log(`Job ${job.id}: fetching ${job.matterNo} ${job.tab} for ${job.replyTo}`);
  await fs.mkdir(job.artifactsDir, { recursive: true });
  await runSearchScript(job);
  const { zipPath, report } = await createDownloadsZip(job);

  await sendMailgunMessage({
    to: job.replyTo,
    subject: replySubject(job.subject, job.matterNo, job.tab),
    text: [
      `Attached are the downloaded ${job.tab} documents for ${job.matterNo}.`,
      "",
      `Downloaded ${report.succeeded} of ${report.requested} selected documents.`,
    ].join("\n"),
    attachmentPath: zipPath,
    inReplyTo: job.messageId,
    references: job.references || job.messageId,
  });
  console.log(`Job ${job.id}: sent ${zipPath} to ${job.replyTo}`);
}

async function sendFailureReply(job, err) {
  if (!job.replyTo) return;
  await sendMailgunMessage({
    to: job.replyTo,
    subject: replySubject(job.subject, job.matterNo || "your matter", job.tab || "documents"),
    text: `Sorry, I could not complete the UARB document request.\n\n${err.message}`,
    inReplyTo: job.messageId,
    references: job.references || job.messageId,
  });
}

async function sendMailgunMessage({ to, subject, text, attachmentPath, inReplyTo, references }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) {
    throw new Error("MAILGUN_API_KEY and MAILGUN_DOMAIN are required to send replies.");
  }

  const form = new FormData();
  form.set("from", process.env.MAILGUN_FROM || `Senpilot <agent@${domain}>`);
  form.set("to", to);
  form.set("subject", subject);
  form.set("text", text);
  if (inReplyTo) form.set("h:In-Reply-To", inReplyTo);
  if (references) form.set("h:References", references);

  if (attachmentPath) {
    const bytes = await fs.readFile(attachmentPath);
    form.set("attachment", new Blob([bytes]), path.basename(attachmentPath));
  }

  const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Mailgun send failed ${response.status}: ${await response.text()}`);
  }
}

app.post("/mailgun/inbound", (req, res) => {
  if (!validateMailgunSignature(req.body || {})) {
    return res.status(401).json({ error: "Invalid Mailgun signature" });
  }

  try {
    const sender = field(req.body, "sender", "from", "X-Envelope-From");
    const subject = field(req.body, "subject", "Subject");
    const plainText = field(req.body, "stripped-text", "body-plain", "body", "Body");
    const messageId = getInboundMessageId(req.body);
    const replyTo = extractEmailAddress(sender);
    if (!replyTo) throw new Error("Missing sender.");

    const parsed = parseRequestText(subject, plainText);
    const job = {
      id: crypto.randomUUID(),
      replyTo,
      sender,
      subject,
      body: plainText,
      messageId,
      references: field(req.body, "References", "references"),
      ...parsed,
      receivedAt: new Date().toISOString(),
    };
    job.artifactsDir = path.join(ARTIFACTS_DIR, "jobs", job.id);

    enqueueJob(job);
    return res.status(202).json({
      ok: true,
      queued: true,
      jobId: job.id,
      matterNo: job.matterNo,
      documentType: job.tab,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    activeJob: activeJob ? activeJob.id : null,
    queuedJobs: queue.length,
  });
});

app.listen(PORT, () => {
  console.log(`Senpilot webhook server listening on :${PORT}`);
  console.log(`Mailgun inbound endpoint: POST /mailgun/inbound`);
});
