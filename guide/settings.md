# Settings

Settings is where you choose which AI services power your agents, and how careful, how thrifty and how independent they are. It is also where you change the look of the app, store keys for other services, and read Talqava's licence and policies. Most people visit it once to connect an AI service, then come back to adjust budgets and approvals.

## What you'll see

The page is one long column, in this order:

- **AI models**: the AI services you have connected, your **Backup models**, and every service you can connect, in groups.
- **Look**: light or dark appearance, and an accent colour.
- **Agent**: your agent's name, the team's model, **Check this model**, effort, cost saving, checking before starting, approvals and the budget per run. Press **Save** after changing anything here.
- **Advanced: set up a service by hand, with its prices and size** (folded away).
- **API keys for other services**
- **Repositories**
- **Connectors (MCP servers)**
- **About and legal**

If no AI service is connected yet, a banner at the top asks you to connect one.

## Key ideas

- **An AI service** is the company (or program on your computer) whose model does the thinking for your agents. Talqava itself is not an AI; it organizes the work.
- **Why connect more than one.** Your whole team uses one model, but any agent can use a different one: a strong model for managers, a cheaper one for routine work. A second service also gives you backups.
- **Backups keep work going.** If your main service is down, busy or out of credit, the first backup answers instead, then the next. Each switch is noted in the Audit log.
- **Keys stay on your computer.** A key is kept on this computer and sent only to its own service. Agents never see it.
- **Local models are free and private.** Programs such as Ollama or LM Studio run models on your own computer. Nothing leaves it, but they are usually slower and less capable than paid services.
- **Approvals protect you.** With **ask**, an agent stops before it runs a command, changes a file or writes to another service, and waits for your yes.
- **Budgets stop spending.** Every task stops before it goes over its step limit or its dollar limit. Monthly budgets for each agent and group are set on the Organization page and on each agent's page.

## How to…

### Connect an AI service

1. Open **Settings**. Under **AI models**, find the service in its group: **The best-known model makers**, **Fast, low-cost hosts of open models**, **More model makers**, **One account for many models, or your company's own**, or **On this computer: free and private**.
2. Press **Connect**. A window opens with a link to where you get a key.
3. Get a key from that service's website, copy it, and paste it in.
4. Press **Connect**. Talqava says **Checking with…**, checks the key with the service and finds its models.
5. The models list opens. Press **Use for my team** beside the one you want, or close it to keep your current model.

Anthropic (Claude) is the standard choice and works best for agent work; web search and connectors run on Claude. OpenRouter has its own sign-in: press **Set up** on its card and you are taken to **Integrations → OpenRouter**.

### Use a free model on your computer

1. Install a model program such as Ollama or LM Studio, download a model in it, and start it.
2. Under **On this computer: free and private**, press **Find models on this computer**. Talqava connects every one that is running.
3. Or press **Connect** on one card. No key is needed.
4. Press **Models** beside it and choose **Use for my team**.

### Choose your team's model

1. Under **AI models**, press **Models** beside a connected service.
2. Use **Find a model** to search. Each model says **Works for agents**, **Cannot use tools** or **Not known if it can use tools**, how much it holds and its prices.
3. Press **Use for my team**. The service shows the tag **Your team's model**.
4. If a model is not listed, type its name under **Or type a model's name** and press **Use this**.

Agents work through tools, so choose a model that **Works for agents**. Agents you gave a model of their own keep it.

### Test a model before relying on it

1. In the **Agent** section, choose the model under **Model comes from** and **Model**.
2. Press **Check this model**. It runs three short tests in under a minute and costs a few cents at most.
3. Read the result: **follows instructions**, **uses tools**, **chains steps**, and **Good for**.

### Add backup models

1. Connect at least one service. The **Backup models** box appears.
2. Choose a model from **Add a backup model…**. You can add up to four.
3. Use **↑** to change the order, and **Remove** to take one out.

Pick backups from a different service than your main model. If that company has an outage, the backup is unaffected.

### Disconnect a service

1. Press **Disconnect** beside it and confirm.
2. Its key is forgotten on this computer. If your team was using it, the team goes back to Claude, and any backups from it are removed.

### Set up a service by hand (Advanced)

