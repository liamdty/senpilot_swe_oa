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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_PARSE_MODEL = process.env.OPENROUTER_PARSE_MODEL || "";
const OPENROUTER_REPLY_MODEL = process.env.OPENROUTER_REPLY_MODEL || "";

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

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required.`);
  }
}

function validateConfig() {
  requireEnv("OPENROUTER_API_KEY");
  requireEnv("OPENROUTER_PARSE_MODEL");
  requireEnv("OPENROUTER_REPLY_MODEL");
}

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

function elapsedSeconds(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function jobArtifactPaths(job) {
  const base = `${job.matterNo}-${job.tabSlug}`;
  return {
    downloadDir: path.join(job.artifactsDir, `${base}-downloads`),
    documentsPath: path.join(job.artifactsDir, `${base}-documents.json`),
    downloadsPath: path.join(job.artifactsDir, `${base}-downloads.json`),
    screenshotPath: path.join(job.artifactsDir, `${base}.png`),
    zipPath: path.join(job.artifactsDir, `${base}-${job.id}.zip`),
  };
}

function successfulDownloads(report) {
  return (report.downloads || []).filter((download) => download.ok);
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response did not contain a JSON object.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function openRouterChat({ model, messages, temperature = 0.1 }) {
  if (!OPENROUTER_API_KEY || !model) {
    throw new Error("OpenRouter is not configured.");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost",
      "X-Title": process.env.OPENROUTER_APP_NAME || "UARB Documents Agent",
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter failed ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();
  return json.choices?.[0]?.message?.content || "";
}

async function parseRequestWithAi(subject, plainText) {
  const content = await openRouterChat({
    model: OPENROUTER_PARSE_MODEL,
    messages: [
      {
        role: "system",
        content: [
          "Extract the Nova Scotia UARB matter number and requested document tab from an inbound email.",
          "Matter numbers look like M12205 or M12383.",
          "Valid document tabs are Exhibits, Key Documents, Other Documents, Transcripts, and Recordings.",
          "Return only JSON with keys matterNo and documentType.",
        ].join(" "),
      },
      {
        role: "user",
        content: `Subject:\n${subject || ""}\n\nBody:\n${plainText || ""}`,
      },
    ],
  });

  const parsed = parseJsonObject(content);
  const matterNo = String(parsed.matterNo || "").trim().toUpperCase();
  if (!/^M\d+$/i.test(matterNo)) throw new Error("AI did not return a valid matter number.");
  const tab = normalizeTabName(parsed.documentType);
  return {
    matterNo,
    requestedType: parsed.documentType,
    tab,
    tabSlug: artifactSafeName(tab),
  };
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
      env: { ...process.env, ARTIFACTS_DIR: job.artifactsDir },
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
  const { downloadDir, documentsPath, downloadsPath, screenshotPath, zipPath } = jobArtifactPaths(job);

  const report = JSON.parse(await fs.readFile(downloadsPath, "utf8"));
  const documents = JSON.parse(await fs.readFile(documentsPath, "utf8"));
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
  zip.writeZip(zipPath);
  return { zipPath, report, documents, screenshotPath };
}

async function buildReplyText(job, report, documents, screenshotPath) {
  const downloadedDocs = successfulDownloads(report);
  const metadata = {
    matterNo: job.matterNo,
    requestedTab: job.tab,
    selectedTabDocumentCount: documents.count,
    requestedDownloadCount: report.requested,
    successfulDownloadCount: report.succeeded,
    failedDownloadCount: report.failed,
    downloadedDocuments: downloadedDocs.map((doc) => ({
      docNo: doc.docNo,
      title: doc.title,
      date: doc.date,
      security: doc.security,
      extension: doc.extension,
      filename: doc.suggestedFilename,
      bytes: doc.bytes,
    })),
    allDocumentsInSelectedTab: documents.documents,
  };

  const content = [
    {
      type: "text",
      text: [
        "Draft a concise plain-text email body from the UARB Documents Agent.",
        "The ZIP of downloaded documents will be attached by the system; do not claim any other attachments.",
        "Use a short, professional, high-information overview.",
        "No warmup, no greeting like Dear, no sign-off, and no closing signature.",
        "Do not use Markdown, asterisks, bold markers, tables, or decorative formatting.",
        "Avoid repetition.",
        "Summarize the matter metadata visible in the screenshot when available, including title, type/category, date received, and final submissions date.",
        "State total count in the requested tab and how many selected documents were downloaded.",
        "Mention the downloaded document names/titles briefly without listing excessive detail.",
        "Do not mention internal JSON, scraping, Playwright, OpenRouter, or implementation details.",
        "",
        "Original inbound email:",
        `Subject: ${job.subject || ""}`,
        `Body: ${job.body || ""}`,
        "",
        "Structured retrieval metadata JSON:",
        JSON.stringify(metadata, null, 2),
      ].join("\n"),
    },
  ];

  const image = await fs.readFile(screenshotPath).catch(() => null);
  if (image) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${image.toString("base64")}`,
      },
    });
  }

  const reply = await openRouterChat({
    model: OPENROUTER_REPLY_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You write concise, professional plain-text regulatory document retrieval email bodies. Never use Markdown bold, a Dear greeting, or a sign-off.",
      },
      { role: "user", content },
    ],
  });

  const trimmed = reply.trim();
  if (!trimmed) throw new Error("OpenRouter reply model returned an empty email body.");
  return trimmed;
}

