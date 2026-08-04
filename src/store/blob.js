const { put, del, get } = require('@vercel/blob');
const { getVercelOidcToken } = require('@vercel/oidc');
const fetch = require('node-fetch');

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

function extractPathname(url) {
  try {
    return new URL(url).pathname.slice(1);
  } catch {
    return url;
  }
}

function toClientUrl(url) {
  if (!url || !isPrivateBlobUrl(url)) return url;
  const pathname = extractPathname(url);
  return `/api/blob/${pathname.split('/').map(encodeURIComponent).join('/')}`;
}

async function getAuthToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return process.env.BLOB_READ_WRITE_TOKEN;
  }
  return getVercelOidcToken();
}

async function uploadBlob(pathname, data, options = {}) {
  return put(pathname, data, {
    access: blobAccess(),
    addRandomSuffix: false,
    ...options,
  });
}

async function readBlobBuffer(storedUrlOrPathname) {
  const token = await getAuthToken();
  if (!token) return null;

  const isFullUrl = String(storedUrlOrPathname).includes('blob.vercel-storage.com');
  const pathname = isFullUrl ? extractPathname(storedUrlOrPathname) : String(storedUrlOrPathname);
  const access = isFullUrl
    ? (isPrivateBlobUrl(storedUrlOrPathname) ? 'private' : 'public')
    : blobAccess();

  if (isFullUrl) {
    const response = await fetch(storedUrlOrPathname, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      return {
        buffer: await response.buffer(),
        contentType: response.headers.get('content-type') || 'image/jpeg',
      };
    }
    if (response.status !== 404) {
      throw new Error(`Blob fetch failed: ${response.status} ${response.statusText}`);
    }
  }

  const opts = { access };
  if (process.env.BLOB_READ_WRITE_TOKEN) opts.token = process.env.BLOB_READ_WRITE_TOKEN;
  const result = await get(pathname, opts);
  if (!result || !result.stream) return null;

  return {
    buffer: Buffer.from(await result.stream.arrayBuffer()),
    contentType: result.blob.contentType || 'image/jpeg',
  };
}

module.exports = {
  isBlobConfigured,
  blobAccess,
  isPrivateBlobUrl,
  extractPathname,
  toClientUrl,
  uploadBlob,
  readBlobBuffer,
  del,
};