For a service not in the list, or to set prices and size yourself:

1. Open **Advanced: set up a service by hand, with its prices and size**.
2. Fill in a short id, a name, its address (ending in /v1), and a key if it needs one.
3. Optionally add its price per million tokens in and out (a token is about three quarters of a word), and its context size: how much text the model holds at once.
4. Press **Add provider**.

Without prices, only the step budget can stop a task. Set the context size to what the model really holds, so long tasks are shortened to fit.

### Change how agents work (the Agent section)

1. **Name**: what your main agent is called.
2. **Effort, for Claude**: higher thinks longer and costs more.
3. **Cost saving for your team of agents**: **Off: every agent uses my model**, or **On: match the model to the work**. With Claude Opus or Fable as your model, managers who plan keep your model, team members doing their own part use Claude Sonnet 5.5 (about half the price), and quick questions between agents use Claude Haiku 5.5. An agent you gave a model of its own keeps it.
4. **Before starting a task**: **Check first, and ask me if something is missing** (the default) or **Start straight away**. Checking means an agent first makes sure it has the information, documents or access it needs. If something is missing, it asks you in your Inbox instead of spending money guessing. The check costs a few cents and shows on the task's receipt.
5. **Approvals**: **Ask me before commands, file changes and API writes** (the default) or **Run everything without asking**. Only choose the second if nothing on the computer would matter if lost. With "ask", a scheduled job that needs approval waits until you open its chat and answer.
6. **Budget per run: steps (model calls)**: 40 by default.
7. **Budget per run: estimated spend in US dollars**: $1 by default. Leave it empty for no dollar limit.
8. Press **Save**.

A run stops before going over either limit, and you can say "continue" to carry on. Spend is estimated from list prices; your provider's bill is the real figure.

### Change the look

1. Under **Look**, choose **Light**, **Dark** or **Match my computer**.
2. Click a colour swatch to change the accent colour used for buttons and highlights. This changes at once, without saving, in this browser or app window.

### Store a key for another service

So agents can call another service without seeing your key:

1. Under **API keys for other services**, type a name in capitals (for example WEATHER_KEY), the key, and the host it may be sent to (for example api.example.com).
2. Press **Add key**. Agents use it by name; the value is only ever sent to that host.

### Add a repository or connector

- **Repositories**: type the folder of a repository and press **Add repository**. Setting up GitHub is easier under **Integrations → Git**.
- **Connectors (MCP servers)**: type a name and the connector's address (and a token if needed), or a program to run on this computer, and press **Add connector**. Connector tools ask before changing anything unless the connector marks them read-only.

### Read the licence and policies

Under **About and legal**, press **Terms of Use**, **Privacy Policy**, **Acceptable Use Policy**, **Licence (MIT)**, **Security policy**, **Open-source policy**, **Approved licence list** or **Third-party notices**. Talqava runs on your computer and sends nothing to its makers; your data goes only to the services you connect.

## Tips

- Connect two services from different companies: one for your team, one as a backup.
- Keep **Check first** and **Ask** on while you get to know your agents.
- Start with the $1 budget per run. Raise it only for tasks that keep stopping short.
- Set a spending limit on the AI service's own website too, as a second safety net.

## If something goes wrong

- **"… did not accept that key."** Copy the whole key again from the service's website and reconnect.
- **"That looks like a key for …, not …"** You pasted a key from another service into the wrong card.
- **"A key for … starts with …"** The key is incomplete or from the wrong page.
- **"… is not running on this computer."** Start the local model program, then press **Connect** again.
- **"… could not be reached at …"** Check your internet connection, or the address you typed.
- **"… does not list its models, so type the name of the model you want."** Use **Or type a model's name**.
- **"No model runner is running on this computer."** Install Ollama or LM Studio, download a model, start it, then look again.
- **"That does not look like an Azure resource name."** Type only the first part of the address, for example my-company.
- **"Up to four backups."** Remove one before adding another.

## Related guides

- [Integrations](integrations.md) (OpenRouter, GitHub, connectors)
- [Audit log](audit-log.md)
- [Organization](organization.md) (monthly budgets for groups)
- [Inbox](inbox.md) (approvals and questions)
- [Getting started](getting-started.md)