async function handleInboundJob(job) {
  const jobStartedAt = Date.now();
  const parsedStartedAt = Date.now();
  Object.assign(job, await parseRequestWithAi(job.subject, job.body));
  job.artifactsDir = path.join(ARTIFACTS_DIR, "jobs", job.id);
  console.log(`Job ${job.id}: parse ${elapsedSeconds(parsedStartedAt)} (${job.matterNo} ${job.tab})`);

  console.log(`Job ${job.id}: fetching ${job.matterNo} ${job.tab} for ${job.replyTo}`);
  await fs.mkdir(job.artifactsDir, { recursive: true });

  const searchStartedAt = Date.now();
  await runSearchScript(job);
  console.log(`Job ${job.id}: search ${elapsedSeconds(searchStartedAt)}`);

  const zipStartedAt = Date.now();
  const { zipPath, report, documents, screenshotPath } = await createDownloadsZip(job);
  console.log(`Job ${job.id}: zip ${elapsedSeconds(zipStartedAt)}`);

  const replyStartedAt = Date.now();
  const replyText = await buildReplyText(job, report, documents, screenshotPath);
  console.log(`Job ${job.id}: ai-reply ${elapsedSeconds(replyStartedAt)}`);

  const sendStartedAt = Date.now();
  await sendMailgunMessage({
    to: job.replyTo,
    subject: replySubject(job.subject, job.matterNo, job.tab),
    text: replyText,
    attachmentPath: zipPath,
    inReplyTo: job.messageId,
    references: job.references || job.messageId,
  });
  console.log(`Job ${job.id}: mailgun ${elapsedSeconds(sendStartedAt)}`);
  console.log(`Job ${job.id}: done ${elapsedSeconds(jobStartedAt)} (${zipPath})`);
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
  form.set("from", process.env.MAILGUN_FROM || `UARB Documents Agent <agent@${domain}>`);
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

app.post("/mailgun/inbound", async (req, res) => {
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

    const job = {
      id: crypto.randomUUID(),
      replyTo,
      sender,
      subject,
      body: plainText,
      messageId,
      references: field(req.body, "References", "references"),
      receivedAt: new Date().toISOString(),
    };

    enqueueJob(job);
    return res.status(202).json({
      ok: true,
      queued: true,
      jobId: job.id,
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

validateConfig();

app.listen(PORT, () => {
  console.log(`UARB Documents Agent webhook server listening on :${PORT}`);
  console.log(`Mailgun inbound endpoint: POST /mailgun/inbound`);
});
