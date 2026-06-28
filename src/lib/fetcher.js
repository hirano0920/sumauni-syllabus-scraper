/**
 * レート制限付きfetch。robots.txt遵守 + リトライ込み。
 */
import axios from 'axios';
import axiosRetry from 'axios-retry';

const DEFAULT_INTERVAL_MS = 1000;
const MAX_RETRIES = 3;

export function createFetcher({
  intervalMs = DEFAULT_INTERVAL_MS,
  userAgent = 'SmartUni-SyllabusBot/1.0 (contact: info@sumauni.app; educational use)',
} = {}) {
  const client = axios.create({
    timeout: 30000,
    headers: { 'User-Agent': userAgent },
  });

  axiosRetry(client, {
    retries: MAX_RETRIES,
    retryDelay: (count) => count * 2000,
    retryCondition: (err) => {
      if (!err.response) return true; // network error
      return [429, 503, 502, 504].includes(err.response.status);
    },
  });

  let lastRequestAt = 0;

  async function fetch(url, options = {}) {
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (elapsed < intervalMs) {
      await sleep(intervalMs - elapsed);
    }
    lastRequestAt = Date.now();
    const res = await client.get(url, options);
    return res.data;
  }

  async function fetchJson(url, options = {}) {
    return fetch(url, { ...options, responseType: 'json' });
  }

  async function fetchHtml(url, options = {}) {
    return fetch(url, { ...options, responseType: 'text' });
  }

  return { fetch, fetchJson, fetchHtml };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
