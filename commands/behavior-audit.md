---
description: Turn real (however small) usage data into specific, evidence-cited product recommendations — activation funnel, first-run friction, feature adoption, and end-user behavior
argument-hint: "[optional: one of funnel | first-run | adoption | end-user — omit to run all four]"
---

Builds on `/wayread:usage-audit`. That command's job is to find or build the instrumentation and confirm usable data exists. This command's job starts one step past that: given real numbers (however few), say what they actually mean for the product and what specifically should change — "X% of signups never reach step Y; the likely cause, based on reading the code, is Z; the cheapest test is W." It never presents a recommendation as more certain than the data supports.

**Dependency — check this first.** This command does not go looking for data sources from scratch; that discovery work belongs to `/wayread:usage-audit`. Before launching anything:
- If `/wayread:usage-audit` has already run in this session or left a discoverable artifact/report naming real data sources (database tables, an analytics project, event logs), use that as the starting point and say so.
- If it hasn't run, or ran and found no usable instrumentation, **say that plainly and stop** — recommend running `/wayread:usage-audit` first — rather than inventing numbers or quietly falling back to guesses. A behavior audit built on no data is worse than no audit.

## Standing rule: sample size, every time

Real production data is frequently tiny — some products have a handful of real, non-internal users. Apply this rule to every single finding in this command, every time it runs, not as a one-off caveat:

- **Any finding derived from fewer than roughly 30 real data points must be explicitly labeled directional / not statistically meaningful** in the sentence that states it, not just in a disclaimer at the top of the report. Write the actual count next to the claim ("2 of 2 real calls fell back" is not "calls usually fall back").
- Never round a tiny sample up to sound like a trend ("most users..." when n=4). State the fraction and the denominator.
- A larger sample is not immune either — still state the N and the time window for every number so the reader can judge it themselves.

## Excluding internal/test traffic

Before computing anything, exclude the product's own team/internal/test traffic. Do this explicitly and report it:
- State the exact filter used (email domain, a known test-account list, a tenant/org flag, a naming pattern on test records, etc.) and **how many rows it removed**.
- **Double-check the filter, don't assume it's complete.** A real past mistake: an audit excluded the obvious test accounts by pattern-matching a known naming convention, but missed one real internal account that didn't match the pattern and got left in the "real user" population, skewing the numbers. Explicitly look for internal traffic that wouldn't match the filter you just applied — new team members, a second internal domain, manually-created test rows without the usual marker — and say in the report whether you checked for this and what you found, even if the answer is "checked, found none beyond the filtered set."
- If exclusion can't be done cleanly (no reliable flag exists), say so and treat the resulting numbers as upper bounds, not clean figures.

## Hard safety rules — read-only, no exceptions

- Read-only, always. Never create real-looking traffic, never sign up for or create an account, never place a call, send a message, or submit a form as part of investigating — observe what already happened, don't generate new events to study.
- Never write to any database. Aggregate, read-only queries only (counts, rates, timestamps, config/status flags) — never select or print content or PII columns (names, emails, phone numbers, message bodies, call transcripts, free-text fields).
- If a database or analytics project is shared with unrelated systems, scope every query defensively to this product's own tables/namespace — never a broad scan that could touch someone else's data.
- Redact all customer/user identifying information from the report. Refer to anonymized entities (T1, T2, T3, ...) — never real names, emails, phone numbers, or company names belonging to users or customers of the product being audited.
- Be explicit and neutral about any competitor mentioned in the data or code (e.g. a fallback provider, an integration) — describe what it does, never disparage it.
- Never print a secret value (API keys, tokens, credentials) encountered while reading config or code.

## The four investigation areas

Dispatch these as **separately-launched, concurrent, read-only `Agent` tool calls in a single message** — same pattern as `/wayread:ship-check`'s step 2: genuinely parallel, not sequential, and none of them writes anything so there's no ordering risk. If `$ARGUMENTS` names one area, launch only that one agent; if empty, launch all four together in one message.

Brief every agent with: the hard safety rules above, the sample-size rule above, the exclusion method to use (from the usage-audit findings), and that this is a generic product — adapt "signup," "activation," "feature," and "end user" to whatever this specific product's actual funnel and feature set are, don't force a template that doesn't fit.

