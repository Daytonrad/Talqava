# Talqava Agents

A self-hosted AI agent you run yourself. You talk to it on a private web page. It can:

- **Run code and commands** in its own working folder
- **Read and write files** there
- **Search and read the web** (and drive a real browser, optionally)
- **Call APIs**, using keys you store that it can use but never see
- **Remember** facts about you across every conversation, and search past chats
- **Write itself skills**: procedures it saves after working out how to do something
- **Work on a schedule**: "every weekday at 8, send me a digest" runs on its own
- **Use connectors** (MCP servers, on the web or on your computer) for ready-made tools, with any model

It runs on Claude with your own Anthropic API key, or free on your own computer with a local model (see [Models](#models)). Every run has a budget, so a run that goes in circles stops instead of running up a bill.

A map of how it is built is in [docs/architecture.html](docs/architecture.html) (open it in a browser), with the same content as data in [docs/architecture.json](docs/architecture.json).

The plan for turning this into a desktop app with a crew of bots, any model, and safe work on real code is in [docs/architecture-plan.md](docs/architecture-plan.md). Stages 0 (the engine), 1 (any model) and 2 (the crew) are built; the rest is a plan.

## Install it (macOS and Linux)

You need [git](https://git-scm.com) and [Node.js](https://nodejs.org) 22.18 or newer. Then one line:

```bash
curl -fsSL https://raw.githubusercontent.com/Talqava/Talqava/main/install.sh | sh
```

It puts the app in `~/.talqava`, adds a `talqava` command, and opens the app in your browser. Run the same line again to update; your data in `~/.talqava/data` is kept. On Windows, use WSL for now.

## Run it from the source

You need [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npm install
```

```bash
npm start
```

Open <http://localhost:8787> (or start it with `node src/local/main.ts --open` to open it for you). The first time, the Settings page asks for your Anthropic API key, or lets you choose a local model instead. Then start a chat.

Everything the agent knows is in the `data/` folder: chats, memory, skills, schedules, settings, and `data/workspace/`, the folder it works in. Back that folder up and you have backed up the agent. Delete it and the agent starts fresh.

Scheduled jobs run only while the agent is running. A job that came due while it was off runs once when it next starts.

## Memory and long chats

- **Memory carries across chats.** The agent saves lasting facts as it learns them, and says so in the chat: a "Remembered" note you can **Edit** or **Undo** on the spot. The **Memory** page lists everything, where you can add, edit, move and forget entries.
- **Projects keep work apart.** Add a project with **＋ New project** above the chat list, for a client or a piece of work. A chat in a project uses that project's memory together with your General memory, saves what it learns to that project, and searches only that project's chats and General's. Nothing from one project reaches another. Deleting a project deletes its memory and moves its chats to General.
- **No memory limit.** When there is more than fits in the model's view, each chat is given the entries that match what is being discussed, plus the newest, and the agent searches the rest when it needs to.
- **Finding past chats.** The agent's search matches words in any order and form ("pricing" finds "price" and "prices") and puts the best matches first. It matches words, not meaning: "what we charge" will not find a chat that only says "pricing".
- **Long chats.** When a chat outgrows the model, Claude summarises the older part itself. For local models the app asks the model for a running summary of the older part and keeps the latest messages whole; the summary is saved and extended as the chat grows.

## Run it on a server (always on)

On any small Linux server with Docker:

```bash
cp .env.example .env
```

Edit `.env`: set `ANTHROPIC_API_KEY` and a long `TALQAVA_PASSWORD`. Then:

```bash
docker compose up -d --build
```

The page listens on the server's own `127.0.0.1:8787` only. Reach it from your computer with an SSH tunnel:

```bash
ssh -L 8787:localhost:8787 you@your-server
```

and open <http://localhost:8787>. Tailscale, or an HTTPS reverse proxy such as Caddy in front of it, also work. Do not publish port 8787 to the internet over plain HTTP: the password would travel unencrypted.

Inside Docker the agent's shell can only touch the container and the `data/` folder, which makes "run everything without asking" a reasonable setting there.

## The crew

The window is laid out for a desktop screen. **Work in progress** shows your agents on the left, grouped by department, tasks under way in the middle (with their approvals right on the card), and completed work on the right. The box at the top assigns a task: type it and the selected agent starts, begin with `@name` to assign someone else, or type a command such as "settings" (Ctrl K or ⌘K to jump there). A task opens on its own page with its steps, its changes, its conversation and its budget. **Create an agent**, or **Edit** one, to change its name, job title, department, instructions, model, powers and limits; your version is saved as a file in your data folder.

Six standard agents ship with the app: a small company for day one, each owning one thing (customers, marketing, money, operations, technology, research). An agent is shown as a badge with its initials in its own colour; a marker on the badge and a symbol beside it show how its task is going: ● working, ◌ waiting for you, ✓ done, ■ stopped, ✕ failed, ↺ resumed.

| Agent | Badge | Department | Responsible for | Powers |
| --- | --- | --- | --- | --- |
| Business Development Specialist | `BD` | Sales | Winning customers: prospects, pitches, proposals | web, memory |
| Marketing Specialist | `MK` | Marketing | What the organization publishes and sends | web, files, memory, past chats |
| Finance Analyst | `FN` | Finance | Where the money stands, with the working shown | files, shell, APIs, memory |
| Operations Coordinator | `OC` | Operations | Procedures, follow-ups, routine checks | memory, skills, past chats, schedules |
| Technology Specialist | `TS` | Operations | Websites, scripts, automations and code | files, shell, web, memory, skills |
| Research Analyst | `RA` | Research | Business questions answered with sources | web, memory, skills, past chats |


Several quests run at once. An agent only gets the tools its powers grant: the Research Analyst cannot touch files.

**Bots are files.** Each is a short YAML file (see [crew/](crew/)) with a name, a type, its key's legend and base texture, instructions, powers, a model, approvals and a budget. To change one or add your own, put a file in your data folder's `crew/` folder; a file with the same name replaces the starter. To share bots with a project, put them in the repository's `.crew/` folder. Bots from a repository never get more than your own settings allow: they always ask before changes unless you chose "run everything", and their budget is capped at yours.

**Quests on code.** Add a repository under Settings, then choose it when you send a quest. A bot that can change files gets its own branch and working copy, starting from your last commit, so your own files and branches are not touched. When the quest stops, its page shows the changes: **Keep the changes** makes one commit on the quest's branch (merge it when you like), and **Undo the quest** removes the branch and copy as if it never happened.

**Nothing is lost.** Every step of a quest is written to a journal in `data/journals/` as it happens. If the app closes or crashes mid-quest, it picks the quest up when it starts again. A step that was cut off part-way is not repeated blindly; the bot is told it may have partly happened and checks first.

**Caution after the web.** Once a quest has read a web page or an API reply, every change it wants to make asks first, whatever the bot's approval setting. That limits what a page written to trick bots can make them do.

## The library: documents as memory

**Library** (in the rail) is where you share documents with your agents. Drop files on the page, or put them straight into the library folder (`data/organizations/<organization>/Library/`); the app reads them and agents search them as they work.

- **One database per organization.** Each organization has its own SQLite database (`data/organizations/<organization>/organization.db`, using Node's built-in SQLite, so nothing is installed). It holds every document's text in passages with a full-text index. Deleting an organization deletes its database and library.
- **What is read.** PDF, Word, PowerPoint and Excel files, text, Markdown, CSV, web pages and similar. Other files (pictures, video) are kept and found by name. A file that changes is read again; one that is deleted is forgotten.
- **Who may use a document.** The folder decides: `Everyone`, or a department's folder (`Finance`, `Sales`, …). On the Library page you can change any single document to every agent, some departments, or named agents. An agent never sees a document that is not shared with it or its department.
- **How agents use it.** Every agent has a `library` tool: search (the passages that match, in any word order or form, with the document each came from), read (a document a stretch at a time) and list. Only matching passages are sent to the model, so a large library costs nothing until it is used. "Check what your agents will find" on the page runs the same search as you, or as any one agent.
- **Assigning to a team.** On Work in progress the "Assign a task to" list starts with Teams; a team's task goes to its manager with the instruction to share it out and bring back one result.

## Integrations

**Integrations** (in the rail, under Connect) lists the outside tools agents work with, by category. Each has a status, its own set-up page, and a plain list of what agents can and cannot do with it.

- **Git** (Code and repositories) is the first. **Set up Git for me** does it in one click: it checks git is installed (and offers macOS's installer if not), signs in to GitHub with the sign-in this computer already has (the `gh` tool's) and sets your name for commits from it if git has none, then lists the repositories it found on this computer and on GitHub for you to connect. You can also connect a repository by its folder on this computer, or paste a web address to have it copied into `data/repos/` (a private repository needs this computer to be signed in to its host already). Each repository shows your branch, last commit, unsaved changes, where it is hosted, and the agent tasks and task branches on it. A GitHub token (kept as the `GITHUB_TOKEN` key, sent only to `api.github.com`, never shown to an agent) lets tasks read issues and pull requests; **Test** asks GitHub who it belongs to. Agents never touch your branches, push, merge or deploy (`src/local/integrations.ts`).

## Organizations, roles and the org chart

- **An organization puts bots in roles.** Each member has a title, a department and a manager, with you at the top. Open it from the Bots page (**Organization →**): an org chart and a departments view. Click a bot to change its title, department or who it reports to, to chat with it, or to send it on a quest. You can have several organizations; a bot's own file says what it can do, the organization says where it sits.
- **A structure is a management philosophy.** Each organization is run one way: functional departments, a traditional hierarchy under a general manager, a matrix, outcome teams, flat, or a structure of your own. The Organization page shows the philosophy behind each, a sample chart, the kinds of business it suits, what to watch out for, and who settles a disagreement (**Change structure**). A structure is only offered when the app makes it behave differently: it sets who may hand work to whom (`assign_task`), how work is requested across departments (`request_work`: up the chain in a hierarchy, from any department's head elsewhere), and who breaks a tie (`src/local/structures.ts`).
- **A kind of business decides who is on the chart.** Pick general business, professional services, software, retail and e-commerce, restaurants and hospitality, or manufacturing; the app recommends a structure for it. **Set up this structure** then brings in the roles that business needs (only a software business gets developers), seats them in layers, and keeps the agents you already had. Departments include Leadership, Marketing, Sales, Operations, Finance, People, Legal, Customer Support, Product, Engineering and Research.
- **Every role answers for something.** A role's file lists what it is measured on, what it decides itself and what it must take to its lead (`governance:`), and whether it leads others (`lead: true`). An agent raises what is not its to decide with `escalate`; its lead decides on a small budget or passes it up. The organization's approval limit (any spending above an amount needs you) is told to every agent.
- **Teams are the simple way in.** The **Teams** tab opens first: a tray of things to drag in (ready-made teams, your agents that are not on the chart, marketplace agents), a lane of agents reporting to you, and a card per team. Drop an agent on a lead to join its team, on another agent to start a team, on **You** to report to you; drag a lead to move its whole team; drag a ready-made team in to add all of it; drag an agent onto the remove strip to take it off. The same dragging works on the org chart.
- **The chart is yours to draw.** Drag an agent onto another to make it report there, or onto **You**. Hover an agent for **+** (add an agent beneath it, from your team or the marketplace) and **−** (take it off the chart; for a lead, either only that agent or its whole team). Agents taken off the chart stay on your team. The **Teams** tab shows each lead with its direct reports, with the same + and −. The counts on the Organization and Work in progress pages are those of the organization selected.
- **Every agent can talk to every other.** `ask_colleague` puts a question to any member, whatever the structure; it is answered on a small budget (six steps) and the answer comes back as a message. `assign_task` hands over work, within the structure's rule.
- **The organization remembers.** Shared memory has three shelves: the whole organization's, each department's, and each agent's own notes plus a line the app records for every task it finishes. Agents read and write it with `team_memory`; you can read, add and remove entries on the **Memory** tab of the Organization page (`data/org-memory.json`).
- **Tokens are spent with care.** Only the memory that bears on the task goes into a prompt (about 3,200 characters of organization memory, best matches first; the rest is one search away). An agent is told about the colleagues near it (its lead, its reports, its teammates) and gets the rest as a short directory. Questions run on a small budget, hand-offs are limited in depth and number, long conversations are summarised, and Claude's prompt caching is on.
- **Work follows the chart.** A bot with reports gets an `assign_task` tool and may hand tasks only to its direct reports. Each task runs as a quest of its own; when all of a manager's hand-offs have stopped, their reports come back to it in one message and it carries on. The general chat agent, which speaks for you, can hand a job to any member; a job for a whole department goes to its lead. Hand-offs go at most three levels down, five open at a time per conversation, and every bot's budgets still apply.
- **Chat with a bot in its role.** **Chat with …** opens a chat that answers as that bot, with its instructions, powers, model and limits. Reports from bots it assigned work to arrive in that chat.
- **Every agent has a badge.** A tile with its initials (`legend` under `character:`) in its own colour, chosen in the agent editor.
- **Teams in the marketplace.** A team is a lead and the bots that report to it (marketing, sales, engineering, research, finance, support, or a starter company under a chief of staff), added together with their reporting lines. Teams are listed in `marketplace/teams.yaml`; a bot's `listing` names its `title` and who it `reports_to`.

## Inbox, team and monthly budgets

- **Inbox** shows what needs you (approvals, work ready for review, failed checks, a bot at its budget), what is being worked on, and what got done today, across chats and bots. **Stop all bots** stops every running quest; their work so far is kept.
- **Monthly budgets.** Set one for all bots on the organization page, and one per bot on the bot's page (`monthly_budget:` in its file). A bot is warned at 80%; at 100% it starts no new work, and a quest under way is stopped with its work kept, until the budget is raised or the month turns. Spend is estimated from list prices.

## The marketplace

The **Marketplace** tab lists free, ready-made bots, each built for one job (a proofreader, a fact checker, an invoice chaser and so on). A bot's page shows its instructions in full, what it can and cannot use, and what it will and will not do. **Add to my team** saves a copy as your own bot, which is yours to edit; your copy never changes unless you change it. Every marketplace bot asks before changing anything; none can call APIs, and only the engineering bots can run shell commands.

The bots ship with the app, as files in [marketplace/](marketplace/): an ordinary bot file plus a `listing` block (category, summary, will, wont). To offer another, add a file there.

## Core quests, and checks

Five ready-made quests are on home base, each run by the bot that suits it, each checked by the app before it counts as done:

| Quest | Bot | What the app gathers first | The check |
| --- | --- | --- | --- |
| Write the changelog | Marketing Specialist | The commits since the last tag | `CHANGELOG.md` changed and covers every commit |
| Add tests for a file | Technology Specialist | | The test command passes in the engineer's copy of the repository |
| Triage open issues | Finance Analyst | The open issues, from GitHub | Every issue is covered |
| Morning report | Operations Coordinator | Failing builds and quiet pull requests, from GitHub | Every one is mentioned |
| Research with sources | Research Analyst | | At least three different sources are linked |

**A bot does not get to declare victory.** When it says it is done, the app looks at what it actually did. If the check fails (a test still fails, a commit is missing, sources are not linked), the bot is told exactly what failed and sent back to fix it, up to two times. Only a passed check shows ✓. A quest that still fails on a local model can be **handed to Claude** with one click, continuing where it stopped.

For quests that read GitHub, store a key named `GITHUB_TOKEN` for `api.github.com` under Settings (needed for private repositories, and to avoid GitHub's limits). The quests are files in [quests/](quests/).

## The quest test suite

Before a release, run the core quests against each model you support:

```bash
npm run eval -- --model local/qwen3:8b
```

It runs them on fixed tasks with known good outcomes (a small repository and a stand-in for GitHub), prints a score, and compares it with the saved baseline for that model in `evals/baselines/`. A run that scores worse exits with an error: that release should not ship. Add `--save` to make a run the new baseline, `--web` to include research (which needs the internet), and `--quests changelog,add-tests` to run only some. To use your own providers and keys, point `TALQAVA_EVAL_SETTINGS` at your `config.json`.

## Models

The agent works with two kinds of model:

- **Claude**, on your Anthropic API key from [console.anthropic.com](https://console.anthropic.com). Usage is billed to that key. Claude gets Anthropic's web search and connectors.
- **Any service that offers the common "chat completions" format.** That includes local model runners such as Ollama, LM Studio and llama.cpp's server, which are free and keep everything on your computer, and hosted services you have a key for.

To use a local model:

1. Install a local model runner and download a model that supports tool calling (for example Qwen 3 or Llama 3.1, 8B or larger).
2. Start the runner. Ollama listens on `http://localhost:11434/v1`, which is set up already as "Local model runner". For another runner, add it under Settings → Model providers with its address.
3. Under Settings → Agent, choose the provider, type the model's name, and press **Check this model**.

The **model check** runs three short tests: following a plain instruction, calling a tool, and chaining two tool calls where the second depends on the first. It shows which bot types the model is good for. Small local models often pass the first two and fail the third; they are fine for research, writing and memory, but not for multi-step work on code.

Models other than Claude read the web with the built-in page reader (`read_page`). It reads public pages only: it refuses addresses on your computer or private network, including after a redirect. Web search is Claude-only for now.

**Long quests on small models.** Each provider has a context size (32,000 tokens unless you set it). When a quest grows past it, the app keeps the task and the latest steps whole and shortens older tool output, so the model keeps the task in view instead of losing track. Set it to what your model really holds. In Settings, the model box lists the models your runner actually has, so you pick instead of typing names.

**Connectors** (MCP servers) are reached from your computer, so they work with every model. Add one under Settings as a web address, or as a program to run (for example `npx -y some-mcp-server`). A connector's tools ask before changing anything unless the connector marks them read-only, what they return counts as outside content, and bots only get them with the `connectors` power. A connector that does not answer within 10 seconds is skipped, and the bot is told.

**Budgets.** Each run stops before it goes over a number of steps (model calls, 40 by default) or an estimated spend in dollars ($1 by default). Spend is estimated from list prices: Claude's are built in, local models are free, and for other services you can enter prices when you add them. Without prices only the step budget applies, and the run says so. When a run stops at its budget, say "continue" to keep going.

## Safety

This is a program that lets an AI run commands. The guards it has:

- **Approvals.** By default it asks before every shell command, file change, API write and browser click. You can allow a tool for the rest of one chat, or switch approvals off in Settings.
- **Workspace.** The file tool cannot read or write outside `data/workspace/`. The shell starts there, but on your own computer a shell command can reach anything your user account can, which is why commands ask first. Use Docker for a hard wall.
- **Secrets.** Each stored key is tied to one host and is filled in outside the model's view. The shell does not inherit the agent's own API key or password.
- **The page.** Without a password it answers only as `localhost`, and refuses requests coming from other websites. It will not start on a network address without a password.
- **Web content.** The agent is told to treat what it reads as information, not instructions. That lowers the risk of a web page talking it into something; it does not remove it. Keep approvals on when it browses sites you do not trust.

## Settings

| Setting | Where | Notes |
| --- | --- | --- |
| API key | Settings page or `ANTHROPIC_API_KEY` | For Claude |
| Model | Settings page | Claude Opus 5.5 by default, or any model from a provider you add |
| Model providers | Settings page | Local runners and other chat-completions services |
| Budget | Settings page, and each bot's file | Steps and estimated spend per run; 40 steps and $1 by default |
| Repositories | Settings page | Repositories bots may work on |
| Effort | Settings page | Claude only. Higher thinks longer and costs more |
| Approvals | Settings page | Ask (default) or run everything |
| Password | `TALQAVA_PASSWORD` in `.env` | Required off `localhost` |
| Address | `HOST`, `PORT` in `.env` | Default `127.0.0.1:8787` |
| Data folder | `TALQAVA_DATA_DIR` in `.env` | Default `./data` |

## The optional browser

For pages that need clicking or typing:

```bash
npm install playwright
```

```bash
npx playwright install chromium
```

Restart, and the agent gains a `browser` tool. Without it, it still searches and reads the web.

## How the code is laid out

| Folder | What it is |
| --- | --- |
| `src/core` | The shared core: the agent loop, scheduling, the system prompt, and the tools every edition has. It reaches storage only through interfaces, so it does not care whether data lives in files or a database. |
| `src/core/models` | The model layer: one interface, with an adapter for Claude and one for chat-completions services, prices, and the model check. The conversation is kept in one format and each adapter translates it. |
| `src/core/crew.ts` | Bot files: reading and checking them, and the limits on bots from a repository. |
| `src/local` | This edition: JSON file storage, the shell and file tools, the quest runner and journal (`quests.ts`), a branch per quest (`git.ts`), and the web server. |
| `crew` | The six starter bots. |
| `public` | The chat page. |
| `quests` | The five core quests. |
| `evals` | The quest test suite and its saved baselines. |
| `test` | Tests for the core (against in-memory storage) and for the local edition. |

The code is TypeScript. Node runs it directly, so there is no build step.

## Tests

```bash
npm run check
```

This type-checks the code and runs the tests. The tests run the agent loop against stand-ins for the Anthropic API and for a local model runner, so they need no key, no model and cost nothing.
