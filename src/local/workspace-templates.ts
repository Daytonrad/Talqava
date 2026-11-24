// Ready-made pages for the workspace: a short pack per area, each a page with a few pages under it. They are
// starting points written for a small business, in plain words, meant to be edited. Agents follow what they say,
// so each procedure is written as steps an agent (or a person) can carry out.

export interface Template {
  id: string;
  name: string;
  icon: string;
  /** The group the pack is for; its pages are shared with that group when the chart has it. */
  group: string;
  summary: string;
  intro: string;
  pages: { title: string; icon: string; markdown: string; protected?: boolean }[];
}

export const TEMPLATES: Template[] = [
  {
    id: "operations",
    name: "Operations handbook",
    icon: "⚙️",
    group: "Operations",
    summary: "How the work gets done: a procedure template, a weekly review and a supplier list.",
    intro: "How the work gets done here. Each page below is a procedure your Operations agents follow; change them to match how you really work.",
    pages: [
      {
        title: "How to write a procedure",
        icon: "📋",
        markdown: `Use this page as the pattern for every procedure, so anyone (person or agent) can follow it the same way.

## Purpose

One sentence: what this procedure achieves, and why it matters.

## When to use it

- What starts it (a new order, the end of the week, a customer complaint)
- Who does it

## Steps

1. The first thing to do, in one plain sentence
2. The next thing, with any number or limit that applies
3. How to check it was done right

## What good looks like

- The result someone could check
- How long it should take

## When to stop and ask

- Anything that costs money above the approval limit
- Anything that goes to a customer for the first time
`,
      },
      {
        title: "Weekly operations review",
        icon: "🗓️",
        markdown: `Every Monday morning, before anything else.

## Steps

1. List last week's orders that were late, and why each was late
2. List anything running low that needs ordering this week
3. Note any complaint or refund, and what caused it
4. Write the three things to fix this week, most important first

## Checklist

- [ ] Late orders reviewed
- [ ] Stock checked
- [ ] Complaints and refunds noted
- [ ] This week's three fixes written down

## Report

A short note to the owner: what went well, what went wrong, the three fixes.
`,
      },
      {
        title: "Suppliers",
        icon: "🚚",
        markdown: `Who we buy from, and how to reach them. Keep this up to date when anything changes.

| Supplier | What they supply | Contact | Order by | Notes |
| --- | --- | --- | --- | --- |
| Example Ltd | Packaging | orders@example.com | Thursday noon | 10% off over 500 units |
|  |  |  |  |  |

## Ordering rules

- Order before the cut-off day in the table
- Compare two suppliers for anything new
- Any order above the approval limit waits for the owner
`,
      },
    ],
  },
  {
    id: "sales",
    name: "Sales playbook",
    icon: "🤝",
    group: "Sales",
    summary: "How we win customers: who we sell to, how we follow up, and our prices.",
    intro: "How we find and win customers. Sales agents start every task from these pages.",
    pages: [
      {
        title: "Who we sell to",
        icon: "🎯",
        markdown: `## Our best customers

- What kind of business or person they are
- What problem they have that we solve
- Where they are, and how big

## Signs someone is a good fit

- They already pay for something like what we offer
- They can decide, or reach the person who decides

## Not a fit

- Who we say no to, and why
`,
      },
      {
        title: "Following up with a lead",
        icon: "✉️",
        markdown: `## Steps

1. Reply within one working day, in a short personal message
2. Ask one question about what they need, never more than one
3. If there is no answer after three days, send one short follow-up
4. After two follow-ups with no answer, stop and note it

## Every message

- Uses their name and mentions what they asked about
- Has one clear next step (a call, a reply, a date)
- Is checked by the owner before it is sent to someone for the first time
`,
      },
      {
        title: "Prices",
        icon: "💰",
        protected: true,
        markdown: `Our prices. Only the owner changes this page; agents quote from it and never offer anything else.

| What | Price | Notes |
| --- | --- | --- |
| Example product | 0.00 | per unit |
|  |  |  |

## Discounts

- No discount without the owner's approval
`,
      },
    ],
  },
  {
    id: "people",
    name: "People handbook",
    icon: "🧑‍🤝‍🧑",
    group: "People",
    summary: "Hiring and looking after the team: a role description, a first-week checklist and time off.",
    intro: "How we hire and look after the people who work here.",
    pages: [
      {
        title: "Role description",
        icon: "📝",
        markdown: `Copy this page for every role you hire for.

## The role

One sentence on what this person is here to do.

## What they do

- The main responsibilities, most important first

## What they need

- Must have
- Nice to have

## How we measure it

- What good looks like after three months
`,
      },
      {
        title: "First-week checklist",
        icon: "✅",
        markdown: `For every new person, starting before their first day.

## Before day one

- [ ] Contract signed and filed
- [ ] Accounts and equipment ready
- [ ] Someone named to look after them in their first week

## First week

- [ ] Welcome, and a tour of how things work
- [ ] Read the handbooks for their area
- [ ] A first small piece of real work, done together
- [ ] A short chat at the end of the week: what is clear, what is not
`,
      },
      {
        title: "Time off",
        icon: "🌴",
        protected: true,
        markdown: `Our time-off policy. Only the owner changes this page.

## Holiday

- How many days a year, and when the year starts
- How much notice to give

## Sickness

- Who to tell, and by when
- When a note from a doctor is needed
`,
      },
    ],
  },
];
