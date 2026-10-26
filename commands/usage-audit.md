---
description: Audits product usage visibility — who's using what, how much, and whether the data to answer a basic product question actually exists and can be trusted — then recommends concrete instrumentation additions
argument-hint: [optional: product/service name to scope to; empty audits everything discoverable]
---

This is a **product usage visibility** audit, not a performance/uptime one — `/wayread:code-health` covers latency, errors, and infra health. This command answers "how well can we actually see what's happening in this product": who's using what, how much, whether the analytics/telemetry anyone would need to answer a basic product question actually exists, actually fires in production, and can be trusted when it does.

Never hardcode a specific analytics tool, product, or company as if it's the only possibility — this command must work for any product made up of some combination of a web app, an API, and a backend service. Discover what's actually there before assuming anything.

## Hard safety rules — read-only, no exceptions

- **Never send or capture a new analytics event, never create a test account, never generate real-looking traffic.** Checking whether instrumentation fires means looking at existing recorded data and existing code, not triggering new events to see if they show up.
- **Database access is read-only aggregate queries only** — counts, min/max dates, group-by counts. Never `SELECT` content or PII columns, never write/update/delete anything. If a database is shared with unrelated systems, scope every query defensively (explicit table/schema/tenant filters) so nothing outside the product being audited is touched or scanned broadly.
- **Never call a paid third-party API** as part of the audit (no synthetic requests to metered endpoints, no analytics-tool write APIs).
- **A plain, unauthenticated HTTP GET of a public page is fine** (e.g. to check what scripts a page actually loads) — one plain load, not scripted or repeated requests, and never against an authenticated or paid route.
- **Redact all customer/user identifying information** in the report. Refer to anonymized entities (T1, T2, T3, ...) instead of real names, emails, company names, or IDs. Never print a secret value — name the credential/env var only, never its contents.

## Step 1 — Discover

