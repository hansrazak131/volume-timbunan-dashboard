# Dashboard Volume Timbunan DTM - Static GitHub Pages

Versi ini berjalan langsung di browser dan tidak membutuhkan server.js, Node.js server, VPS, atau Cloudflare Tunnel.

## Cara publish ke GitHub Pages

1. Upload `index.html`, `style.css`, `app.js`, dan `README.md` ke repo GitHub.
2. Buka repo → Settings → Pages.
3. Source: Deploy from branch.
4. Branch: main.
5. Folder: /root.
6. Save.

Contoh link akhir:

```text
https://hansrazak131.github.io/volume-timbunan-dashboard/
```

## Catatan

- Semua proses GeoTIFF dilakukan di browser pengguna.
- Cocok untuk demo portfolio dan DTM kecil sampai sedang.
- Untuk file DTM sangat besar, versi Node/server tetap lebih kuat.
