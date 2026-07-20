import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, ResponseObject } from '../openai/types.ts';
import { decryptJson, encryptJson } from '../account/crypto.ts';

export type StoredResponseRecord = {
  response: ResponseObject;
  /** Only messages accumulated for THIS response chain (for debugging / GET) */
  messages: ChatMessage[];
  /** Manus session uid — THE token saver. Reuse instead of replaying history. */
  manusSessionId: string;
  /** Last Manus event/message id in that session (for join_session) */
  manusLastEventId: string | null;
  accountId: string;
  expiresAt: number;
};

const DEFAULT_TTL_SECONDS = 30 * 24 * 3600;
const DISK_PATH = path.resolve('manus_profiles', 'responses.vault.json');

type DiskShape = {
  version: 1;
  encrypted: true;
  records: string; // encrypted map
};

class ResponseStore {
  private responses = new Map<string, StoredResponseRecord>();
  /** session_id (client) → latest response id */
  private sessionTips = new Map<string, string>();
  /** manusSessionId → latest response id */
  private manusTips = new Map<string, string>();
  private loaded = false;

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(DISK_PATH)) return;
      const file = JSON.parse(fs.readFileSync(DISK_PATH, 'utf8')) as DiskShape;
      const map = decryptJson<Record<string, StoredResponseRecord>>(file.records);
      const now = Math.floor(Date.now() / 1000);
      for (const [id, rec] of Object.entries(map || {})) {
        if (rec.expiresAt < now) continue;
        this.responses.set(id, rec);
        if (rec.response.session_id) this.sessionTips.set(rec.response.session_id, id);
        if (rec.manusSessionId) this.manusTips.set(rec.manusSessionId, id);
      }
    } catch (err) {
      console.warn('[response-store] disk load failed (starting empty)', err);
    }
  }

  private persist() {
    try {
      const dir = path.dirname(DISK_PATH);
      fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, StoredResponseRecord> = {};
      for (const [id, rec] of this.responses) obj[id] = rec;
      const file: DiskShape = {
        version: 1,
        encrypted: true,
        records: encryptJson(obj),
      };
      const tmp = `${DISK_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(tmp, DISK_PATH);
    } catch (err) {
      console.warn('[response-store] persist failed', err);
    }
  }

  put(record: StoredResponseRecord): void {
    this.ensureLoaded();
    this.responses.set(record.response.id, record);
    if (record.response.session_id) {
      this.sessionTips.set(record.response.session_id, record.response.id);
    }
    if (record.manusSessionId) {
      this.manusTips.set(record.manusSessionId, record.response.id);
    }
    this.persist();
  }

  get(id: string): StoredResponseRecord | null {
    this.ensureLoaded();
    const rec = this.responses.get(id);
    if (!rec) return null;
    if (rec.expiresAt < Math.floor(Date.now() / 1000)) {
      this.responses.delete(id);
      this.persist();
      return null;
    }
    return rec;
  }

  delete(id: string): boolean {
    this.ensureLoaded();
    const rec = this.responses.get(id);
    if (!rec) return false;
    this.responses.delete(id);
    if (rec.response.session_id) {
      const tip = this.sessionTips.get(rec.response.session_id);
      if (tip === id) this.sessionTips.delete(rec.response.session_id);
    }
    if (rec.manusSessionId) {
      const tip = this.manusTips.get(rec.manusSessionId);
      if (tip === id) this.manusTips.delete(rec.manusSessionId);
    }
    this.persist();
    return true;
  }

  getTip(sessionId: string): string | null {
    this.ensureLoaded();
    return this.sessionTips.get(sessionId) ?? null;
  }

  getByManusSession(manusSessionId: string): StoredResponseRecord | null {
    this.ensureLoaded();
    const tip = this.manusTips.get(manusSessionId);
    if (!tip) return null;
    return this.get(tip);
  }

  makeRecord(
    response: ResponseObject,
    messages: ChatMessage[],
    manusSessionId: string,
    manusLastEventId: string | null,
    accountId: string,
    ttlSeconds = DEFAULT_TTL_SECONDS
  ): StoredResponseRecord {
    return {
      response,
      messages,
      manusSessionId,
      manusLastEventId,
      accountId,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
  }

  prune(): number {
    this.ensureLoaded();
    const now = Math.floor(Date.now() / 1000);
    let n = 0;
    for (const [id, rec] of this.responses) {
      if (rec.expiresAt < now) {
        this.responses.delete(id);
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }
}

export const responseStore = new ResponseStore();