1. **Activation funnel, quantified.** Define this product's actual funnel from whatever events/database rows exist — typically something like visit → signup → first meaningful action → paying/retained, but use the product's real equivalent steps, not a generic SaaS template if this isn't one. For each step: a real count and a real conversion rate to the next step, over a stated time window. Identify the biggest drop-off(s) by size, not by assumption. Explicitly flag any step that has **no data at all** — a measurement blind spot is itself a finding, report it as one rather than skipping it silently.

2. **First-run experience, read from the actual code.** Walk the real signup/onboarding/first-use path as a newcomer would, reading the actual screens/routes/forms in the codebase — not a vague impression of "onboarding is long." Count concretely: number of screens, number of required input fields, number of clicks/taps to first meaningful value, any dead ends or empty states with no guidance. Then compare that measured effort against whatever promise is made on the product's own marketing/landing page or README ("takes 2 minutes," "no setup," etc.) and say plainly whether the code matches the promise.

3. **Feature adoption and retention signal.** For each major feature found in the code: how many real (non-internal) users have ever used it at least once, and how many used it recently (state the window). Name features that are built but show ~0 real usage. If the data allows it, note any pattern connecting an early action to later retention/usage — but this must be stated as a **hypothesis, explicitly labeled directional given the sample size**, never as a proven causal link, and must restate the N it's based on.

4. **End-user/customer behavior, if this product has one.** Only applies if there's a distinct "end user" beyond the direct customer — e.g. people who call or message something the customer configured, or people who consume content the customer published. If so: what does their behavior reveal about quality or drop-off — short session/call length, early disconnects, repeated errors, fallback events? This population must be **analyzed separately from the product owner's own test/internal traffic**, which behaves differently (testers call their own numbers, click through deliberately, etc.) and would bias the numbers if mixed in — confirm explicitly that this separation was done and how. If this product has no distinct end-user population, say so and skip this area rather than forcing an answer.

Each agent reports back: the real numbers it found, the N and window for each, which findings are directional vs. more solid, and any blind spots — not conclusions phrased as certainties.

## Turning findings into recommendations

Wait for all launched agents to finish before writing any recommendation — don't act on one area's findings before the others land, per the same reasoning as `/wayread:ship-check`.

Every recommendation in the final report must have all of:
- **The evidence** — the specific number(s), N, and window it's based on, and which agent/area it came from.
- **The specific change** — not "simplify onboarding," but the actual screen/step/field/file or area it touches and what changes about it.
- **The behavior it targets** — which funnel step or feature-usage number it's meant to move.
- **The exact success measure** — the specific event, query, or metric that would show whether it worked, stated as a query/event name where possible, not just a vibe.
- **A labeled hypothesis, with a plausible direction and rough size** — e.g. "likely raises step-2 completion by some amount, not quantifiable from n=6" — explicitly marked as a hypothesis, never stated as a guaranteed outcome.

## Reporting

Load the `artifact-design` and `artifact-diagramming` skills, then publish **one combined Artifact** via the `Artifact` tool, following `/wayread:change-full-review`'s pattern for a single combined report page (utilitarian, not flashy; real numbers, not decorative styling). Include:
- The funnel, drawn with real numbers and real conversion rates at each step (and blind-spot steps marked as such).
- Friction points from the first-run walk, ranked by how much effort they add.
- A recommendations table: evidence | specific change | target behavior | success measure | hypothesis (direction/size) | effort.
- The sample-size and exclusion-method notes stated plainly near the top, not buried.

Also give a short plain-text summary in chat — don't just point at the artifact. Close by naming **the single highest-value first slice of work**: a small number of concrete changes (not a giant undifferentiated backlog) that the evidence most supports trying first, with its success measure.

## When to use this

Use this after `/wayread:usage-audit` has confirmed there's real, usable usage data (or after you already know it has, from this session or a prior report) — this command goes one step further, from "do we have data" into "what does the data say to change." If this command is invoked and finds that there's too little usable data to say anything meaningful — no instrumentation, everything is internal/test traffic, or the funnel has no events at all — stop and say so explicitly, and suggest running `/wayread:usage-audit` first to build or locate real instrumentation, rather than forcing a report out of nothing.
