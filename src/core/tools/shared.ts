// Tools every edition has. Each is built from the store it works on, so the
// same tool runs against files locally and a database when hosted.
import { defineTool } from "../tooling.ts";
import type { JobBook } from "../schedule.ts";
import type { ConversationStore, MemoryStore, SkillStore, Tool } from "../types.ts";

export function memoryTool(memory: MemoryStore): Tool {
  return defineTool<{ action: "add" | "remove"; text?: string; id?: string }>({
    name: "memory",
    description:
      "Long-term memory that carries across every conversation. Save durable facts about the user, their preferences, their projects and lessons learned. Everything saved is shown to you at the start of each conversation, so keep entries short and remove ones that are out of date.",
    properties: {
      action: { type: "string", enum: ["add", "remove"] },
      text: { type: "string", description: "For add: the fact to remember, one or two sentences." },
      id: { type: "string", description: "For remove: the id of the entry." },
    },
    required: ["action"],
    async run(input) {
      if (input.action === "add") {
        const entry = await memory.add(input.text ?? "");
        return `Remembered (id ${entry.id}).`;
      }
      await memory.remove(input.id ?? "");
      return "Removed.";
    },
  });
}

export function conversationSearchTool(conversations: ConversationStore): Tool {
  return defineTool<{ query: string }>({
    name: "conversation_search",
    description:
      "Search the text of past conversations for a word or phrase. Use it when the user refers to something discussed before that is not in memory.",
    properties: { query: { type: "string" } },
    required: ["query"],
    async run(input) {
      const hits = await conversations.search(input.query);
      return hits.length ? JSON.stringify(hits, null, 2) : "Nothing found.";
    },
  });
}

export function skillTool(skills: SkillStore): Tool {
  return defineTool<{ action: "save" | "read"; name: string; description?: string; content?: string }>({
    name: "skill",
    description:
      "Reusable procedures you have written for yourself. After working out how to do a multi-step task the user is likely to ask for again, save the steps as a skill. Read a skill before doing a task it covers.",
    properties: {
      action: { type: "string", enum: ["save", "read"] },
      name: { type: "string", description: "Short name, e.g. weekly-report." },
      description: { type: "string", description: "For save: one line on when to use it." },
      content: { type: "string", description: "For save: the full procedure, in Markdown." },
    },
    required: ["action", "name"],
    async run(input) {
      if (input.action === "save") {
        const skill = await skills.save({ name: input.name, description: input.description ?? "", content: input.content ?? "" });
        return `Saved skill "${skill.name}".`;
      }
      const skill = (await skills.list()).find((s) => s.name === input.name);
      if (!skill) throw new Error(`No skill named "${input.name}".`);
      return skill.content;
    },
  });
}

export function scheduleTool(jobs: JobBook): Tool {
  return defineTool<{ action: "create" | "list" | "delete"; name?: string; prompt?: string; schedule?: string; id?: string }>({
    name: "schedule",
    description:
      'Scheduled jobs that you run on your own later, each in a fresh conversation with no one watching. The schedule is "every 30m", "every 2h", "every 1d", "at 2026-12-01T09:00" (once), or a 5-field cron line such as "0 9 * * 1-5", in the machine\'s local time. Write the prompt as a complete standalone instruction.',
    properties: {
      action: { type: "string", enum: ["create", "list", "delete"] },
      name: { type: "string" },
      prompt: { type: "string" },
      schedule: { type: "string" },
      id: { type: "string", description: "For delete: the job id." },
    },
    required: ["action"],
    async run(input) {
      if (input.action === "create") {
        const job = await jobs.create(input);
        return `Scheduled "${job.name}" (id ${job.id}). Next run: ${new Date(job.nextRunAt!).toString()}.`;
      }
      if (input.action === "delete") {
        await jobs.remove(input.id ?? "");
        return "Deleted.";
      }
      const all = await jobs.list();
      if (!all.length) return "No scheduled jobs.";
      return all
        .map((j) => `${j.id}  ${j.enabled ? "on " : "off"}  ${j.schedule}  ${j.name}  (next: ${j.nextRunAt || "never"})`)
        .join("\n");
    },
  });
}
