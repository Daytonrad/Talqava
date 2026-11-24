# Security

Talqava lets AI agents run commands, change files and call services on the owner's computer, so we take security problems seriously.

## Reporting a problem

**Please do not open a public issue.** Report it privately instead:

1. Open the [Security tab](https://github.com/Talqava/Talqava/security) of this repository.
2. Choose **Report a vulnerability**, and describe the problem, how to reproduce it, and what an attacker could do with it.

Only the maintainers can see the report. We aim to reply within a week, keep you posted while we fix it, and credit you when the fix is released, unless you would rather not be named.

## What counts

Anything that lets someone, or a web page, document or message an agent reads, get past one of Talqava's guards. For example:

- An agent acting without the owner's approval when approval is required, or reaching outside its workspace.
- A stored key reaching the model, an agent, a log, an export, or a host other than its own.
- A private library file reaching an AI model or an agent.
- The local page answering requests from another website, or from the network without a password.
- An imported organization file, marketplace role or connector that can run code or change settings it should not.

Problems in a model provider (Anthropic, OpenRouter, a local model runner) or in GitHub belong with them; tell us too if Talqava makes them worse.

## Supported versions

Talqava has not had a numbered release yet. Fixes go to the `main` branch, and to the latest release once there is one.

## For the owner of a Talqava install

- Keep approvals on unless the app runs inside Docker.
- Never publish the page on a network address over plain HTTP; use an SSH tunnel, Tailscale or an HTTPS proxy, and always set a password.
- Mark documents private in the Library when no AI should see them.
