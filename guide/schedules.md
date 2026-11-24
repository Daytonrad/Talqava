# Schedules

Schedules let Talqava do work on its own at set times: a morning news digest every day, a check of last week's orders every Monday, or a one-off reminder on a certain date. You write the instructions once and choose when they run. Each run appears as a new chat, ending with a short report of what was done.

## What you'll see

- **Your scheduled jobs**, one card each. A card shows the job's name, its timing, when it runs next (or **paused**), when it last ran, and its instructions.
- **Buttons on each card:** **Last run** (opens the chat from the latest run), **Run now**, **Pause** or **Resume**, and **Delete**.
- **New scheduled job**, a form with three boxes: **Name**, **When**, and **Instructions**, and an **Add job** button.
- **No scheduled jobs yet.** when the list is empty.

## Key ideas

**A job is a name, a time and instructions.** At each time, the Talqava assistant starts a fresh chat titled with a clock (⏰) and the job's name. It is told that nobody is watching live, does the work, and finishes with a short report of what it did and anything that needs your attention.

**Ways to say when.** Times use your computer's clock.

- **every 30m**, **every 2h**, **every 1d**: repeat at that interval (m for minutes, h for hours, d for days). The shortest is one minute.
- **at 2026-12-01T09:00**: run once, at that date and time. After it runs, the job shows as paused.
- **A cron line**: five values for minute, hour, day of the month, month and day of the week. For example, **0 8 \* \* \*** is 8:00 every day, and **0 9 \* \* 1-5** is 9:00 on weekdays (Monday is 1).

**Jobs run while Talqava is open.** The app checks for due jobs every few seconds. If your computer was off or Talqava was closed when a job was due, it runs once as soon as you open Talqava again, then carries on as normal.

**Approvals still apply.** A scheduled run follows your **Approvals** choice in **Settings**:

- **Ask me before commands, file changes and API writes** (the default). When the run wants to make a change, such as running a command, changing a file, sending data to another service or clicking in a web page, it stops and waits for you. Nothing is changed until you say yes. The chat shows on **Work in progress** under **Waiting on you** as "A chat is waiting for your approval". Open it and press **Allow once**, **Always allow … in this chat**, or **Don't allow**.
- **Run everything without asking.** The run goes ahead on its own. Even so, once a run has read outside content, such as web pages, every change asks you first.

Reading and searching never need approval. Your step and spending limits from **Settings** apply to scheduled runs too.

**You can also ask in a chat.** Say "every weekday at 8am, send me a summary of new orders", and the Talqava assistant (or any agent with the **Schedules** power) sets up the job for you. It then appears on this page.

## How to…

### Add a scheduled job

1. Under **New scheduled job**, type a **Name**, for example "Morning news digest".
2. In **When**, type the timing, for example **every 1d** or **0 8 \* \* \***.
3. In **Instructions**, write what should be done each time, as a complete request. The run can't ask you questions first, so include everything it needs.
4. Press **Add job**. The card shows when it runs next.

### Try a job straight away

1. Press **Run now** on its card.
2. The new chat opens, so you can watch it work.

### See what a job did

1. Press **Last run** on its card to open the latest run's chat.
2. Read the report at the end.

### Pause, resume or delete a job

1. Press **Pause** to stop it for now. The card shows **paused**.
2. Press **Resume** to start it again; it runs at the next time due.
3. Press **Delete** and confirm to remove it for good.

To change a job's timing or instructions, delete it and add it again.

## Tips

- Press **Run now** after adding a job, to check the instructions do what you expect.
- For a job that makes changes, leave approvals on **Ask me…** until you trust it.
- Be specific: say where to look, what to produce, and where to save it.
- Keep Talqava open, or your computer awake, at the times your jobs are due.

## If something goes wrong

- **"A scheduled job needs a name and a prompt."** Fill in both **Name** and **Instructions**.
- **"That time is already in the past."** A one-time **at …** date has already gone. Pick a future date.
- **"Schedule must be "every 30m" / … or a 5-field cron line."** Talqava couldn't read **When**. Use one of the forms above.
- **"The shortest interval is 1 minute."** Use **every 1m** or longer.
- **"Could not read the date …"** Write the date as year-month-day, then T and the time, such as **at 2026-12-01T09:00**.
- **"That one-time job has already passed."** You pressed **Resume** on a one-time job that already ran. Add a new job with a new date.
- **A job seems stuck.** It is probably waiting for your approval. Check **Waiting on you** on **Work in progress**.

## Related guides

- [Workspace](workspace.md)
- [Library](library.md)
- [Memory](memory.md)
- [Skills](skills.md)
- [Settings](settings.md)
- [Getting started](getting-started.md)
