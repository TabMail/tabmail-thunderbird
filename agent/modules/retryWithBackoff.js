/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { log } from "./utils.js";

/**
 * Whether a failed request is worth another try: network errors, 408 and 429. Not a user abort, not
 * another 4xx, not a 5xx (the backend retries those itself).
 */
export function isNetworkRetriable(e) {
  // Don't retry on 4xx client errors (except 408 Request Timeout, 429 Too Many Requests)
  const is4xxError = e.message && /Request failed: (4\d{2})/.test(e.message);
  const statusMatch = e.message && e.message.match(/Request failed: (\d{3})/);
  const statusCode = statusMatch ? parseInt(statusMatch[1]) : null;

  if (is4xxError && statusCode !== 408 && statusCode !== 429) {
    log(`[RETRY] Not retrying 4xx client error: ${e.message}`, "warn");
    return false;
  }

  // Don't retry on 5xx server errors (backend should handle retries internally)
  const is5xxError = e.message && /Request failed: (5\d{2})/.test(e.message);
  if (is5xxError) {
    log(`[RETRY] Not retrying 5xx server error: ${e.message}`, "warn");
    return false;
  }

  // Only retry network errors (fetch failures, timeouts, connection drops)
  return (
    e.name === "TypeError" || // Network errors are typically TypeErrors
    e.message.includes("network") ||
    e.message.includes("Connection lost") ||
    e.message.includes("Connection timeout") ||
    e.message.includes("Failed to fetch") ||
    statusCode === 408 ||
    statusCode === 429
  );
}

/**
 * Retry helper with exponential backoff: by default for network errors (`isNetworkRetriable`); a caller
 * with another kind of transient refusal passes its own `isRetriable`.
 *
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries (default: 3)
 * @param {number} baseDelay - Base delay in ms (default: 1000)
 * @param {AbortSignal|null} abortSignal - Optional abort signal
 * @param {(e: Error) => boolean} [isRetriable] - Which errors are tried again
 * @param {number} [jitterMs] - Most random time added to each wait (default: 1000)
 * @returns {Promise<any>} - Result from function
 */
export async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, abortSignal = null, isRetriable = isNetworkRetriable, jitterMs = 1000) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if aborted
    if (abortSignal && abortSignal.aborted) {
      throw new DOMException("User stopped execution", "AbortError");
    }

    try {
      return await fn();
    } catch (e) {
      lastError = e;

      // Don't retry on user abort
      if (e.name === "AbortError") {
        throw e;
      }

      if (!isRetriable(e) || attempt === maxRetries) {
        log(`[RETRY] Max retries reached or non-retriable error: ${e.message}`, "error");
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * jitterMs;
      log(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed: ${e.message}. Retrying in ${Math.round(delay)}ms...`, "warn");

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
