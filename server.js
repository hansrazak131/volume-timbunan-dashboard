const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const archiver = require('archiver');
const PDFDocument = require('pdfkit');
const { fromFile } = require('geotiff');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'output');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
for (const dir of [OUTPUT_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT_DIR));
app.use(express.json({ limit: '20mb' }));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });

const toNumber = (v, f) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const fmt = (n, d = 2) => Number.isFinite(n) ? Number(n).toFixed(d) : '-';

async function readGeoTiff(filePath) {
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const raster = await image.readRasters({ samples: [0], interleave: true });
  const nodataRaw = image.getGDALNoData();
  const nodata = nodataRaw !== null && nodataRaw !== undefined && nodataRaw !== '' ? Number(nodataRaw) : null;
  return { width, height, raster, nodata };
}

function sampleNearest(source, tx, ty, tWidth, tHeight) {
  const sx = clamp(Math.round(tx * (source.width - 1) / Math.max(1, tWidth - 1)), 0, source.width - 1);
  const sy = clamp(Math.round(ty * (source.height - 1) / Math.max(1, tHeight - 1)), 0, source.height - 1);
  return source.raster[sy * source.width + sx];
}

function isNoData(v, nodata) {
  return !Number.isFinite(v) || (nodata !== null && Number.isFinite(nodata) && v === nodata);
}

