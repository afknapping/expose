// Pure grid/geometry math for poster tiling — no PDF, no DOM. Everything
// here works in poster-space millimeters, top-left origin, y-down.

export const A4_MM = { width: 210, height: 297 };

// Along one axis: how many A4 tiles are needed to cover `targetLen` mm,
// and where each one starts/ends (in poster-space mm), given how much of
// each tile's printable length is usable (`printableLen`, already net of
// the printer's own unprintable margin) and how far each tile should
// extend past its neighbor's edge (`overlapLen`).
//
// Each additional tile contributes `printableLen - overlapLen` of new
// (non-duplicated) coverage — the first `overlapLen` of it re-shows what
// the previous tile already covered, on purpose, for assembly tolerance.
// The last tile in a row/column is pulled back flush with the poster's
// true far edge instead of overhanging past it (growing its overlap with
// the previous tile slightly, rather than wasting a strip beyond the
// poster on blank space).
export function tilePositions(targetLen, printableLen, overlapLen) {
  if (targetLen <= printableLen) {
    return [{ start: 0, end: targetLen }];
  }

  const stepLen = printableLen - overlapLen;
  const count = Math.ceil((targetLen - printableLen) / stepLen) + 1;

  const positions = [];
  for (let i = 0; i < count; i++) {
    let start = i * stepLen;
    let end = start + printableLen;
    if (end > targetLen) {
      end = targetLen;
      start = Math.max(0, end - printableLen);
    }
    positions.push({ start, end });
  }
  return positions;
}

// targetMm: the full poster's finished size. printerMarginMm: assumed
// unprintable border on every physical A4 sheet. overlapMm: how far each
// tile extends past its neighbor's nominal edge (the double-covered
// strip between two neighbors is 2×overlapMm wide, minus whatever each
// side's own printer margin eats into it).
export function computeGrid(targetMm, printerMarginMm, overlapMm) {
  const printableMm = {
    width: A4_MM.width - 2 * printerMarginMm,
    height: A4_MM.height - 2 * printerMarginMm,
  };

  const cols = tilePositions(targetMm.width, printableMm.width, overlapMm);
  const rows = tilePositions(targetMm.height, printableMm.height, overlapMm);

  const tiles = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      tiles.push({
        row: r,
        col: c,
        // This tile's crop region, in poster-space mm.
        cropMm: {
          x: cols[c].start,
          y: rows[r].start,
          width: cols[c].end - cols[c].start,
          height: rows[r].end - rows[r].start,
        },
      });
    }
  }

  return { cols: cols.length, rows: rows.length, printableMm, tiles };
}

// Reliable (guaranteed-printed-on-both-sides) width of the overlap band
// at any interior seam — used both as a sanity readout and to place
// assembly labels somewhere that's (a) actually printed and (b) likely
// to be trimmed/covered rather than staying visible on the finished
// poster. Negative means the chosen overlap can't even outrun the
// printer's own margin — not a usable configuration.
export function reliableOverlapMm(printerMarginMm, overlapMm) {
  return 2 * (overlapMm - printerMarginMm);
}

// Which of this tile's edges has a neighbor (and therefore an overlap
// band) to place an assembly label in — preferring the trailing edges
// first. Returns null only for a poster that fits on a single tile with
// no overlap anywhere.
export function labelEdge(tile, grid) {
  if (tile.col < grid.cols - 1) return "right";
  if (tile.row < grid.rows - 1) return "bottom";
  if (tile.col > 0) return "left";
  if (tile.row > 0) return "top";
  return null;
}

// DPI the source's own pixels end up printed at, given how many mm of
// the finished poster its full width spans. Same formula regardless of
// source kind (image or a PDF page's embedded image) — it only cares
// about "this many pixels end up covering this many mm," not where the
// pixels came from.
export function resultingDpi(sourcePx, posterMm) {
  const posterInches = posterMm / 25.4;
  return sourcePx / posterInches;
}
