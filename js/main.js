import { A4_MM, computeGrid, reliableOverlapMm, resultingDpi } from "./tiler.js";
import { buildPosterPdf, embedImageSource, embedPdfSource } from "./pdfBuilder.js";

const { PDFDocument } = window.PDFLib;

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileNameEl = document.getElementById("file-name");
const previewWrap = document.getElementById("preview-wrap");
const previewCanvas = document.getElementById("preview-canvas");
const widthInput = document.getElementById("setting-width");
const heightInput = document.getElementById("setting-height");
const overlapInput = document.getElementById("setting-overlap");
const marginInput = document.getElementById("setting-margin");
const labelsCheckbox = document.getElementById("setting-labels");
const statsEl = document.getElementById("stats");
const makeBtn = document.getElementById("make-btn");
const messagesEl = document.getElementById("messages");
const downloadsEl = document.getElementById("downloads");
const downloadRealEl = document.getElementById("download-real");

// Populated once a file is loaded: { kind: 'image'|'pdf', bytes, mimeType,
// nativePx: {width,height} | null, aspectRatio, sourceCanvas }. nativePx
// is the pixel size to base the DPI readout on — always known for an
// image, best-effort (and often null) for a PDF page, since it depends
// on finding a single dominant embedded raster image rather than vector
// content.
let source = null;
let linkGuard = false;

function clearMessages() {
  messagesEl.innerHTML = "";
}

function showMessage(kind, html) {
  const div = document.createElement("div");
  div.className = `msg msg-${kind}`;
  div.innerHTML = html;
  messagesEl.appendChild(div);
}

function resetDownloads() {
  downloadsEl.hidden = true;
  if (downloadRealEl.href) URL.revokeObjectURL(downloadRealEl.href);
  downloadRealEl.removeAttribute("href");
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
});
["dragenter", "dragover"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  clearMessages();
  resetDownloads();
  makeBtn.hidden = true;
  fileNameEl.textContent = file.name;

  try {
    if (file.type === "application/pdf") {
      source = await loadPdfSource(file);
    } else if (file.type === "image/png" || file.type === "image/jpeg") {
      source = await loadImageSource(file);
    } else {
      showMessage("error", "Drop a PNG, JPG, or single-page PDF.");
      return;
    }
  } catch (err) {
    console.error("Expose: failed to read file", err);
    showMessage("error", `Couldn't read that file: ${err.message || err}`);
    return;
  }

  previewWrap.hidden = false;

  // Seed the width/height fields from the source's own aspect ratio —
  // starting width is arbitrary (a reasonable "big poster" default);
  // height follows to keep proportions.
  linkGuard = true;
  widthInput.value = 600;
  heightInput.value = Math.round(600 / source.aspectRatio);
  linkGuard = false;

  makeBtn.hidden = false;
  updatePreview();
}

async function loadImageSource(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: file.type }));
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = blobUrl;
  });
  const nativePx = { width: img.naturalWidth, height: img.naturalHeight };
  URL.revokeObjectURL(blobUrl);

  return {
    kind: "image",
    bytes,
    mimeType: file.type,
    nativePx,
    aspectRatio: nativePx.width / nativePx.height,
    drawToCanvas: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
  };
}

async function loadPdfSource(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });

  // Best-effort: if the page's content is essentially one big embedded
  // raster image, use its native pixel size for the DPI readout. Pure
  // vector/text pages have no meaningful pixel count, so nativePx stays
  // null and the DPI line is simply omitted rather than showing a made-up
  // number.
  const nativePx = await detectDominantImagePx(bytes);

  return {
    kind: "pdf",
    bytes,
    nativePx,
    aspectRatio: viewport.width / viewport.height,
    drawToCanvas: async (ctx, w, h) => {
      const scale = w / viewport.width;
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale }) }).promise;
    },
  };
}

// Scans the PDF's first page for Image XObjects via pdf-lib's low-level
// object access. Only returns a size when exactly one is found — with
// several embedded images there's no single "the" resolution to report.
async function detectDominantImagePx(bytes) {
  try {
    const doc = await PDFDocument.load(bytes.slice());
    const page = doc.getPages()[0];
    const resources = page.node.Resources();
    const xObjectDict = resources?.lookup(window.PDFLib.PDFName.of("XObject"));
    if (!xObjectDict) return null;

    const found = [];
    for (const key of xObjectDict.keys()) {
      const xObject = xObjectDict.lookup(key);
      const subtype = xObject?.dict?.get?.(window.PDFLib.PDFName.of("Subtype"));
      if (subtype?.toString() === "/Image") {
        const w = xObject.dict.get(window.PDFLib.PDFName.of("Width"))?.asNumber?.();
        const h = xObject.dict.get(window.PDFLib.PDFName.of("Height"))?.asNumber?.();
        if (w && h) found.push({ width: w, height: h });
      }
    }
    return found.length === 1 ? found[0] : null;
  } catch (err) {
    console.warn("Expose: couldn't inspect PDF for an embedded image size", err);
    return null;
  }
}