function gradientColor(value, minDiff, maxDiff) {
  if (!Number.isFinite(value)) return '#eef2f7';
  if (Math.abs(maxDiff - minDiff) < 1e-9) return '#22c55e';
  const t = clamp((value - minDiff) / (maxDiff - minDiff), 0, 1);
  const stops = [
    { t: 0.00, c: [37, 99, 235] },
    { t: 0.22, c: [34, 211, 238] },
    { t: 0.45, c: [34, 197, 94] },
    { t: 0.65, c: [250, 204, 21] },
    { t: 0.82, c: [249, 115, 22] },
    { t: 1.00, c: [220, 38, 38] }
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const f = (t - a.t) / Math.max(1e-9, b.t - a.t);
  const rgb = a.c.map((v, i) => Math.round(v + (b.c[i] - v) * f));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function findChangeBoundingBox(diff, width, height, threshold) {
  let minX = width - 1, maxX = 0, minY = height - 1, maxY = 0, found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = diff[y * width + x];
      if (!Number.isFinite(d) || Math.abs(d) <= threshold) continue;
      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!found) {
    minX = Math.floor(width * 0.25); maxX = Math.floor(width * 0.75);
    minY = Math.floor(height * 0.25); maxY = Math.floor(height * 0.75);
  }
  const padX = Math.max(1, Math.round((maxX - minX) * 0.10));
  const padY = Math.max(1, Math.round((maxY - minY) * 0.10));
  return {
    minX: clamp(minX - padX, 0, width - 1), maxX: clamp(maxX + padX, 0, width - 1),
    minY: clamp(minY - padY, 0, height - 1), maxY: clamp(maxY + padY, 0, height - 1)
  };
}

const uniqueSorted = values => [...new Set(values.map(v => Math.round(v)))].sort((a, b) => a - b);

function buildSectionPlan(diff, width, height, params) {
  const bbox = findChangeBoundingBox(diff, width, height, params.thresholdTimbunan);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  return {
    bbox,
    longRows: uniqueSorted([bbox.minY, (bbox.minY + cy) / 2, cy, (cy + bbox.maxY) / 2, bbox.maxY]),
    crossCols: uniqueSorted([bbox.minX, (bbox.minX + cx) / 2, cx, (cx + bbox.maxX) / 2, bbox.maxX])
  };
}

function buildHeatmapSvg(diff, width, height, params, summary, sectionPlan) {
  const scaleLimit = 760;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / scaleLimit));
  const mapW = Math.ceil(width / step);
  const mapH = Math.ceil(height / step);
  const m = { l: 34, r: 12, t: 12, b: 42 };
  const W = mapW + m.l + m.r;
  const H = mapH + m.t + m.b;
  const minDiff = summary.hasil.galianTerdalamM;
  const maxDiff = summary.hasil.timbunanTertinggiM;
  const pxInterval = Math.max(1, Math.round(params.gridInterval / params.spatialResolution));
  const gridEvery = Math.max(1, Math.round(pxInterval / step));
  const rects = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      rects.push(`<rect x="${m.l + Math.floor(x / step)}" y="${m.t + Math.floor(y / step)}" width="1" height="1" fill="${gradientColor(diff[y * width + x], minDiff, maxDiff)}"/>`);
    }
  }

  const grid = [];
  for (let gx = 0; gx <= mapW; gx += gridEvery) {
    grid.push(`<line x1="${m.l + gx}" y1="${m.t}" x2="${m.l + gx}" y2="${m.t + mapH}" stroke="#0f172a" stroke-width="0.18" opacity="0.18"/>`);
    const label = fmt(gx * step * params.spatialResolution, 0);
    grid.push(`<text x="${m.l + gx + 1}" y="${m.t + mapH + 11}" font-size="6.8" fill="#475569">${label}</text>`);
  }
  for (let gy = 0; gy <= mapH; gy += gridEvery) {
    grid.push(`<line x1="${m.l}" y1="${m.t + gy}" x2="${m.l + mapW}" y2="${m.t + gy}" stroke="#0f172a" stroke-width="0.18" opacity="0.18"/>`);
    const label = fmt(gy * step * params.spatialResolution, 0);
    grid.push(`<text x="3" y="${m.t + gy + 3}" font-size="6.8" fill="#475569">${label}</text>`);
  }

  const sectionLines = [];
  sectionPlan.longRows.forEach((row, i) => {
    const y = m.t + Math.round(row / step);
    sectionLines.push(`<line x1="${m.l}" y1="${y}" x2="${m.l + mapW}" y2="${y}" stroke="#fde047" stroke-width="1.1" opacity="0.96"/>`);
    sectionLines.push(`<text x="${m.l + mapW + 3}" y="${y + 2}" font-size="6.8" fill="#a16207">LS-${i + 1}</text>`);
  });
  sectionPlan.crossCols.forEach((col, i) => {
    const x = m.l + Math.round(col / step);
    sectionLines.push(`<line x1="${x}" y1="${m.t}" x2="${x}" y2="${m.t + mapH}" stroke="#2563eb" stroke-width="1.1" opacity="0.96"/>`);
    sectionLines.push(`<text x="${x - 7}" y="${m.t - 2}" font-size="6.8" fill="#1d4ed8">CS-${i + 1}</text>`);
  });

  const legendY = H - 18;
  const legend = `
    <defs>
      <linearGradient id="grad" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="#2563eb"/><stop offset="22%" stop-color="#22d3ee"/>
        <stop offset="45%" stop-color="#22c55e"/><stop offset="65%" stop-color="#facc15"/>
        <stop offset="82%" stop-color="#f97316"/><stop offset="100%" stop-color="#dc2626"/>
      </linearGradient>
    </defs>
    <text x="${m.l}" y="${H - 26}" font-size="6.8" fill="#334155">X (m)</text>
    <text x="7" y="${m.t - 2}" font-size="6.8" fill="#334155">Y</text>
    <rect x="${m.l + 44}" y="${legendY}" width="132" height="7" rx="3.5" fill="url(#grad)" stroke="#cbd5e1" stroke-width="0.45"/>
    <text x="${m.l + 44}" y="${legendY - 2}" font-size="6.6" fill="#475569">Low / cut</text>
    <text x="${m.l + 149}" y="${legendY - 2}" font-size="6.6" fill="#475569">High / fill</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#f8fafc"/>
    ${rects.join('')}
    ${grid.join('')}
    <rect x="${m.l}" y="${m.t}" width="${mapW}" height="${mapH}" fill="none" stroke="#cbd5e1" stroke-width="0.5"/>
    ${sectionLines.join('')}
    ${legend}
  </svg>`;
}

