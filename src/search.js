const { chromium } = require("playwright");
const fs = require("fs/promises");

const MATTER_NO = process.argv[2] || "M12205";
const REQUESTED_TAB = process.argv[3] || "other_documents";
const DEBUG = process.env.DEBUG === "1";
const TIMEOUT_MS = 10_000;
const KEY_DELAY_MS = 40;
const FOCUS_SETTLE_MS = 100;
const DOWNLOAD_LIMIT = Number(process.env.DOWNLOAD_LIMIT || 10);

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

function normalizeTabName(tabName) {
  const key = String(tabName).trim().toLowerCase().replace(/-/g, "_");
  const tab = TAB_ALIASES.get(key) || TAB_ALIASES.get(key.replace(/_/g, " "));
  if (!tab) {
    throw new Error(`Unknown tab "${tabName}". Valid tabs: ${Object.values(DOCUMENT_TABS).join(", ")}`);
  }
  return tab;
}

function artifactSafeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fileSafeName(value) {
  return String(value).replace(/[^A-Za-z0-9._()-]+/g, "_").replace(/^_+|_+$/g, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForMatterPage(page) {
  const matterTabs = page
    .locator(
      [
        "button",
        ".fm-button-label",
        ".fm-button-bar-segment-label",
        ".v-label",
        ".fm-text-character",
      ].join(", "),
      { hasText: /Other Documents\s*-|Key Documents\s*-|Exhibits\s*-/i }
    )
    .first();

  const noRecords = page
    .locator(".v-window, .v-window-header, .v-window-contents", {
      hasText: /No Records Found|No records matched your search request/i,
    })
    .first();

  const outcome = await Promise.race([
    matterTabs.waitFor({ state: "visible", timeout: TIMEOUT_MS }).then(() => "matter"),
    noRecords.waitFor({ state: "visible", timeout: TIMEOUT_MS }).then(() => "no-records"),
  ]);

  if (outcome === "no-records") {
    throw new Error(`No records found for matter ${MATTER_NO}`);
  }
}

async function searchMatter(page) {
  console.log("Opening UARB...");
  await page.goto("https://uarb.novascotia.ca/fmi/webd/UARB15", {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_MS,
  });
  await page.waitForSelector("#b0p0o254i0i0r1 .text", { timeout: TIMEOUT_MS });

  console.log(`Searching ${MATTER_NO}...`);
  const directInput = page.locator("#b0p0o254i0i0r1 .text");
  await directInput.click({ force: true });
  await page.waitForTimeout(FOCUS_SETTLE_MS);
  for (const ch of MATTER_NO) {
    await page.keyboard.press(ch);
    await page.waitForTimeout(KEY_DELAY_MS);
  }

  const typedMatterNo = (await directInput.innerText()).trim();
  if (typedMatterNo !== MATTER_NO) {
    await page.screenshot({ path: "artifacts/input-mismatch.png", fullPage: true });
    throw new Error(`Matter input mismatch: expected ${MATTER_NO}, got ${typedMatterNo || "<blank>"}`);
  }

  if (DEBUG) {
    await page.screenshot({ path: "artifacts/after-type.png", fullPage: true });
  }

  await page.locator("#b0p0o258i0i0r1").click({ force: true });
  await waitForMatterPage(page);
}

async function clickDocumentTab(page, tabName) {
  const tab = normalizeTabName(tabName);
  const tabButton = page.locator("button", { hasText: new RegExp(`^${tab}(?:\\s*-\\s*\\d+)?$`, "i") }).first();
  await tabButton.waitFor({ state: "visible", timeout: TIMEOUT_MS });

  const beforeText = await page.locator("body").innerText();
  await tabButton.click({ force: true });

  if ([DOCUMENT_TABS.EXHIBITS, DOCUMENT_TABS.KEY_DOCUMENTS, DOCUMENT_TABS.OTHER_DOCUMENTS].includes(tab)) {
    await page.locator("button", { hasText: /Save List/i }).waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".v-grid-tablewrapper .text")).some((el) =>
          (el.innerText || el.textContent || "").trim() === "GO GET IT"
        ),
      null,
      { timeout: TIMEOUT_MS }
    );
  } else {
    await page.waitForFunction(
      (oldText) => document.body.innerText !== oldText,
      beforeText,
      { timeout: TIMEOUT_MS }
    ).catch(() => undefined);
  }

  return tab;
}

