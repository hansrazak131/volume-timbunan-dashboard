const form = document.getElementById('volumeForm');
const statusText = document.getElementById('statusText');
const mapFrame = document.getElementById('mapFrame');
const sectionFrame = document.getElementById('sectionFrame');
const reportBox = document.getElementById('reportBox');
const fmt = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });

function setStatus(text){ statusText.textContent = text; }
function setLink(id, url){ const a = document.getElementById(id); a.href = url; a.classList.remove('disabled'); }
function resetLinks(){ ['downloadReport','downloadMap','downloadProfile','downloadLong','downloadCross','downloadZip'].forEach(id => { const a = document.getElementById(id); a.href='#'; a.classList.add('disabled'); }); }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  resetLinks();
  setStatus('Memproses raster...');
  reportBox.textContent = 'Sedang membaca GeoTIFF, menghitung volume, membuat peta heatmap, long section, dan cross section.';
  mapFrame.textContent = 'Memproses peta heatmap...';
  sectionFrame.textContent = 'Membuat long section & cross section...';

  try {
    const fd = new FormData(form);
    const res = await fetch('/api/calculate', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memproses data.');

    const h = data.summary.hasil;
    document.getElementById('mFill').textContent = fmt.format(h.volumeTimbunanM3);
    document.getElementById('mCut').textContent = fmt.format(h.volumeGalianM3);
    document.getElementById('mNet').textContent = fmt.format(h.netVolumeM3);
    document.getElementById('mArea').textContent = fmt.format(h.luasAreaTimbunanM2);

    mapFrame.innerHTML = `<img src="${data.heatmapUrl}" alt="Peta heatmap perubahan elevasi" />`;
    sectionFrame.innerHTML = data.sectionsHtml || `<a href="${data.sectionsPreviewUrl}" target="_blank">Buka preview section</a>`;
    reportBox.textContent = JSON.stringify(data.summary, null, 2);

    setLink('downloadReport', data.reportUrl);
    setLink('downloadMap', data.heatmapUrl);
    setLink('downloadProfile', data.profilesUrl);
    setLink('downloadLong', data.longPdfUrl);
    setLink('downloadCross', data.crossPdfUrl);
    setLink('downloadZip', data.zipUrl);

    setStatus('Selesai');
    document.getElementById('hasil').scrollIntoView({ behavior:'smooth', block:'start' });
  } catch (err) {
    console.error(err);
    setStatus('Error');
    mapFrame.textContent = 'Preview gagal dibuat.';
    sectionFrame.textContent = 'Section preview gagal dibuat.';
    reportBox.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