function buildProfileHorizontal(demAwal, demAkhir, diff, width, row, params, label) {
  const points = [];
  let minElev = Infinity, maxElev = -Infinity, cutArea = 0, fillArea = 0, cutVol = 0, fillVol = 0;
  for (let x = 0; x < width; x++) {
    const i = row * width + x;
    const a = demAwal[i], b = demAkhir[i], d = diff[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(d)) continue;
    points.push({ distance: x * params.spatialResolution, awal: a, akhir: b, diff: d });
    minElev = Math.min(minElev, a, b); maxElev = Math.max(maxElev, a, b);
    const stripArea = Math.abs(d) * params.spatialResolution;
    if (d > params.thresholdTimbunan) { fillArea += stripArea; fillVol += stripArea * params.profileInterval; }
    if (d < -params.thresholdTimbunan) { cutArea += stripArea; cutVol += stripArea * params.profileInterval; }
  }
  return { type: 'long', label, axisPixel: row, station: row * params.spatialResolution, points, minElev, maxElev, cutArea, fillArea, cutVol, fillVol, netVol: fillVol - cutVol };
}

function buildProfileVertical(demAwal, demAkhir, diff, width, height, col, params, label) {
  const points = [];
  let minElev = Infinity, maxElev = -Infinity, cutArea = 0, fillArea = 0, cutVol = 0, fillVol = 0;
  for (let y = 0; y < height; y++) {
    const i = y * width + col;
    const a = demAwal[i], b = demAkhir[i], d = diff[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(d)) continue;
    points.push({ distance: y * params.spatialResolution, awal: a, akhir: b, diff: d });
    minElev = Math.min(minElev, a, b); maxElev = Math.max(maxElev, a, b);
    const stripArea = Math.abs(d) * params.spatialResolution;
    if (d > params.thresholdTimbunan) { fillArea += stripArea; fillVol += stripArea * params.profileInterval; }
    if (d < -params.thresholdTimbunan) { cutArea += stripArea; cutVol += stripArea * params.profileInterval; }
  }
  return { type: 'cross', label, axisPixel: col, station: col * params.spatialResolution, points, minElev, maxElev, cutArea, fillArea, cutVol, fillVol, netVol: fillVol - cutVol };
}

function buildSelectedProfiles(demAwal, demAkhir, diff, width, height, params, sectionPlan) {
  const longProfiles = sectionPlan.longRows.map((row, i) => buildProfileHorizontal(demAwal, demAkhir, diff, width, row, params, `LS-${i + 1}`)).filter(p => p.points.length);
  const crossProfiles = sectionPlan.crossCols.map((col, i) => buildProfileVertical(demAwal, demAkhir, diff, width, height, col, params, `CS-${i + 1}`)).filter(p => p.points.length);
  return { longProfiles, crossProfiles, allProfiles: [...longProfiles, ...crossProfiles] };
}

function buildProfilesCsv(profiles) {
  const lines = ['profile_label,profile_type,station_m,axis_pixel,distance_m,elevasi_awal_m,elevasi_akhir_m,selisih_m'];
  profiles.forEach(p => p.points.forEach(q => lines.push(`${p.label},${p.type},${fmt(p.station, 3)},${p.axisPixel},${fmt(q.distance, 3)},${fmt(q.awal, 4)},${fmt(q.akhir, 4)},${fmt(q.diff, 4)}`)));
  return lines.join('\n');
}

