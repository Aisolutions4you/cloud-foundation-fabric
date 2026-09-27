// Minimal durable store: one JSON file per collection, in-memory cache,
// atomic write-then-rename. Good for a single Cloud Run instance with a GCS
// FUSE volume (see terraform/). Swap for Firestore/Postgres by keeping the
// same get/put/list/patch interface.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.timers = new Map();
    mkdirSync(dir, { recursive: true });
  }

  #load(col) {
    if (!this.cache.has(col)) {
      const file = join(this.dir, `${col}.json`);
      this.cache.set(col, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
    }
    return this.cache.get(col);
  }

  #flush(col) {
    clearTimeout(this.timers.get(col));
    this.timers.set(col, setTimeout(() => this.flushNow(col), 50));
  }

  flushNow(col) {
    const file = join(this.dir, `${col}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#load(col), null, 2));
    renameSync(tmp, file);
  }

  flushAll() {
    for (const col of this.cache.keys()) {
      clearTimeout(this.timers.get(col));
      this.flushNow(col);
    }
  }

  id(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  get(col, id) {
    return this.#load(col)[id] ?? null;
  }

  put(col, doc) {
    const now = new Date().toISOString();
    const data = this.#load(col);
    const prev = data[doc.id];
    data[doc.id] = { createdAt: prev?.createdAt ?? now, ...doc, updatedAt: now };
    this.#flush(col);
    return data[doc.id];
  }

  patch(col, id, fields) {
    const cur = this.get(col, id);
    if (!cur) return null;
    return this.put(col, { ...cur, ...fields, id });
  }

  list(col, filter = () => true) {
    return Object.values(this.#load(col)).filter(filter)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }
}
