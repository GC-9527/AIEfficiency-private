export class GuardMetrics {
  constructor() {
    this.values = new Map();
  }

  inc(name, labels = {}, value = 1) {
    const labelText = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${key}="${String(val).replace(/["\\\n]/g, '_')}"`).join(',');
    const key = `${name}{${labelText}}`;
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  render() {
    const lines = [];
    for (const [key, value] of [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const normalized = key.endsWith('{}') ? key.slice(0, -2) : key;
      lines.push(`${normalized} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
