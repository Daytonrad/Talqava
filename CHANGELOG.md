# Changelog

What changed in Talqava, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will follow [Semantic Versioning](https://semver.org) once the first release is out.

## Unreleased

Everything so far, on the way to the first release (0.1.0).

### Organizations ([#8](https://github.com/Talqava/Talqava/pull/8), [#9](https://github.com/Talqava/Talqava/pull/9))

- An organization starts with only the owner, who builds it one position at a time.
- Positions, groups with a lead, goal and monthly budget, solid "reports to" and dotted "also works with" lines, drawn by dragging; Groups, Chart and List views; undo and a history of every change.
- Suggested positions from the mission, to accept or skip; examples to copy that never remove or redraw anything; ready-made teams dropped under any position.
- Work rules read from the lines: hand work down, request it from other groups' leads, ask anyone a question, escalate to a manager.
- Every task knows why it exists: the mission, its group's goal and the tasks above it.
- Leads can propose a new position; it waits in the inbox until the owner approves or declines.
- Export an organization as one readable file, and import it as a new one.

### Work, budgets and records

- A check before each task starts: an agent asks for what is missing instead of spending the budget guessing.
- One budget per task, shared with everything handed on from it; monthly budgets per agent, per group and for all agents.
- An audit log of every operation, and a receipt for every task.
- A Gmail-style inbox of messages from agents, with names the owner can change.

### Knowledge

- The Library: a file manager for the organization's documents, each folder or file open to agents or private, searched through each organization's own database.
- Shared memory for the organization, each group and each agent; agents start from the memory, library passages and skills that match their task.

### Models and integrations

- Any model: Claude, OpenRouter, or a local model runner, with a model check ([#2](https://github.com/Talqava/Talqava/pull/2)).
- Git and GitHub through the web, connectors (MCP servers), and Talqava as an MCP server for Claude and other AI apps.
- Cost saving: a model matched to each kind of work, when the owner switches it on.

### The app

- A desktop window layout and a Mac app, renamed Talqava ([#4](https://github.com/Talqava/Talqava/pull/4)).
- Agents as keycap characters ([#5](https://github.com/Talqava/Talqava/pull/5)); the official logo and colours.
- The crew: agents as files, tasks on their own branch, a journal that survives restarts, checked core tasks ([#3](https://github.com/Talqava/Talqava/pull/3)).
