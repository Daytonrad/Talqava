// Storage that lives in memory, to prove the core does not depend on files.
import type { Conversation, ConversationStore, Job, JobStore, MemoryEntry, MemoryStore, Skill, SkillStore } from "../src/core/index.ts";

let counter = 0;
const id = () => `id${++counter}`;

export class MemoryConversations implements ConversationStore {
  items = new Map<string, Conversation>();
  async get(key: string) {
    const found = this.items.get(key);
    return found ? structuredClone(found) : null;
  }
  async save(conversation: Conversation) {
    this.items.set(conversation.id, structuredClone(conversation));
  }
  async create(extra: Partial<Conversation> = {}) {
    const now = new Date().toISOString();
    const conversation: Conversation = { id: id(), title: "New chat", createdAt: now, updatedAt: now, source: "chat", messages: [], allowed: [], usage: { input: 0, output: 0 }, ...extra };
    await this.save(conversation);
    return conversation;
  }
  async search() {
    return [];
  }
}

export class MemoryNotes implements MemoryStore {
  items: MemoryEntry[] = [];
  async list() {
    return this.items;
  }
  async add(text: string) {
    const entry = { id: id(), text, createdAt: new Date().toISOString() };
    this.items.push(entry);
    return entry;
  }
  async remove(key: string) {
    this.items = this.items.filter((e) => e.id !== key);
  }
}

export class MemorySkills implements SkillStore {
  items: Skill[] = [];
  async list() {
    return this.items;
  }
  async save(input: { name: string; description: string; content: string }) {
    const skill = { ...input, updatedAt: new Date().toISOString() };
    this.items.push(skill);
    return skill;
  }
}

export class MemoryJobs implements JobStore {
  items: Job[] = [];
  async list() {
    return structuredClone(this.items);
  }
  async saveAll(jobs: Job[]) {
    this.items = structuredClone(jobs);
  }
}