Figure out, using the same discovery approach other wayread commands use (CLAUDE.md/README naming things, sibling repos under the parent folder, or just the current repo if that's all there is):

- What distinct products/services exist in scope (respect `$ARGUMENTS` if given — scope to that one product/service by name; otherwise audit everything discoverable).
- What analytics/telemetry tooling is actually wired in. Don't assume a specific tool — look for: a product-analytics SDK (anything in the PostHog/Mixpanel/Amplitude/GA family or similar, by import or script tag), a database that itself holds usage facts (usage/events/requests tables), custom/in-house event logging, admin dashboards that compute usage numbers, cron-driven usage digests or reports, and any billing/metering integration tied to a paid API or compute provider.
- What marketing/outreach/referral mechanism exists, if any (UTM params, referral codes, signup source fields) — needed for Step 3's attribution check.

## Step 2 — Dispatch concurrent read-only investigation agents

Launch several `Agent` tool calls together in **one message** (same pattern as `/wayread:ship-check` step 2) — split sensibly based on what Step 1 found: one agent per distinct product/service if there are several, or one agent per investigation area below if there's just one product with many facets. Each agent is read-only and briefed with the hard safety rules above verbatim, plus the specific area(s) it owns:

- **Acquisition/activation funnel visibility**: trace the real path from first visit to a paying/activated user in the code and in any live analytics project. For each step in that path, is there an actual event or record, or is it inferred/missing? Name the first step with no instrumentation at all as a blind spot. If a live analytics project is reachable (via an MCP tool for that tool, e.g. a PostHog-style query interface), pull real funnel numbers, not just "the code should emit this."
- **Feature/endpoint usage**: for an API/backend, is there a per-endpoint, per-customer record of request volume, errors, and latency — not just an aggregate log line? For a web app, which features actually get used, by whom, how often, based on real recorded usage rather than code that merely could track it?
- **Growth/channel attribution**: if there's a marketing/referral/outreach mechanism, can a signup be traced back to what brought them in, end to end? Specifically check for attribution loss points — e.g. a redirect or OAuth bounce that drops query parameters, a landing page that doesn't persist a referral code into the signup record.
- **Data layer trustworthiness**: wherever two or more places claim to report "the same" number (two dashboards both claiming to count active users, a backend metric and an analytics-tool metric that should agree), compare their actual definitions and, where reachable read-only, their actual current values. Look specifically for: inconsistent definitions (different windows, different "active" criteria), silent row-count caps that truncate a report without saying so, timezone mismatches, and double-counting (e.g. counting both a legacy and a current event for the same action).
- **Cost/usage reconciliation**: for anything metered or billed (API call volume, compute spend, per-seat usage), does what the product's own usage records show reconcile with what the billing/provider side reports for the same period? Flag any gap without assuming which side is wrong.
- **Live-vs-code check (do this wherever a live analytics project or live site is reachable)**: for each event the code claims to send, check its actual real-world occurrence count in the live analytics tool over a recent window (via whatever MCP tool exposes that project, if one is available) — a coded event with zero real occurrences is a finding, not a pass, and is worth flagging as likely a deploy/config gap rather than a design gap. Separately, do a single plain unauthenticated GET of a public page and check what it actually ships (network requests, inline scripts) against what the code says should load — flag any analytics tool the code wires up that the live page doesn't actually load, and vice versa.
- **Privacy/compliance cross-check**: compare the product's stated privacy policy (if findable) against what the code and live site actually send to third parties. Flag PII flowing to a third-party analytics tool without a clear stated justification, any mismatch between policy text and actual behavior, and any tracking that is firing against a specially-regulated subset of users or data if the product has one (e.g. health, legal, or similarly regulated data) — tracking that shouldn't apply there at all is a distinct, higher-severity finding from ordinary PII-to-third-party flow.

Brief each agent with: the product/service(s) it owns, the hard safety rules verbatim, which of the areas above it's responsible for, and that it must report findings with any customer/user-identifying detail already redacted to anonymized entities (T1, T2, ...) before it even returns its report — don't rely on the combining step to redact.

## Step 3 — Wait, then combine

Wait for all agents to finish before synthesizing. Don't act on or report any single agent's findings before the others land — a trustworthiness finding in one product's data layer might contextualize an attribution gap in another.

## Step 4 — Build recommendations

Every recommendation must specify, concretely:
- The exact event/metric name.
- The exact file, function, or route where it would be added (or, for a config/deploy fix, exactly what's misconfigured).
- The exact question it answers (phrased as something a person would actually ask, e.g. "how many trial signups converted to paid within 14 days").
- A privacy note: what this event/metric must never include (no raw email, no message content, no free-text fields, etc).
- A rough effort size: S / M / L.

Rank all recommendations by value (impact on being able to answer a real product question, weighted by how blind the current state is on that question) and name the single most valuable one to build first, with a one-line reason.

## Step 5 — Report

Load the `artifact-design` and `artifact-diagramming` skills, then publish **one combined Artifact** following `change-full-review.md`'s pattern (Part 5 — single HTML file, utilitarian report styling, real status indicators not decorative ones, stable file path so re-runs update the same page). The artifact should contain:

- **What exists today**, with evidence: products/services found, analytics tooling found per product, and for each, what's confirmed live (real event volume, real page-load check) versus what's only present in code.
- **The gaps**: blind spots in the funnel, missing per-endpoint/per-feature usage records, attribution loss points, data-layer disagreements, cost/usage reconciliation gaps, and the live-vs-code mismatches (coded-but-never-fired events, tools wired in code but not actually loaded by the live page, or vice versa) — call these out distinctly since they're often the highest-value, lowest-effort fixes (a config/deploy fix, not new instrumentation).
- **Privacy/compliance flags**, called out as their own section, distinct from the gap list.
- **The ranked recommendations table**: event/metric, file/location, question it answers, privacy note, effort size — with the single most-valuable-first item highlighted at the top.
- A diagram (via `artifact-diagramming`) of the funnel/data-flow with instrumented points marked and blind spots visibly marked as gaps, if that materially helps over the table alone.

All customer/user-identifying information in the artifact must already be anonymized (T1, T2, ...) — never a real name, email, or ID. Never print a secret value, only the name of the credential.

Also give a short plain-text summary in chat: what's live and trustworthy, the top 3 gaps, the single most valuable thing to build first, and the artifact URL.

## When to use this

Before a product review, whenever "how many users do we actually have" (or any similarly basic usage question) can't be answered confidently and quickly, or periodically as the product grows and new features/endpoints/products are added without corresponding instrumentation.
