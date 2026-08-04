const { createFsStore } = require('./fs');
const postgresStore = require('./postgres');

let store = null;

async function getStore() {
  if (store) return store;

  if (postgresStore.isAvailable()) {
    await postgresStore.init();
    store = postgresStore;
    console.log('Storage: Vercel Postgres + Blob (persistent)');
  } else {
    store = createFsStore({
      dataRoot: process.env.VERCEL ? require('path').join('/tmp', 'tiktok-tool') : require('path').join(__dirname, '..', '..'),
    });
    if (process.env.VERCEL) {
      console.warn('Storage: /tmp (ephemeral) — connecte Postgres + Blob sur Vercel pour persister les données.');
    } else {
      console.log('Storage: local filesystem (uploads/)');
    }
  }
  return store;
}

module.exports = { getStore };