function buildSectionSvg(profile, widthPx = 940, heightPx = 380) {
  const pad = { l: 58, r: 22, t: 36, b: 84 };
  const chartW = widthPx - pad.l - pad.r;
  const chartH = heightPx - pad.t - pad.b;
  const minElev = profile.minElev - 0.5;
  const maxElev = profile.maxElev + 0.5;
  const maxDist = profile.points.at(-1)?.distance || 1;
  const sx = d => pad.l + (d / Math.max(maxDist, 1e-9)) * chartW;
  const sy = z => pad.t + (1 - (z - minElev) / Math.max(maxElev - minElev, 1e-9)) * chartH;

  const grids = [];
  for (let i = 0; i <= 5; i++) {
    const y = pad.t + i * chartH / 5;
    const val = maxElev - i * (maxElev - minElev) / 5;
    grids.push(`<line x1="${pad.l}" y1="${y}" x2="${pad.l + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5" opacity="0.35"/>`);
    grids.push(`<text x="10" y="${y + 4}" font-size="11" fill="#64748b">${fmt(val, 2)}</text>`);
  }
  for (let i = 0; i <= 10; i++) {
    const x = pad.l + i * chartW / 10;
    const d = i * maxDist / 10;
    grids.push(`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + chartH}" stroke="#334155" stroke-width="0.5" opacity="0.22"/>`);
    grids.push(`<text x="${x - 12}" y="${pad.t + chartH + 18}" font-size="10" fill="#64748b">${fmt(d, 1)}</text>`);
  }

  const areaPolys = [];
  for (let i = 1; i < profile.points.length; i++) {
    const a = profile.points[i - 1], b = profile.points[i];
    const avg = (a.diff + b.diff) / 2;
    if (Math.abs(avg) < 1e-9) continue;
    const fill = avg > 0 ? 'rgba(249,115,22,0.30)' : 'rgba(37,99,235,0.24)';
    areaPolys.push(`<polygon points="${sx(a.distance)},${sy(a.awal)} ${sx(a.distance)},${sy(a.akhir)} ${sx(b.distance)},${sy(b.akhir)} ${sx(b.distance)},${sy(b.awal)}" fill="${fill}"/>`);
  }

  const lineAwal = profile.points.map(p => `${sx(p.distance).toFixed(1)},${sy(p.awal).toFixed(1)}`).join(' ');
  const lineAkhir = profile.points.map(p => `${sx(p.distance).toFixed(1)},${sy(p.akhir).toFixed(1)}`).join(' ');
  const sectionTitle = profile.type === 'long' ? 'Long Section' : 'Cross Section';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" class="section-svg">
    <rect width="${widthPx}" height="${heightPx}" rx="18" fill="#020617"/>
    <text x="${pad.l}" y="24" font-size="16" font-weight="700" fill="#e2e8f0">${profile.label} • ${sectionTitle} • STA ${fmt(profile.station, 2)} m</text>
    <text x="${pad.l}" y="${heightPx - 12}" font-size="11" fill="#94a3b8">Distance (m)</text>
    <text x="10" y="18" font-size="11" fill="#94a3b8">Elevation (m)</text>
    ${grids.join('')}
    ${areaPolys.join('')}
    <polyline points="${lineAwal}" fill="none" stroke="#ef4444" stroke-width="1.7"/>
    <polyline points="${lineAkhir}" fill="none" stroke="#38bdf8" stroke-width="2.1"/>
    <rect x="${pad.l}" y="${heightPx - 48}" width="420" height="30" rx="8" fill="#0f172a" stroke="#1d4ed8"/>
    <text x="${pad.l + 12}" y="${heightPx - 28}" font-size="12" fill="#e2e8f0">Existing = DTM Awal | Design/Final = DTM Akhir | Fill ${fmt(profile.fillVol, 2)} m³ | Cut ${fmt(profile.cutVol, 2)} m³</text>
  </svg>`;
}

function buildSectionHtml(longProfiles, crossProfiles) {
  return `
    <div class="section-group-title">Long Section</div>
    ${longProfiles.map(p => buildSectionSvg(p)).join('\n')}
    <div class="section-group-title">Cross Section</div>
    ${crossProfiles.map(p => buildSectionSvg(p)).join('\n')}`;
}

async function createSectionPdf(filePath, title, profiles, summary, params) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    const out = fs.createWriteStream(filePath);
    doc.pipe(out);

    profiles.forEach((p, idx) => {
      if (idx > 0) doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
      const pageW = 842, pageH = 595;
      const box = { x: 36, y: 110, w: 760, h: 340 };
      const headerY = 34;
      const minElev = p.minElev - 0.5;
      const maxElev = p.maxElev + 0.5;
      const maxDist = p.points.at(-1)?.distance || 1;
      const sx = d => box.x + (d / Math.max(maxDist, 1e-9)) * box.w;
      const sy = z => box.y + box.h - ((z - minElev) / Math.max(maxElev - minElev, 1e-9)) * box.h;

      doc.roundedRect(26, 24, pageW - 52, pageH - 48, 12).lineWidth(1).stroke('#cbd5e1');
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text(title, 0, headerY, { align: 'center' });
      doc.font('Helvetica-Bold').fontSize(13).text(`${p.label} • ${p.type === 'long' ? 'Long Section' : 'Cross Section'} • STA ${fmt(p.station, 2)} m`, 38, 60);
      doc.font('Helvetica').fontSize(9).fillColor('#334155');
      doc.text(`Project : ${summary.projectName}`, 38, 80);
      doc.text(`CRS : ${summary.metadata.sistemKoordinat}`, 190, 80);
      doc.text(`Resolution : ${fmt(params.spatialResolution, 3)} m`, 430, 80);
      doc.text(`Interval : ${fmt(params.profileInterval, 2)} m`, 590, 80);

      doc.roundedRect(620, 52, 176, 42, 8).lineWidth(0.8).stroke('#94a3b8');
      doc.fontSize(8).fillColor('#475569');
      doc.text(`Existing / DTM Awal`, 632, 61);
      doc.text(`Design / Final / DTM Akhir`, 632, 74);
      doc.text(`Fill ${fmt(p.fillVol, 2)} m³ | Cut ${fmt(p.cutVol, 2)} m³`, 632, 87);
      doc.strokeColor('#ef4444').lineWidth(1.3).moveTo(774, 64).lineTo(790, 64).stroke();
      doc.strokeColor('#0284c7').lineWidth(1.6).moveTo(774, 77).lineTo(790, 77).stroke();

      doc.lineWidth(0.8).strokeColor('#94a3b8').rect(box.x, box.y, box.w, box.h).stroke();
      doc.strokeColor('#dbe3ef').lineWidth(0.5);
      for (let i = 1; i < 5; i++) {
        const yy = box.y + i * box.h / 5;
        doc.moveTo(box.x, yy).lineTo(box.x + box.w, yy).stroke();
      }
      for (let i = 1; i < 10; i++) {
        const xx = box.x + i * box.w / 10;
        doc.moveTo(xx, box.y).lineTo(xx, box.y + box.h).stroke();
      }

      doc.fontSize(8).fillColor('#475569');
      for (let i = 0; i <= 5; i++) {
        const yy = box.y + i * box.h / 5;
        const val = maxElev - i * (maxElev - minElev) / 5;
        doc.text(fmt(val, 2), 6, yy - 4, { width: 26, align: 'right' });
      }
      for (let i = 0; i <= 10; i++) {
        const xx = box.x + i * box.w / 10;
        const val = i * maxDist / 10;
        doc.text(fmt(val, 1), xx - 10, box.y + box.h + 6, { width: 24, align: 'center' });
      }
      doc.fontSize(8).text('Elevation (m)', 6, box.y - 18);
      doc.text('Distance / Station (m)', box.x + box.w / 2 - 40, box.y + box.h + 20);

      const sampled = p.points.filter((_, i) => i % Math.max(1, Math.floor(p.points.length / 240)) === 0);
      // area shading
      for (let i = 1; i < sampled.length; i++) {
        const a = sampled[i - 1], b = sampled[i];
        const avg = (a.diff + b.diff) / 2;
        if (Math.abs(avg) < 1e-9) continue;
        const poly = [sx(a.distance), sy(a.awal), sx(a.distance), sy(a.akhir), sx(b.distance), sy(b.akhir), sx(b.distance), sy(b.awal)];
        doc.save();
        doc.fillOpacity(avg > 0 ? 0.18 : 0.16).fillColor(avg > 0 ? '#f97316' : '#2563eb');
        doc.moveTo(poly[0], poly[1])
          .lineTo(poly[2], poly[3])
          .lineTo(poly[4], poly[5])
          .lineTo(poly[6], poly[7])
          .closePath()
          .fill();
        doc.restore();
      }
      doc.strokeColor('#ef4444').lineWidth(1.2);
      sampled.forEach((pt, i) => i === 0 ? doc.moveTo(sx(pt.distance), sy(pt.awal)) : doc.lineTo(sx(pt.distance), sy(pt.awal)));
      doc.stroke();
      doc.strokeColor('#0284c7').lineWidth(1.6);
      sampled.forEach((pt, i) => i === 0 ? doc.moveTo(sx(pt.distance), sy(pt.akhir)) : doc.lineTo(sx(pt.distance), sy(pt.akhir)));
      doc.stroke();

      // compact table
      const tx = 38, ty = 470, tw = 360, rowH = 18;
      doc.roundedRect(tx, ty, tw, 94, 6).lineWidth(0.8).stroke('#94a3b8');
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text('Section Summary', tx + 10, ty + 8);
      doc.font('Helvetica').fontSize(8).fillColor('#334155');
      const rows = [
        ['Station', `${fmt(p.station, 2)} m`],
        ['Fill Area', `${fmt(p.fillArea, 2)} m²`],
        ['Cut Area', `${fmt(p.cutArea, 2)} m²`],
        ['Fill Volume', `${fmt(p.fillVol, 2)} m³`],
        ['Cut Volume', `${fmt(p.cutVol, 2)} m³`],
        ['Net Volume', `${fmt(p.netVol, 2)} m³`]
      ];
      rows.forEach((r, i) => {
        const y = ty + 24 + i * 11;
        doc.text(r[0], tx + 10, y);
        doc.text(r[1], tx + 120, y);
      });
    });

    doc.end();
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

async function readAoiInfo(file) {
  if (!file) return { used: false, note: 'AOI tidak digunakan.' };
  const ext = path.extname(file.originalname).toLowerCase();
  return { used: true, filename: file.originalname, extension: ext, note: 'AOI diterima sebagai batas kerja / dokumentasi. Parsing penuh dapat dikembangkan pada versi GIS lanjutan.' };
}

app.post('/api/calculate', upload.fields([
  { name: 'dtmAwal', maxCount: 1 },
  { name: 'dtmAkhir', maxCount: 1 },
  { name: 'aoiFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const awalFile = req.files?.dtmAwal?.[0];
    const akhirFile = req.files?.dtmAkhir?.[0];
    const aoiFile = req.files?.aoiFile?.[0];
    if (!awalFile || !akhirFile) return res.status(400).json({ error: 'Upload DTM Awal dan DTM Akhir wajib diisi.' });

    const params = {
      tanggalAwal: req.body.tanggalAwal || '-',
      tanggalAkhir: req.body.tanggalAkhir || '-',
      crsInfo: req.body.crsInfo || 'UTM / Local CRS',
      spatialResolution: toNumber(req.body.spatialResolution, 0.1),
      thresholdTimbunan: toNumber(req.body.thresholdTimbunan, 0.05),
      thresholdStabil: toNumber(req.body.thresholdStabil, 0.05),
      profileInterval: toNumber(req.body.profileInterval, 1),
      gridInterval: toNumber(req.body.gridInterval, 5),
      projectName: req.body.projectName || 'Analisis Volume Timbunan',
      preparedBy: req.body.preparedBy || 'Egi Nugraha'
    };

    const awal = await readGeoTiff(awalFile.path);
    const akhirRaw = await readGeoTiff(akhirFile.path);
    const aoiInfo = await readAoiInfo(aoiFile);
    const width = awal.width, height = awal.height, total = width * height;
    const demAwal = new Float64Array(total), demAkhir = new Float64Array(total), diff = new Float64Array(total);
    let validCount = 0, fillCount = 0, cutCount = 0, stableCount = 0, sumDiff = 0, maxDiff = -Infinity, minDiff = Infinity, volumeFill = 0, volumeCut = 0;
    const areaPerPixel = params.spatialResolution * params.spatialResolution;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const a = awal.raster[i];
        const b = (akhirRaw.width === width && akhirRaw.height === height) ? akhirRaw.raster[i] : sampleNearest(akhirRaw, x, y, width, height);
        if (isNoData(a, awal.nodata) || isNoData(b, akhirRaw.nodata)) { demAwal[i] = NaN; demAkhir[i] = NaN; diff[i] = NaN; continue; }
        demAwal[i] = a; demAkhir[i] = b;
        const d = b - a; diff[i] = d; validCount++; sumDiff += d; maxDiff = Math.max(maxDiff, d); minDiff = Math.min(minDiff, d);
        if (d > params.thresholdTimbunan) fillCount++; else if (d < -params.thresholdTimbunan) cutCount++; else if (d >= -params.thresholdStabil && d <= params.thresholdStabil) stableCount++;
        if (d > 0) volumeFill += d * areaPerPixel;
        if (d < 0) volumeCut += Math.abs(d) * areaPerPixel;
      }
    }

    const summary = {
      projectName: params.projectName,
      metadata: {
        preparedBy: params.preparedBy,
        contact: { email: 'egi.geomatika@gmail.com', whatsapp: '0895604053590' },
        dataAwal: awalFile.originalname, dataAkhir: akhirFile.originalname, aoi: aoiInfo,
        tanggalAkuisisiAwal: params.tanggalAwal, tanggalAkuisisiAkhir: params.tanggalAkhir,
        sistemKoordinat: params.crsInfo, resolusiSpasialMeter: params.spatialResolution, ukuranRaster: { width, height },
        catatanGrid: akhirRaw.width === width && akhirRaw.height === height ? 'Grid DTM sama.' : 'DTM akhir di-resample sederhana mengikuti ukuran DTM awal.'
      },
      hasil: {
        volumeTimbunanM3: volumeFill, volumeGalianM3: volumeCut, netVolumeM3: volumeFill - volumeCut,
        perubahanRataRataM: validCount ? sumDiff / validCount : 0, timbunanTertinggiM: maxDiff, galianTerdalamM: minDiff,
        luasAreaTimbunanM2: fillCount * areaPerPixel, luasAreaGalianM2: cutCount * areaPerPixel, luasAreaStabilM2: stableCount * areaPerPixel, pixelValid: validCount
      },
      parameter: params
    };

    const jobId = `hasil_${Date.now()}`;
    const jobDir = path.join(OUTPUT_DIR, jobId);
    await fsp.mkdir(jobDir, { recursive: true });

    const sectionPlan = buildSectionPlan(diff, width, height, params);
    const { longProfiles, crossProfiles, allProfiles } = buildSelectedProfiles(demAwal, demAkhir, diff, width, height, params, sectionPlan);
    const heatmapSvg = buildHeatmapSvg(diff, width, height, params, summary, sectionPlan);
    const profilesCsv = buildProfilesCsv(allProfiles);
    const sectionsHtml = buildSectionHtml(longProfiles, crossProfiles);

    const report = [
      '==========================================================',
      '      LAPORAN ANALISIS VOLUME TIMBUNAN & GALIAN',
      '==========================================================',
      `Nama Proyek:             ${params.projectName}`,
      `Disiapkan oleh:          ${params.preparedBy}`,
      `Email:                   egi.geomatika@gmail.com`,
      `WhatsApp:                0895604053590`,
      `Tanggal Laporan:         ${new Date().toLocaleString('id-ID')}`,
      '',
      '--- METADATA PROYEK ---',
      `Data Awal:               ${awalFile.originalname}`,
      `Data Akhir:              ${akhirFile.originalname}`,
      `AOI Optional:            ${aoiInfo.filename || '-'} | ${aoiInfo.note}`,
      `Sistem Koordinat:        ${params.crsInfo}`,
      `Resolusi Spasial:        ${params.spatialResolution} meter`,
      `Ukuran Raster:           ${width} x ${height} pixel`,
      '',
      '--- HASIL VOLUME ---',
      `Volume Timbunan:         ${fmt(volumeFill, 3)} m3`,
      `Volume Galian:           ${fmt(volumeCut, 3)} m3`,
      `Net Volume:              ${fmt(volumeFill - volumeCut, 3)} m3`,
      `Luas Area Timbunan:      ${fmt(fillCount * areaPerPixel, 3)} m2`,
      `Luas Area Galian:        ${fmt(cutCount * areaPerPixel, 3)} m2`,
      `Timbunan Tertinggi:      ${fmt(maxDiff, 3)} m`,
      `Galian Terdalam:         ${fmt(minDiff, 3)} m`,
      '',
      '--- SECTION PLAN ---',
      `Long Section (LS):       ${longProfiles.map(p => `${p.label} @ STA ${fmt(p.station, 2)} m`).join(', ')}`,
      `Cross Section (CS):      ${crossProfiles.map(p => `${p.label} @ STA ${fmt(p.station, 2)} m`).join(', ')}`,
      '',
      'Catatan: peta top view dibuat bersih dengan label grid kecil. Export PDF dipisah antara long section dan cross section per sheet.'
    ].join('\n');

    await fsp.writeFile(path.join(jobDir, 'laporan_volume.txt'), report, 'utf8');
    await fsp.writeFile(path.join(jobDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    await fsp.writeFile(path.join(jobDir, 'peta_heatmap_grid.svg'), heatmapSvg, 'utf8');
    await fsp.writeFile(path.join(jobDir, 'profil_lintas.csv'), profilesCsv, 'utf8');
    await fsp.writeFile(path.join(jobDir, 'sections_preview.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Sections Preview</title><style>body{font-family:Arial;background:#f8fafc;padding:20px}.section-svg{width:100%;margin:0 0 18px}.section-group-title{font-weight:700;font-size:22px;margin:20px 0 10px}</style></head><body>${sectionsHtml}</body></html>`, 'utf8');
    await createSectionPdf(path.join(jobDir, 'long_sections.pdf'), 'Long Section Report', longProfiles, summary, params);
    await createSectionPdf(path.join(jobDir, 'cross_sections.pdf'), 'Cross Section Report', crossProfiles, summary, params);

    const zipPath = path.join(jobDir, 'hasil_volume.zip');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      out.on('close', resolve); archive.on('error', reject); archive.pipe(out);
      ['laporan_volume.txt','summary.json','peta_heatmap_grid.svg','profil_lintas.csv','sections_preview.html','long_sections.pdf','cross_sections.pdf']
        .forEach(name => archive.file(path.join(jobDir, name), { name }));
      archive.finalize();
    });

    res.json({
      jobId,
      summary,
      heatmapUrl: `/output/${jobId}/peta_heatmap_grid.svg`,
      reportUrl: `/output/${jobId}/laporan_volume.txt`,
      profilesUrl: `/output/${jobId}/profil_lintas.csv`,
      sectionsHtml,
      sectionsPreviewUrl: `/output/${jobId}/sections_preview.html`,
      longPdfUrl: `/output/${jobId}/long_sections.pdf`,
      crossPdfUrl: `/output/${jobId}/cross_sections.pdf`,
      zipUrl: `/output/${jobId}/hasil_volume.zip`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Terjadi kesalahan saat memproses raster.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Network ready on port ${PORT}`);
});
