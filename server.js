const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const archiver = require('archiver');
const { fromFile } = require('geotiff');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const INPUT_DIR = path.join(ROOT, 'input');
const OUTPUT_DIR = path.join(ROOT, 'output');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

for (const dir of [INPUT_DIR, OUTPUT_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT_DIR));
app.use(express.json({ limit: '10mb' }));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function readGeoTiff(filePath) {
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const raster = await image.readRasters({ samples: [0], interleave: true });
  const nodataRaw = image.getGDALNoData();
  const nodata = nodataRaw !== null && nodataRaw !== undefined && nodataRaw !== '' ? Number(nodataRaw) : null;
  let origin = [0, 0];
  let resolution = [1, -1];
  try { origin = image.getOrigin(); } catch (_) {}
  try { resolution = image.getResolution(); } catch (_) {}
  return { filePath, width, height, raster, nodata, origin, resolution };
}

function sampleNearest(source, targetX, targetY, targetWidth, targetHeight) {
  const sx = Math.min(source.width - 1, Math.max(0, Math.round(targetX * (source.width - 1) / Math.max(1, targetWidth - 1))));
  const sy = Math.min(source.height - 1, Math.max(0, Math.round(targetY * (source.height - 1) / Math.max(1, targetHeight - 1))));
  return source.raster[sy * source.width + sx];
}

function isNoData(v, nodata) {
  if (!Number.isFinite(v)) return true;
  if (nodata !== null && Number.isFinite(nodata) && v === nodata) return true;
  return false;
}

function makeColor(value, maxFill) {
  if (!Number.isFinite(value)) return '#111827';
  if (value < -0.05) return '#dc2626';
  if (value <= 0.05) return '#d1d5db';
  if (value <= 0.5) return '#93c5fd';
  if (value <= 1.0) return '#3b82f6';
  if (value <= 2.0) return '#1d4ed8';
  return '#172554';
}

