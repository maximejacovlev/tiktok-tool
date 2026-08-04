const { put, del, get, list } = require('@vercel/blob');
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

function blobRefToPathname(storedRef) {
  if (!storedRef) return storedRef;
  if (String(storedRef).startsWith('http')) {
    return extractPathname(storedRef);
  }
  return String(storedRef);
}

function extractPathname(url) {
  try {
    return new URL(url).pathname.slice(1);
  } catch {
    return url;
  }
}

function toClientUrl(storedRef) {
  if (!storedRef) return storedRef;
  if (String(storedRef).startsWith('http') && !isPrivateBlobUrl(storedRef)) {
    return storedRef;
  }
  const pathname = blobRefToPathname(storedRef);
  return `/api/blob/${pathname.split('/').map(encodeURIComponent).join('/')}`;
}

async function getAuthToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return process.env.BLOB_READ_WRITE_TOKEN;
  }
  try {
    return await getVercelOidcToken();
  } catch {
    return null;
  }
}

function getReadOptions(access) {
  const opts = { access };
  if (process.env.BLOB_STORE_ID) opts.storeId = process.env.BLOB_STORE_ID;
  if (process.env.BLOB_READ_WRITE_TOKEN) opts.token = process.env.BLOB_READ_WRITE_TOKEN;
  return opts;
}

async function uploadBlob(pathname, data, options = {}) {
  if (!data || !data.length) {
    throw new Error('Fichier vide — upload impossible.');
  }
  return put(pathname, data, {
    access: blobAccess(),
    addRandomSuffix: false,
    allowOverwrite: true,
    ...options,
  });
}

async function readBlobBuffer(storedRef) {
  const pathname = blobRefToPathname(storedRef);
  const access = blobAccess();
  const opts = getReadOptions(access);

  try {
    const result = await get(pathname, opts);
    if (result?.stream) {
      return {
        buffer: Buffer.from(await result.stream.arrayBuffer()),
        contentType: result.blob.contentType || 'image/jpeg',
      };
    }
  } catch (err) {
    console.error('blob get failed:', pathname, err.message);
  }

  try {
    const token = await getAuthToken();
    if (token) {
      const listed = await list({ prefix: pathname, limit: 20, ...opts });
      const match =
        listed.blobs.find((b) => b.pathname === pathname) ||
        listed.blobs.find((b) => b.pathname.endsWith(pathname.split('/').pop())) ||
        listed.blobs[0];
      if (match?.url) {
        const response = await fetch(match.url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          return {
            buffer: await response.buffer(),
            contentType: response.headers.get('content-type') || 'image/jpeg',
          };
        }
      }
    }
  } catch (err) {
    console.error('blob list/fetch failed:', pathname, err.message);
  }

  return null;
}

async function deleteBlob(storedRef) {
  const pathname = blobRefToPathname(storedRef);
  const target = String(storedRef).startsWith('http') ? storedRef : pathname;
  await del(target, getReadOptions(blobAccess()));
}

module.exports = {
  isBlobConfigured,
  blobAccess,
  isPrivateBlobUrl,
  blobRefToPathname,
  extractPathname,
  toClientUrl,
  uploadBlob,
  readBlobBuffer,
  del: deleteBlob,
};
