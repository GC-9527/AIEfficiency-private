export class VisualGuardClient {
  constructor({ baseUrl = 'http://127.0.0.1:18081', apiKey = '' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async createTask(options) {
    return this.#request('POST', '/v1/tasks', options);
  }

  async preflight(taskId, payload) {
    return this.#request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/preflight`, payload);
  }

  async authorize(taskId, payload) {
    return this.#request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/authorize`, payload);
  }

  async begin(taskId, payload) {
    return this.#request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/begin`, payload);
  }

  async result(taskId, payload) {
    return this.#request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/result`, payload);
  }

  async handoff(taskId, payload) {
    return this.#request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/handoff`, payload);
  }

  async resume(taskId, payload) {
    return this.#request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/resume`, payload);
  }

  async getTask(taskId) {
    return this.#request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async #request(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}
