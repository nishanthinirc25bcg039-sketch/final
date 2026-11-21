const SESSION_TOKEN_KEY = 'smartstock_auth_token';

function readTabToken(): string | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage.getItem(SESSION_TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

let inMemoryToken: string | null = readTabToken();

export function setAuthToken(token: string | null) {
  inMemoryToken = token;
  try {
    if (typeof window !== 'undefined') {
      if (token) {
        window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
      } else {
        window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
      }
    }
  } catch {
    // Ignore storage access errors in restricted frames
  }
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('X-Requested-With', 'SmartStockAI');
  if (inMemoryToken) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }

  const timeoutMs = url.includes('/api/ai/') ? 45000 : 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
      signal: options.signal ?? controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out while waiting for the server. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  let data: Record<string, unknown> = {};
  let parsedAsJson = !text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') {
        data = parsed as Record<string, unknown>;
        parsedAsJson = true;
      }
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const looksLikeHtml = contentType.includes('text/html') || /^\s*<!doctype|^\s*<html/i.test(text);
    const message = looksLikeHtml
      ? `API route returned an HTML error page (HTTP ${res.status}). Check server deployment logs.`
      : typeof data.error === 'string' && data.error.trim()
        ? data.error
        : `Request failed with status ${res.status}`;
    const err = new Error(message) as Error & {
      status?: number;
      fieldErrors?: Record<string, string>;
    };
    err.status = res.status;
    if (data.fieldErrors && typeof data.fieldErrors === 'object') {
      err.fieldErrors = data.fieldErrors as Record<string, string>;
    }
    throw err;
  }

  if (text && (!parsedAsJson || contentType.includes('text/html'))) {
    throw new Error(
      'Server returned a web page instead of API data. Verify API routing and deployment configuration.'
    );
  }

  return data as T;
}

export function formatCurrency(amount: number, symbol = '$'): string {
  const num = Number(amount) || 0;
  return `${symbol}${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatShortDate(isoOrDate: string): string {
  if (!isoOrDate) return '-';
  const d = new Date(isoOrDate.length === 10 ? `${isoOrDate}T12:00:00Z` : isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function exportCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const escapeCell = (val: string | number) => {
    const str = String(val ?? '');
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csv = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
