---
name: agent-design
description: Use when architecting an LLM agent — loop shape, tool design, memory tiers, failure modes, eval harnesses, when NOT to build.
metadata:
  added: 2026-05-19
  last_reviewed: 2026-05-19
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-19"
  related: [llm-essentials, mcp-protocol, acp-protocol, claude-api, dispatching-parallel-agents]
---

# Agent Design (Provider-Agnostic Discipline)

**Iron Law: an agent is an LLM in a loop with tools and a budget. Every loop iteration must (a) have a hard step cap, (b) record `usage` for cost accounting, (c) honor cancellation, (d) detect repetition. Tools are the API to the world — design them like an API: sharp scope, validated inputs, idempotent where possible, errors recoverable in-band. Eval the _trajectory_, not just the final answer.**

## When NOT to build an agent

| Use case                                       | Better than an agent                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Single classification / extraction             | one LLM call with constrained tool-use or JSON mode         |
| Deterministic multi-step transformation        | a script + LLM calls at the fuzzy steps; no autonomy needed |
| Workflow with fixed branches                   | a state machine that calls the LLM for content, not control |
| Bounded retrieval ("answer from these 5 docs") | RAG, not an agent                                           |

Agents earn their complexity when **the right next step depends on what previous steps returned** AND the space of possible actions is wider than a switch statement. Otherwise: scripts win on cost, latency, predictability, and debuggability.

## Agent loop anatomy

```
loop:
    1. perceive  — assemble context (input + memory + tool results so far)
    2. plan      — LLM call: pick next action (tool or final answer)
    3. act       — execute the chosen tool (or terminate with the answer)
    4. observe   — capture result + cost + duration
    5. reflect   — (optional) check progress, detect stuck/repetition
    6. terminate — stop_reason in {answer, max_steps, budget_exceeded, cancelled, repeated, failure}
```

Step cap (typically 10–50), wall-clock budget, $-budget, repetition detector — all four are mandatory guards. An agent without all four will, eventually, run away. The model is not your safety belt.

## Tool design — sharp tools

| Principle                          | Why                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Narrow scope, descriptive name** | `search_open_bugs(query)` beats `db_query(sql)` — narrow tools are picked correctly; wide tools are misused                         |
| **Constrained JSON Schema**        | `additionalProperties:false`, enums, numeric bounds. The model self-corrects when the schema rejects clearly                        |
| **Idempotent when possible**       | retries are safe; partial failures don't double-charge                                                                              |
| **Errors as recoverable content**  | tool failure → `tool_result is_error:true` with a _helpful_ message ("query too broad, narrow to <100 chars"); never throw upstream |
| **One unit of work per tool**      | `book_flight_and_email_user` is two tools; the model can compose, you can't decompose                                               |
| **Stateless**                      | tool state lives in your DB, not in the agent's context; agents are bad at remembering state                                        |

**Tool descriptions are prompt engineering.** The model reads `description` to decide when to use the tool. Bad descriptions = wrong tool picks. Iterate on descriptions like you iterate on prompts.

## Memory tiers

| Tier                | What it holds                               | When                                                 |
| ------------------- | ------------------------------------------- | ---------------------------------------------------- |
| **None**            | conversation only                           | single-shot Q&A; classification                      |
| **Scratchpad**      | tool-result history this run                | every agent loop; just the running transcript        |
| **Summary**         | compressed history of past turns            | conversations crossing window budget                 |
| **Retrieval (RAG)** | facts indexed externally, fetched on demand | factual recall, knowledge bases, codebases           |
| **Persistent**      | structured records the agent reads/writes   | multi-session continuity (user prefs, project state) |

Pick the _lowest tier that works_. Each tier upgrade adds latency, cost, and failure modes. Most useful agents live at scratchpad + retrieval.

## Planning patterns

| Pattern                                   | When                                                     | Trade-off                                                         |
| ----------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| **ReAct** (think → act → observe, repeat) | default for most tool-using agents                       | simple, well-understood; can get stuck on hard problems           |
| **Plan-and-Execute**                      | tasks with clear sub-goals (codegen, multi-doc analysis) | one planning call up-front + execute phases; less drift but rigid |
| **Reflexion**                             | tasks where the agent benefits from self-critique loops  | extra cost per critique pass; helpful when correctness matters    |
| **Tree-of-Thought**                       | search-heavy reasoning with branchable decisions         | expensive (many branches × calls); reach for last                 |
| **Hierarchical**                          | long-horizon work (researcher + delegate)                | composition complexity; orchestration overhead is real            |

