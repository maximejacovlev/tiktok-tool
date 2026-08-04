const PROJECT_STATUSES = ['to_edit', 'wip', 'ready_to_post', 'posted'];

function isAvailable() {
  return false;
}

module.exports = { PROJECT_STATUSES, isAvailable };
