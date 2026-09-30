import { A4_MM, computeGrid, labelEdge, reliableOverlapMm } from "./tiler.js";

const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } =
  window.PDFLib;
const PT_PER_MM = 72 / 25.4;
const mmToPt = (mm) => mm * PT_PER_MM;

// Converts a top-left mm position (poster-space, y-down) plus a content
// size into the bottom-left PDF-points anchor drawImage/drawPage expect
// (y-up). No rotation needed here — every tile is a plain portrait A4
// page, unlike Impose's nested signatures.
function pdfAnchor(destPageHeightMm, topLeftMm, sizeMm) {
  return {
    x: mmToPt(topLeftMm.x),
    y: mmToPt(destPageHeightMm - (topLeftMm.y + sizeMm.height)),
  };
}

// source: { kind: 'image', embedded: <PDFImage>, nativePx: {width,height} }
//       | { kind: 'pdf', embedded: <embedded page>, pageMm: {width,height} }
// options: { targetMm, printerMarginMm, overlapMm, labels }
export async function buildPosterPdf(outPdf, source, options) {
  const { targetMm, printerMarginMm, overlapMm, labels } = options;
  const grid = computeGrid(targetMm, printerMarginMm, overlapMm);
  const font = labels ? await outPdf.embedFont(StandardFonts.HelveticaBold) : null;

  // The size the *whole* source would occupy if scaled up to cover the
  // entire poster in one piece — every tile draws this same full-size
  // rendering, just positioned so a different crop region falls within
  // that tile's own page bounds.
  //
  // The page's own MediaBox naturally crops the *outer* edge of it for
  // free, but that's not enough on its own: since the full (uncropped)
  // poster rendering is drawn every time, whatever's beyond the intended
  // printable rect on a tile's *other* edges (every interior seam, and
  // the far edge of any non-first tile) is still genuine, valid poster
  // content — it doesn't stop at the crop boundary by itself, only the
  // physical page edge does. So every tile needs an explicit clip to its
  // own printable rect (inset by the margin on all four sides), or every
  // tile but the very first row/column would show extra un-reserved
  // content instead of a blank margin.
  const fullPosterMm = targetMm;
  const printableRectPt = {
    x: mmToPt(printerMarginMm),
    y: mmToPt(printerMarginMm),
    width: mmToPt(A4_MM.width - 2 * printerMarginMm),
    height: mmToPt(A4_MM.height - 2 * printerMarginMm),
  };

  for (const tile of grid.tiles) {
    const destPage = outPdf.addPage([mmToPt(A4_MM.width), mmToPt(A4_MM.height)]);

    // The tile's crop region (printable-sized) must sit inset by the
    // printer margin on every edge, not flush at the page's raw (0,0) —
    // otherwise the "margin" tiler.js already reserved when sizing the
    // grid never actually gets left blank on the page itself.
    const topLeftMm = {
      x: printerMarginMm - tile.cropMm.x,
      y: printerMarginMm - tile.cropMm.y,
    };
    const anchor = pdfAnchor(A4_MM.height, topLeftMm, fullPosterMm);
    const widthPt = mmToPt(fullPosterMm.width);
    const heightPt = mmToPt(fullPosterMm.height);

    destPage.pushOperators(
      pushGraphicsState(),
      rectangle(printableRectPt.x, printableRectPt.y, printableRectPt.width, printableRectPt.height),
      clip(),
      endPath()
    );

    if (source.kind === "image") {
      // drawImage takes a target size directly.
      destPage.drawImage(source.embedded, { x: anchor.x, y: anchor.y, width: widthPt, height: heightPt });
    } else {
      // drawPage takes scale factors relative to the embedded page's own
      // native point size instead.
      destPage.drawPage(source.embedded, {
        x: anchor.x,
        y: anchor.y,
        xScale: widthPt / source.embedded.width,
        yScale: heightPt / source.embedded.height,
      });
    }

    destPage.pushOperators(popGraphicsState());

    if (labels) {
      drawTileLabel(destPage, font, tile, grid, printerMarginMm, overlapMm);
    }
  }

  return grid;
}

// Assembly label ("R1C2") placed inset between the printer's margin and
// the full overlap depth on whichever edge has a neighbor — inside the
// zone that's (a) actually printed and (b) likely to end up trimmed
// away or covered by the overlapping neighbor rather than staying
// visible on the finished poster. No label at all for a poster small
// enough to be a single tile with no overlap anywhere.
function drawTileLabel(destPage, font, tile, grid, printerMarginMm, overlapMm) {
  const edge = labelEdge(tile, grid);
  if (!edge) return;

  const reliable = reliableOverlapMm(printerMarginMm, overlapMm);
  if (reliable <= 0) return; // configuration leaves nothing safely printed to label

  const insetMm = printerMarginMm + (overlapMm - printerMarginMm) / 2; // middle of the reliable band
  const label = `R${tile.row + 1}C${tile.col + 1}`;
  const size = 10;
  const widthPt = font.widthOfTextAtSize(label, size);

  let xMm, yMm;
  if (edge === "right") {
    xMm = A4_MM.width - insetMm;
    yMm = A4_MM.height / 2;
  } else if (edge === "left") {
    xMm = insetMm;
    yMm = A4_MM.height / 2;
  } else if (edge === "bottom") {
    xMm = A4_MM.width / 2;
    yMm = A4_MM.height - insetMm;
  } else {
    xMm = A4_MM.width / 2;
    yMm = insetMm;
  }

  destPage.drawText(label, {
    x: mmToPt(xMm) - widthPt / 2,
    y: mmToPt(A4_MM.height - yMm) - size / 2,
    size,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });
}

export async function embedImageSource(outPdf, bytes, mimeType) {
  const embedded = mimeType === "image/png" ? await outPdf.embedPng(bytes) : await outPdf.embedJpg(bytes);
  return { kind: "image", embedded, nativePx: { width: embedded.width, height: embedded.height } };
}

export async function embedPdfSource(outPdf, srcBytes) {
  const srcPdf = await PDFDocument.load(srcBytes);
  const [firstPage] = srcPdf.getPages();
  // Force a content stream to exist even on a genuinely blank page, same
  // reason as Impose's embedAllPages: pdf-lib refuses to embed a
  // content-less page otherwise.
  firstPage.drawLine({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, thickness: 0, opacity: 0 });
  const { width, height } = firstPage.getSize();
  const [embedded] = await outPdf.embedPdf(srcPdf, [0]);
  return { kind: "pdf", embedded, pageMm: { width: width / PT_PER_MM, height: height / PT_PER_MM } };
}