async function scrapeVisibleRows(page) {
  return page.evaluate(() => {
    const gridTop =
      document.querySelector(".v-grid-tablewrapper")?.getBoundingClientRect().top ??
      document.querySelector(".v-grid")?.getBoundingClientRect().top ??
      330;
    const cells = Array.from(document.querySelectorAll(".v-grid-tablewrapper .text, .text"))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.textContent || "").trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        };
      })
      .filter((cell) => cell.text && cell.y >= gridTop - 5);

    const byY = new Map();
    for (const cell of cells) {
      if (!byY.has(cell.y)) byY.set(cell.y, []);
      byY.get(cell.y).push(cell);
    }

    const rows = [];
    const ignoredLeftColumnValues = /^(Public|Confidential|Preview|GO GET IT|\.pdf)$/i;
    for (const docNoCell of cells.filter(
      (cell) =>
        cell.x < 100 &&
        !ignoredLeftColumnValues.test(cell.text) &&
        !/^\d{2}\/\d{2}\/\d{4}$/.test(cell.text)
    )) {
      const topCells = cells.filter((cell) => Math.abs(cell.y - docNoCell.y) <= 1);
      const bottomCells = cells.filter((cell) => Math.abs(cell.y - (docNoCell.y + 32)) <= 1);
      const title = topCells.find((cell) => cell.x > 100 && cell.x < 1150)?.text || "";
      const date = topCells.find((cell) => /^\d{2}\/\d{2}\/\d{4}$/.test(cell.text))?.text || "";
      const extension = topCells.find((cell) => /^\.[A-Za-z0-9]+$/.test(cell.text))?.text || "";
      const security = bottomCells.find((cell) => /^(Public|Confidential)$/i.test(cell.text))?.text || "";

      rows.push({
        docNo: docNoCell.text,
        title,
        date,
        security,
        extension,
      });
    }
    return rows;
  });
}

async function collectDocumentRows(page) {
  const rowsByDocNo = new Map();
  const scroller = page.locator(".v-grid-scroller-vertical").first();
  const hasScroller = await scroller.count();

  if (hasScroller) {
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(150);
  }

  const tableBox = await page.locator(".v-grid-tablewrapper").boundingBox().catch(() => null);
  if (tableBox) {
    await page.mouse.move(tableBox.x + tableBox.width / 2, tableBox.y + Math.min(300, tableBox.height / 2));
  }

  for (let attempts = 0; attempts < 40; attempts += 1) {
    for (const row of await scrapeVisibleRows(page)) {
      if (row.docNo && row.title) rowsByDocNo.set(row.docNo, row);
    }

    if (!hasScroller) break;
    const scrollInfo = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }));
    if (scrollInfo.top >= scrollInfo.max - 2) break;

    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(100);
  }

  if (hasScroller) {
    await scroller.evaluate((el, scrollTop) => {
      el.scrollTop = scrollTop;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, 0);
    await page.waitForTimeout(150);
  }

  return Array.from(rowsByDocNo.values());
}

async function clickByCenter(page, locator) {
  const center = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(center.x, center.y);
}

async function scrollGridToTop(page) {
  const scroller = page.locator(".v-grid-scroller-vertical").first();
  if (!(await scroller.count())) return;

  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(150);
}

async function findVisibleGoGetItPoint(page, docNo) {
  return page.evaluate((targetDocNo) => {
    const gridTop =
      document.querySelector(".v-grid-tablewrapper")?.getBoundingClientRect().top ??
      document.querySelector(".v-grid")?.getBoundingClientRect().top ??
      330;
    const cells = Array.from(document.querySelectorAll(".v-grid-tablewrapper .text, .text"))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.textContent || "").trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
        };
      })
      .filter((cell) => cell.text && cell.y >= gridTop - 5);

    const leftColumnCells = cells
      .filter(
        (cell) =>
          cell.x < 100 &&
          !/^(Public|Confidential|Preview|GO GET IT|\.pdf)$/i.test(cell.text) &&
          !/^\d{2}\/\d{2}\/\d{4}$/.test(cell.text)
      )
      .sort((a, b) => a.y - b.y);
    const docCell = leftColumnCells.find((cell) => cell.text === targetDocNo);
    if (!docCell) return null;

    const nextDocCell = leftColumnCells.find((cell) => cell.y > docCell.y + 2);
    const rowBottom = nextDocCell ? nextDocCell.y - 2 : docCell.y + 60;
    const actionCell = cells.find(
      (cell) => cell.text === "GO GET IT" && cell.y >= docCell.y - 2 && cell.y <= rowBottom
    );
    if (!actionCell) return null;

    return { x: actionCell.centerX, y: actionCell.centerY };
  }, docNo);
}

async function scrollUntilRowActionVisible(page, docNo) {
  await scrollGridToTop(page);

  const scroller = page.locator(".v-grid-scroller-vertical").first();
  const hasScroller = await scroller.count();
  const tableBox = await page.locator(".v-grid-tablewrapper").boundingBox().catch(() => null);
  if (tableBox) {
    await page.mouse.move(tableBox.x + tableBox.width / 2, tableBox.y + Math.min(300, tableBox.height / 2));
  }

  for (let attempts = 0; attempts < 40; attempts += 1) {
    const point = await findVisibleGoGetItPoint(page, docNo);
    if (point) return point;
    if (!hasScroller) break;

    const scrollInfo = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }));
    if (scrollInfo.top >= scrollInfo.max - 2) break;

    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(100);
  }

  throw new Error(`Could not find GO GET IT button for ${docNo}`);
}

