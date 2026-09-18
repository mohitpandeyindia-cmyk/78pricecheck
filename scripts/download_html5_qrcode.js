const https = require('https');
const fs = require('fs');
const path = require('path');

const url = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
const libsDir = path.join(__dirname, '../frontend/customer/js/libs');
const dest = path.join(libsDir, 'html5-qrcode.min.js');

if (!fs.existsSync(libsDir)) {
  fs.mkdirSync(libsDir, { recursive: true });
}

console.log('Downloading html5-qrcode.min.js from unpkg...');
const file = fs.createWriteStream(dest);

https.get(url, (response) => {
  if (response.statusCode === 302 || response.statusCode === 301) {
    // Handle redirect
    https.get(response.headers.location, (res2) => {
      res2.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          console.log('Download completed. File size:', fs.statSync(dest).size, 'bytes');
        });
      });
    });
  } else {
    response.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        console.log('Download completed. File size:', fs.statSync(dest).size, 'bytes');
      });
    });
  }
}).on('error', (err) => {
  fs.unlink(dest, () => {});
  console.error('Download failed:', err.message);
});
