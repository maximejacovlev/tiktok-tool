const Busboy = require('busboy');

function parseMultipartFiles(req, { limits } = {}) {
  return new Promise((resolve, reject) => {
    const files = [];
    const busboy = Busboy({
      headers: req.headers,
      limits: limits || { fileSize: 15 * 1024 * 1024, files: 30 },
    });

    busboy.on('file', (_field, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => reject(new Error(`Fichier trop volumineux: ${info.filename}`)));
      stream.on('end', () => {
        files.push({
          originalname: info.filename || 'image',
          mimetype: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks),
        });
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => resolve(files));
    req.pipe(busboy);
  });
}

module.exports = { parseMultipartFiles };
