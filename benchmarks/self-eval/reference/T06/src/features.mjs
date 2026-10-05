export function paginate(items, { offset = 0, limit = 20 } = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }
  if (!Number.isInteger(offset)) {
    throw new TypeError('offset must be an integer');
  }
  if (offset < 0 || offset > items.length) {
    throw new RangeError('offset must be between 0 and items.length');
  }
  if (!Number.isInteger(limit)) {
    throw new TypeError('limit must be an integer');
  }
  if (limit < 1 || limit > 100) {
    throw new RangeError('limit must be between 1 and 100');
  }

  const pageItems = items.slice(offset, offset + limit);
  const nextIndex = offset + pageItems.length;
  return {
    items: pageItems,
    nextOffset: nextIndex < items.length ? nextIndex : null,
    total: items.length
  };
}
