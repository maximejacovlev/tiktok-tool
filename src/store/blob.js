const { put, del, get } = require('@vercel/blob');

function isBlobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

function blobAccess() {
  if (process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    return 'private';
  }
  return 'public';
}

function isPrivateBlobUrl(url) {
  return typeof url === 'string' && url.includes('.private.blob.vercel-storage.com');
}

function toClientUrl(url) {
  if (!url || !isPrivateBlobUrl(url)) return url;
  return `/api/blob?url=${encodeURIComponent(url)}`;
}

async function uploadBlob(pathname, data, options = {}) {
  return put(pathname, data, {
    access: blobAccess(),
    addRandomSuffix: false,
    ...options,
  });
}

async function streamBlob(url) {
  const access = isPrivateBlobUrl(url) ? 'private' : 'public';
  return get(url, { access });
}

module.exports = {
  isBlobConfigured,
  blobAccess,
  isPrivateBlobUrl,
  toClientUrl,
  uploadBlob,
  streamBlob,
  del,
};