async function closeOpenModal(page) {
  const close = page.locator(".v-window .v-button", { hasText: /^Close$/ }).first();
  if (await close.count()) {
    await clickByCenter(page, close).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

function selectDocumentsForDownload(documents, limit = DOWNLOAD_LIMIT) {
  const publicDocs = documents.filter((doc) => /^Public$/i.test(doc.security));
  const confidentialDocs = documents.filter((doc) => /^Confidential$/i.test(doc.security));
  return [...publicDocs, ...confidentialDocs].slice(0, limit);
}

function expectedDownloadFilename(doc) {
  return `${doc.docNo}${doc.extension || ".pdf"}`;
}

async function getVisibleDownloadModalText(page) {
  const modal = page.locator(".v-window").first();
  if (!(await modal.count())) return "";
  return (await modal.innerText().catch(() => "")).trim();
}

async function downloadSelectedDocuments(page, documents, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });

  const downloads = [];
  for (const [index, doc] of documents.entries()) {
    const extension = doc.extension || ".pdf";
    const expectedFilename = expectedDownloadFilename(doc);
    const filename = `${String(index + 1).padStart(2, "0")}-${fileSafeName(doc.docNo)}${extension}`;
    const path = `${outputDir}/${filename}`;
    const startedAt = Date.now();

    try {
      await closeOpenModal(page);
      const actionPoint = await scrollUntilRowActionVisible(page, doc.docNo);
      await page.mouse.click(actionPoint.x, actionPoint.y);

      const expectedFilePattern = new RegExp(`^${escapeRegExp(expectedFilename)}$`, "i");
      const rowDownloadModal = page
        .locator(".v-window", {
          hasText: new RegExp(`Download Files[\\s\\S]*${escapeRegExp(expectedFilename)}`, "i"),
        })
        .first();
      await rowDownloadModal.waitFor({
        state: "visible",
        timeout: TIMEOUT_MS,
      });

      const downloadButton = rowDownloadModal.locator(".fm-download-button", { hasText: expectedFilePattern }).first();
      await downloadButton.waitFor({ state: "visible", timeout: TIMEOUT_MS });

      const downloadPromise = page.waitForEvent("download", { timeout: TIMEOUT_MS });
      await clickByCenter(page, downloadButton);
      const download = await downloadPromise;
      const suggestedFilename = download.suggestedFilename();
      if (suggestedFilename.toLowerCase() !== expectedFilename.toLowerCase()) {
        throw new Error(`Expected ${expectedFilename}, but WebDirect downloaded ${suggestedFilename}`);
      }

      await download.saveAs(path);
      await closeOpenModal(page);

      const stat = await fs.stat(path);
      downloads.push({
        ...doc,
        ok: true,
        downloadUrl: download.url(),
        expectedFilename,
        suggestedFilename,
        bytes: stat.size,
        elapsedMs: Date.now() - startedAt,
        path,
      });
    } catch (err) {
      const modalText = await getVisibleDownloadModalText(page);
      await closeOpenModal(page);
      downloads.push({
        ...doc,
        ok: false,
        expectedFilename,
        elapsedMs: Date.now() - startedAt,
        modalText,
        error: err.message,
      });
    }
  }

  await scrollGridToTop(page);
  return downloads;
}

async function main() {
  await fs.mkdir("artifacts", { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
    timeout: TIMEOUT_MS,
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.setDefaultNavigationTimeout(TIMEOUT_MS);

  await searchMatter(page);

  const selectedTab = await clickDocumentTab(page, REQUESTED_TAB);
  const tabSlug = artifactSafeName(selectedTab);
  console.log(`Opened tab: ${selectedTab}`);

  const documents = await collectDocumentRows(page);
  const selectedDownloads = selectDocumentsForDownload(documents);
  const downloadDir = `artifacts/${MATTER_NO}-${tabSlug}-downloads`;
  const downloads = await downloadSelectedDocuments(page, selectedDownloads, downloadDir);
  await closeOpenModal(page);

  await page.screenshot({ path: `artifacts/${MATTER_NO}-${tabSlug}.png`, fullPage: true });
  await fs.writeFile(`artifacts/${MATTER_NO}-${tabSlug}.html`, await page.content());
  await fs.writeFile(
    `artifacts/${MATTER_NO}-${tabSlug}-documents.json`,
    JSON.stringify(
      {
        matterNo: MATTER_NO,
        tab: selectedTab,
        count: documents.length,
        downloadMethod: "row-go-get-it-popup",
        downloadLimit: DOWNLOAD_LIMIT,
        selectedDownloadCount: selectedDownloads.length,
        documents,
      },
      null,
      2
    )
  );
  await fs.writeFile(
    `artifacts/${MATTER_NO}-${tabSlug}-downloads.json`,
    JSON.stringify(
      {
        matterNo: MATTER_NO,
        tab: selectedTab,
        outputDir: downloadDir,
        method: "row-go-get-it-popup",
        requested: selectedDownloads.length,
        succeeded: downloads.filter((download) => download.ok).length,
        failed: downloads.filter((download) => !download.ok).length,
        downloads,
      },
      null,
      2
    )
  );

  console.log(
    JSON.stringify(
      {
        matterNo: MATTER_NO,
        tab: selectedTab,
        count: documents.length,
        selectedDownloadCount: selectedDownloads.length,
        successfulDownloads: downloads.filter((download) => download.ok).length,
      },
      null,
      2
    )
  );
  console.log(documents.slice(0, 10));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
