# Volume Timbunan Pro Dashboard

Dashboard Node.js untuk analisis perubahan DTM awal dan DTM akhir: volume timbunan, galian, net volume, peta heatmap grid, anotasi area prioritas, cross section, dan export laporan.

## Fitur utama

- Upload DTM Awal dan DTM Akhir `.tif/.tiff`
- Upload AOI optional `.kml`, `.geojson`, `.json`, `.shp` sebagai batas kerja/dokumentasi pemotongan
- Parameter proyek: tanggal, CRS, resolusi, threshold, interval profil
- Heatmap perubahan elevasi dengan gradien Biru-Cyan-Hijau-Kuning-Oranye-Merah
- Grid kartesian/stationing pada peta
- Anotasi area perlu timbun dan area galian/urugan
- Cross section visual ala Civil 3D sederhana
- Export: TXT, SVG, CSV, PDF Cross Section, ZIP
- Tampilan lebih bersih untuk penggunaan di localhost, Render, Railway, dan iframe WordPress

## Cara menjalankan

```bash
npm install
npm start
```

Buka:

```text
http://localhost:3000
```

## Struktur folder

```text
volume-timbunan-pro-dashboard/
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

## Catatan teknis

- Untuk hasil final engineering, DTM awal dan akhir sebaiknya sudah sama CRS, resolusi, extent, dan grid.
- Jika ukuran raster berbeda, aplikasi melakukan resampling nearest sederhana mengikuti DTM awal.
- KML/GeoJSON AOI dapat dipakai sebagai mask jika koordinatnya cocok dengan georeference raster. Untuk SHP, file diterima sebagai AOI dokumentasi; parsing SHP penuh membutuhkan paket GIS tambahan atau upload format GeoJSON/KML.