function currentSettings() {
  return {
    targetMm: { width: parseFloat(widthInput.value) || 1, height: parseFloat(heightInput.value) || 1 },
    overlapMm: parseFloat(overlapInput.value) || 0,
    printerMarginMm: parseFloat(marginInput.value) || 0,
    labels: labelsCheckbox.checked,
  };
}

function updatePreview() {
  if (!source) return;
  const { targetMm, overlapMm, printerMarginMm } = currentSettings();
  const grid = computeGrid(targetMm, printerMarginMm, overlapMm);

  renderPreviewCanvas(grid, targetMm);
  renderStats(grid, targetMm, overlapMm, printerMarginMm);
}

async function renderPreviewCanvas(grid, targetMm) {
  const maxPx = 640;
  const w = targetMm.width >= targetMm.height ? maxPx : Math.round((maxPx * targetMm.width) / targetMm.height);
  const h = targetMm.width >= targetMm.height ? Math.round((maxPx * targetMm.height) / targetMm.width) : maxPx;

  previewCanvas.width = w;
  previewCanvas.height = h;
  const ctx = previewCanvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  await source.drawToCanvas(ctx, w, h);

  const mmToPx = (mm, axisLenMm, axisLenPx) => (mm / axisLenMm) * axisLenPx;

  ctx.strokeStyle = "rgba(30, 125, 60, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  for (const tile of grid.tiles) {
    const x = mmToPx(tile.cropMm.x, targetMm.width, w);
    const y = mmToPx(tile.cropMm.y, targetMm.height, h);
    const tw = mmToPx(tile.cropMm.width, targetMm.width, w);
    const th = mmToPx(tile.cropMm.height, targetMm.height, h);
    ctx.strokeRect(x, y, tw, th);
  }
}

function renderStats(grid, targetMm, overlapMm, printerMarginMm) {
  const reliable = reliableOverlapMm(printerMarginMm, overlapMm);
  const totalSheets = grid.cols * grid.rows;

  const lines = [
    `<strong>${grid.cols} × ${grid.rows}</strong> = <strong>${totalSheets}</strong> A4 sheet${totalSheets === 1 ? "" : "s"} for a <strong>${targetMm.width}×${targetMm.height}mm</strong> poster`,
  ];

  if (source.nativePx) {
    const dpi = resultingDpi(source.nativePx.width, targetMm.width);
    lines.push(`Resulting resolution: <strong>${dpi.toFixed(0)} DPI</strong> at that size`);
  }

  lines.push(`Reliable double-printed overlap at each seam: <strong>${reliable.toFixed(0)}mm</strong>`);

  statsEl.innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
  statsEl.hidden = false;
  statsEl.classList.toggle("stats-warning", reliable <= 0);

  clearMessages();
  if (reliable <= 0) {
    showMessage(
      "warning",
      `Overlap (${overlapMm}mm) doesn't outrun the printer margin (${printerMarginMm}mm) — there'd be nothing reliably printed on both sides of a seam. Increase overlap or reduce the margin.`
    );
  }
}

[widthInput, heightInput].forEach((el) => {
  el.addEventListener("input", () => {
    if (!source || linkGuard) return;
    linkGuard = true;
    if (el === widthInput) {
      const w = parseFloat(widthInput.value) || 0;
      heightInput.value = Math.round(w / source.aspectRatio);
    } else {
      const h = parseFloat(heightInput.value) || 0;
      widthInput.value = Math.round(h * source.aspectRatio);
    }
    linkGuard = false;
    updatePreview();
  });
});

[overlapInput, marginInput, labelsCheckbox].forEach((el) => {
  el.addEventListener("input", updatePreview);
});

function setButtonWorking(working) {
  makeBtn.disabled = working;
  makeBtn.innerHTML = working ? '<span class="spinner"></span> Working…' : "Make Poster Sheets";
}

makeBtn.addEventListener("click", async () => {
  if (!source) return;
  resetDownloads();
  clearMessages();
  setButtonWorking(true);

  try {
    const settings = currentSettings();
    const outPdf = await PDFDocument.create();
    const embedded =
      source.kind === "image"
        ? await embedImageSource(outPdf, source.bytes, source.mimeType)
        : await embedPdfSource(outPdf, source.bytes);

    await buildPosterPdf(outPdf, embedded, settings);
    const bytes = await outPdf.save();

    downloadRealEl.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    downloadRealEl.download = "poster-sheets.pdf";
    downloadsEl.hidden = false;
  } catch (err) {
    console.error("Expose: build failed", err);
    showMessage("error", `Something went wrong while generating the poster sheets: ${err.message || err}`);
  } finally {
    setButtonWorking(false);
  }
});