Most production agents start as ReAct. Add complexity only when ReAct provably underperforms on your eval.

## Failure modes (and the guard each one needs)

| Failure                      | Symptom                                     | Guard                                                                                       |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Tool loop**                | same tool, same args, 5+ times              | repetition detector (hash recent (tool, args) tuples; if N repeats → terminate or re-plan)  |
| **Hallucinated tool / args** | tool name not in registry, args fail schema | enforce schema; reject unknown names; reply with `is_error:true` and the schema             |
| **Runaway cost**             | $-spend > expected                          | per-run budget; halt when crossed; log to alerting                                          |
| **Context blowout**          | window exhausted mid-run                    | summarize-on-threshold; switch to longer-context model; or terminate gracefully             |
| **Premature termination**    | answer returned with empty / partial result | enforce minimum quality (length, schema, deterministic checks) before allowing terminate    |
| **Off-task drift**           | agent solves a tangential problem           | re-state goal in system prompt; track "did this step advance the goal?" via reflection step |
| **Stuck on ambiguity**       | many tool calls without forward progress    | step-progress meter (state delta per N steps); if zero, escalate to human                   |

## Eval — beyond the final answer

Single-shot eval is easy. Agent eval is hard because _trajectories matter_. Layer your evals:

1. **Outcome eval** (did it solve the task?): deterministic where possible (test cases, regex, JSON shape); LLM-judge with rubric for subjective wins.
2. **Trajectory eval** (was the path good?): step count vs budget, tools called vs expected, cost per task, repetition rate. Anomalies often catch regressions before outcome metrics do.
3. **Cost eval** (was it efficient?): tokens-per-task, $-per-task, latency-per-task, P50/P95. Track over time.
4. **Robustness eval** (does it survive ambiguity?): perturbed inputs, missing context, tool failures injected. Production hits these constantly.

A useful baseline: 30-100 task examples with expected outcomes + trajectory expectations. Run on every prompt / model / tool-schema change. **Versioned in git**, like any other code artifact. See [[llm-essentials]] for the deterministic-vs-LLM-judge scorer guidance.

## Permission and side-effect discipline

Tools with side effects (DB writes, emails, payments, deployments) need:

- **Confirmation step**: agent's loop emits a "I'm about to do X" message; a human (or policy) approves before execution. ACP formalizes this as `session/request_permission` — see [[acp-protocol]].
- **Idempotency keys**: every side-effect tool call carries a unique key; downstream services dedupe.
- **Dry-run mode**: every destructive tool has a `dry_run: true` variant the agent can use first.
- **Audit log**: every tool invocation (args, result, decision-maker) persists. You will be glad you had this.

## Anti-patterns

- No step cap — the loop runs until the API errors out, on your dime
- One mega-tool (`run_anything(command)`) — the model misuses it; debugging is impossible
- Tool failure → throw — the model can't recover; use `is_error:true` content with a helpful hint
- Memory tier overshoot ("we'll add persistent memory just in case") — cost and failure modes compound; start at scratchpad
- Eval on the final answer only — tool loops and cost blowups go undetected
- Hand-rolled retry around the whole loop — re-run the _step_, not the whole run; whole-run retries 2–5x cost
- System prompt accreting "don't do X" instructions — restructure tool schemas and descriptions instead
- Agent calling agent without a budget split — composition multiplies cost without bounds

## Red flags

| Thought                                    | Reality                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| "An agent will figure it out"              | Agents reliably do what they're tooled to do; unbounded "figure it out" is fantasy   |
| "We'll add evals once stable"              | The evals are _how_ it becomes stable                                                |
| "Higher temperature for creative tool use" | Lower temperature for tool selection; nuance lives in tool _outputs_, not the picker |
| "Just give it Postgres"                    | The model writes plausible SQL with subtle bugs — wrap it in narrow query tools      |
| "Reflection always helps"                  | It often helps and always costs; A/B it on your eval before adopting                 |

## Hand-off

For the underlying LLM call concerns (sampling, retries, cost, structured output): [[llm-essentials]]. For the Anthropic-specific tool-use shape and extended thinking: [[claude-api]]. For when agents expose themselves over a protocol — to editors: [[acp-protocol]]; to model hosts: [[mcp-protocol]]. For Claude Code's _built-in_ subagent dispatcher (a different concern — orchestrating Claude Code itself): [[dispatching-parallel-agents]].
