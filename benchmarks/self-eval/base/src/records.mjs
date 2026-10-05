export function normalizeRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('record must be an object');
  }
  if (typeof value.name !== 'string') {
    throw new TypeError('record name must be a string');
  }
  if (typeof value.category !== 'string') {
    throw new TypeError('record category must be a string');
  }
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount)) {
    throw new TypeError('record amount must be a finite number');
  }

  const name = value.name.trim();
  if (name.length === 0) {
    throw new TypeError('record name must not be empty');
  }

  const category = value.category.trim() || 'unknown';
  return { name, category, amount: value.amount };
}
