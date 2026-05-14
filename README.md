# Dashboard Volume Timbunan DTM - Node.js

Aplikasi ini adalah konversi dari notebook Jupyter perhitungan volume timbunan menjadi dashboard web lokal berbasis Node.js.

## Fitur

- Upload DTM Awal `.tif/.tiff`
- Upload DTM Akhir `.tif/.tiff`
- Setting parameter proyek dari dashboard
- Hitung volume timbunan, galian, net volume, luas timbunan, dan area stabil
- Preview peta klasifikasi timbunan dalam SVG
- Export laporan TXT, JSON, CSV profil lintas, sample diff map CSV, dan ZIP hasil
- Bisa dibuka di localhost dan diakses perangkat lain dalam jaringan lokal

## Data input yang diperlukan

1. **DTM Awal**: GeoTIFF kondisi awal/topografi awal.
2. **DTM Akhir**: GeoTIFF kondisi akhir setelah timbunan.
3. **Parameter proyek**:
   - Nama proyek
   - Tanggal akuisisi awal
   - Tanggal akuisisi akhir
   - Sistem koordinat / geoid
   - Resolusi spasial pixel dalam meter
   - Threshold timbunan, default 0.05 m
   - Threshold stabil, default ±0.05 m
   - Interval profil lintas, default 1 m

## Cara menjalankan di Visual Studio Code

1. Install Node.js LTS.
2. Buka folder project ini di Visual Studio Code.
3. Buka terminal VS Code.
4. Jalankan:

```bash
npm install
npm start
```

5. Buka browser:

```text
http://localhost:3000
```

## Agar bisa diakses umum di jaringan lokal

Cari IP komputer server, misalnya:

```bash
ipconfig
```

Jika IP komputer adalah `192.168.1.10`, maka perangkat lain yang satu WiFi/LAN bisa membuka:

```text
http://192.168.1.10:3000
```

Pastikan firewall Windows mengizinkan Node.js atau port 3000.

## Catatan teknis penting

- Aplikasi ini membaca band pertama dari GeoTIFF.
- Jika ukuran raster DTM awal dan DTM akhir berbeda, aplikasi melakukan resampling nearest sederhana mengikuti ukuran DTM awal.
- Untuk hasil engineering final yang sangat presisi, sebaiknya DTM awal dan akhir sudah memiliki CRS, resolusi, extent, dan grid yang sama sebelum diproses.
- Reprojection penuh seperti `rasterio.warp.reproject` di Python tidak sepenuhnya digantikan di versi Node.js ini.

## Struktur folder

```text
volume-timbunan-node-dashboard/
├── server.js
├── package.json
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── input/
├── output/
└── uploads/
```
