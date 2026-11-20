---
name: monthly-ai-report
description: Writes the three overview cards (Summary, Goal, Achievement) at the top of a person's monthly AI report from their per-project reports. Use when asked to write or refresh the overview of a monthly AI achievement report.
---

# Monthly AI report: overview cards

Write the three cards that open a person's monthly report. A reader, usually a section head, should get the month from these three cards alone.

## Entry

One JSON object:

```json
{
  "user": "alex.m",
  "month": "2026-11",
  "totals": { "tokens": 589000000, "projects": 7 },
  "projects": [
    { "name": "web-storefront", "tokens": 201600000, "activeDays": 8, "firstActiveDay": "2026-11-03", "lastActiveDay": "2026-11-19", "promptCount": 20, "commitCount": 16, "commitDays": 1, "firstCommitDay": "2026-11-18", "lastCommitDay": "2026-11-18", "summary": "…", "usedFor": ["…"], "examples": [{ "task": "…", "status": "recorded", "basis": "…" }], "didntWork": ["…"], "nextMonth": ["…"] }
  ]
}
```

Active days count days with prompts or token use. Commit dates are listed apart, so a commit day can fall outside the active days. Each example may carry a status: requested, recorded or verified. Projects are ordered by active days, then prompt count and tokens. The date range shows how far activity extends through the report period. Some older entries have limited coverage data. Prompt text is never part of the entry.

When the entry provides several focus projects, use concrete work from each in Summary and Goal. State distinct objectives when the workstreams serve different purposes.

## Exit

Reply with only this JSON object, no code fence, no commentary:

```json
{ "summary": "", "goal": "", "achievement": "" }
```

| Card | What it says | Limit |
| --- | --- | --- |
| summary | What the report period was about across projects, with the most sustained work first | 30 words |
| goal | The broader objective evidenced across the reporting period | 25 words |
| achievement | The clearest outcome or progress supported by the evidence | 30 words |

## Rules

- Start with recurring goals, related projects, and work sustained across multiple days. Use recent or single-day work as context when it fits. Recency and token volume alone do not make an activity the goal for the whole month.
- Use next-month items as plans. If the larger goal is unclear, describe what the period's work was converging on without adding a target or deadline.
- Never call the work single-day when commit dates fall on other days. Describe a request as a request, a recorded change as recorded, and call something verified only when an example has that status.
- Report delivery, launch, and completion only where the entry supports those outcomes. Describe an investigation, attempt, or partial result at that level. If outcome evidence is thin, state the most concrete supported progress.
- Name projects by their given names. Never add figures that are not in the entry.
- Leave time and savings out of the overview. The report displays any supplied time figures.
- Plain sentences, active voice, no hype, no filler. No secrets, emails or personal data.
- If one project accounts for much of the sustained work, say so in the summary.