function buildSvgPreview(diff, width, height, maxFill, transform, scaleLimit = 900) {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / scaleLimit));
  const viewW = Math.ceil(width / step);
  const viewH = Math.ceil(height / step);
  const rects = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const v = diff[y * width + x];
      rects.push(`<rect x="${Math.floor(x / step)}" y="${Math.floor(y / step)}" width="1" height="1" fill="${makeColor(v, maxFill)}"/>`);
    }
  }
  for (let y = 0; y < viewH; y += Math.max(1, Math.round(10 / step))) {
    rects.push(`<line x1="0" y1="${y}" x2="${viewW}" y2="${y}" stroke="#000" stroke-width="0.15" opacity="0.35"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW} ${viewH}" shape-rendering="crispEdges">
<title>Peta klasifikasi timbunan</title>${rects.join('')}</svg>`;
}

function buildProfilesCsv(demAwal, demAkhir, width, height, resolution, intervalM) {
  const pxInterval = Math.max(1, Math.round(intervalM / resolution));
  const lines = ['profile_row,x_pixel,distance_m,elevasi_awal_m,elevasi_akhir_m,selisih_m'];
  for (let y = 0; y < height; y += pxInterval) {
    for (let x = 0; x < width; x++) {
      const a = demAwal[y * width + x];
      const b = demAkhir[y * width + x];
      if (Number.isFinite(a) && Number.isFinite(b)) {
        lines.push(`${y},${x},${(x * resolution).toFixed(3)},${a.toFixed(4)},${b.toFixed(4)},${(b-a).toFixed(4)}`);
      }
    }
  }
  return lines.join('\n');
}

app.post('/api/calculate', upload.fields([{ name: 'dtmAwal', maxCount: 1 }, { name: 'dtmAkhir', maxCount: 1 }]), async (req, res) => {
  try {
    const awalFile = req.files?.dtmAwal?.[0];
    const akhirFile = req.files?.dtmAkhir?.[0];
    if (!awalFile || !akhirFile) return res.status(400).json({ error: 'Upload DTM Awal dan DTM Akhir wajib diisi.' });

    const params = {
      tanggalAwal: req.body.tanggalAwal || '-',
      tanggalAkhir: req.body.tanggalAkhir || '-',
      crsInfo: req.body.crsInfo || 'UTM / Local CRS',
      spatialResolution: toNumber(req.body.spatialResolution, 0.1),
      thresholdTimbunan: toNumber(req.body.thresholdTimbunan, 0.05),
      thresholdStabil: toNumber(req.body.thresholdStabil, 0.05),
      profileInterval: toNumber(req.body.profileInterval, 1),
      projectName: req.body.projectName || 'Analisis Volume Timbunan'
    };

    const awal = await readGeoTiff(awalFile.path);
    const akhirRaw = await readGeoTiff(akhirFile.path);
    const width = awal.width;
    const height = awal.height;
    const total = width * height;
    const demAwal = new Float64Array(total);
    const demAkhir = new Float64Array(total);
    const diff = new Float64Array(total);

    let validCount = 0;
    let fillCount = 0;
    let stableCount = 0;
    let sumDiff = 0;
    let maxDiff = -Infinity;
    let minDiff = Infinity;
    let volumeFill = 0;
    let volumeCut = 0;
    const areaPerPixel = params.spatialResolution * params.spatialResolution;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const a = awal.raster[i];
        const b = (akhirRaw.width === width && akhirRaw.height === height) ? akhirRaw.raster[i] : sampleNearest(akhirRaw, x, y, width, height);
        if (isNoData(a, awal.nodata) || isNoData(b, akhirRaw.nodata)) {
          demAwal[i] = NaN; demAkhir[i] = NaN; diff[i] = NaN;
          continue;
        }
        demAwal[i] = a;
        demAkhir[i] = b;
        const d = b - a;
        diff[i] = d;
        validCount++;
        sumDiff += d;
        if (d > maxDiff) maxDiff = d;
        if (d < minDiff) minDiff = d;
        if (d > params.thresholdTimbunan) fillCount++;
        if (d >= -params.thresholdStabil && d <= params.thresholdStabil) stableCount++;
        if (d > 0) volumeFill += d * areaPerPixel;
        if (d < 0) volumeCut += Math.abs(d) * areaPerPixel;
      }
    }

    const jobId = `hasil_${Date.now()}`;
    const jobDir = path.join(OUTPUT_DIR, jobId);
    await fsp.mkdir(jobDir, { recursive: true });

    const summary = {
      projectName: params.projectName,
      metadata: {
        dataAwal: awalFile.originalname,
        dataAkhir: akhirFile.originalname,
        tanggalAkuisisiAwal: params.tanggalAwal,
        tanggalAkuisisiAkhir: params.tanggalAkhir,
        sistemKoordinat: params.crsInfo,
        resolusiSpasialMeter: params.spatialResolution,
        ukuranRaster: { width, height },
        catatanGrid: akhirRaw.width === width && akhirRaw.height === height ? 'Grid DTM sama.' : 'DTM akhir di-resample nearest sederhana mengikuti ukuran DTM awal.'
      },
      hasil: {
        volumeTimbunanM3: volumeFill,
        volumeGalianM3: volumeCut,
        netVolumeM3: volumeFill - volumeCut,
        perubahanRataRataM: validCount ? sumDiff / validCount : 0,
        timbunanTertinggiM: maxDiff,
        galianTerdalamM: minDiff,
        luasAreaTimbunanM2: fillCount * areaPerPixel,
        luasAreaStabilM2: stableCount * areaPerPixel,
        pixelValid: validCount
      },
      parameter: params
    };

    const report = [
      '==========================================================',
      '      LAPORAN ANALISIS VOLUME TIMBUNAN',
      '==========================================================',
      `Nama Proyek:             ${params.projectName}`,
      `Tanggal Laporan:         ${new Date().toLocaleString('id-ID')}`,
      '',
      '--- METADATA PROYEK ---',
      `Data Awal:               ${awalFile.originalname}`,
      `Tanggal Akuisisi Awal:   ${params.tanggalAwal}`,
      `Data Akhir:              ${akhirFile.originalname}`,
      `Tanggal Akuisisi Akhir:  ${params.tanggalAkhir}`,
      `Sistem Koordinat:        ${params.crsInfo}`,
      `Resolusi Spasial:        ${params.spatialResolution} meter`,
      `Ukuran Raster:           ${width} x ${height} pixel`,
      `Catatan Grid:            ${summary.metadata.catatanGrid}`,
      '',
      '--- HASIL ANALISIS VOLUME ---',
      `Total Volume Timbunan:   ${volumeFill.toLocaleString('id-ID', { maximumFractionDigits: 2 })} m³`,
      `Total Volume Galian:     ${volumeCut.toLocaleString('id-ID', { maximumFractionDigits: 2 })} m³`,
      `Net Volume:              ${(volumeFill - volumeCut).toLocaleString('id-ID', { maximumFractionDigits: 2 })} m³`,
      '',
      '--- STATISTIK ELEVASI ---',
      `Timbunan Tertinggi:      ${maxDiff.toFixed(3)} m`,
      `Galian Terdalam:         ${minDiff.toFixed(3)} m`,
      `Perubahan Rata-rata:     ${(validCount ? sumDiff / validCount : 0).toFixed(3)} m`,
      '',
      '--- ANALISIS SPASIAL AREA ---',
      `Luas Area Timbunan:      ${(fillCount * areaPerPixel).toLocaleString('id-ID', { maximumFractionDigits: 2 })} m²`,
      `Luas Area Stabil:        ${(stableCount * areaPerPixel).toLocaleString('id-ID', { maximumFractionDigits: 2 })} m²`,
      '=========================================================='
    ].join('\n');

    const svg = buildSvgPreview(diff, width, height, maxDiff, awal.resolution);
    const profilesCsv = buildProfilesCsv(demAwal, demAkhir, width, height, params.spatialResolution, params.profileInterval);
    const diffCsv = ['x_pixel,y_pixel,selisih_m'].concat(
      Array.from({ length: Math.min(total, 250000) }, (_, i) => {
        const v = diff[i];
        if (!Number.isFinite(v)) return null;
        const x = i % width;
        const y = Math.floor(i / width);
        return `${x},${y},${v.toFixed(4)}`;
      }).filter(Boolean)
    ).join('\n');

    await fsp.writeFile(path.join(jobDir, 'Laporan_Volume.txt'), report);
    await fsp.writeFile(path.join(jobDir, 'summary.json'), JSON.stringify(summary, null, 2));
    await fsp.writeFile(path.join(jobDir, 'peta_klasifikasi_timbunan.svg'), svg);
    await fsp.writeFile(path.join(jobDir, 'profil_lintas.csv'), profilesCsv);
    await fsp.writeFile(path.join(jobDir, 'sample_diff_map.csv'), diffCsv);

    res.json({ jobId, summary, reportUrl: `/output/${jobId}/Laporan_Volume.txt`, svgUrl: `/output/${jobId}/peta_klasifikasi_timbunan.svg`, profilesUrl: `/output/${jobId}/profil_lintas.csv`, zipUrl: `/api/download/${jobId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Terjadi kesalahan saat proses.' });
  }
});

app.get('/api/download/:jobId', async (req, res) => {
  const jobId = req.params.jobId.replace(/[^a-zA-Z0-9_-]/g, '');
  const jobDir = path.join(OUTPUT_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).send('Hasil tidak ditemukan.');
  res.attachment(`${jobId}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send(err.message));
  archive.pipe(res);
  archive.directory(jobDir, false);
  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`Dashboard aktif: http://localhost:${PORT}`);
});
