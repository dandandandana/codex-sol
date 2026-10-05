function abortReason(signal) {
  return signal.reason === undefined
    ? new DOMException('The operation was aborted', 'AbortError')
    : signal.reason;
}

export async function withRetry(operation, { attempts = 3, signal } = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new RangeError('attempts must be an integer from 1 to 5');
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }

    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 === attempts) {
        throw error;
      }
    }
  }
}
