# Council Mode Pass Contracts

Load this before launching council advisors.

## Pass 1 report

Native Pi advisors receive this schema through `options.outputSchema`. External runners receive the same shape as plain JSON task text and no native output-schema option.

```js
const pass1OutputSchema = {
  type: "object",
  required: [
    "recommendation",
    "evidence",
    "assumptions",
    "risks",
    "confidence",
    "challengeClaims",
    "ownerDecisions",
    "changeMyMind"
  ],
  properties: {
    recommendation: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "sources"],
        properties: {
          claim: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        }
      }
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        required: ["assumption", "status"],
        properties: {
          assumption: { type: "string" },
          status: { enum: ["verified", "unverified"] }
        }
      }
    },
    risks: { type: "array", items: { type: "string" } },
    confidence: {
      type: "object",
      required: ["level", "reason"],
      properties: {
        level: { enum: ["high", "medium", "low"] },
        reason: { type: "string" }
      }
    },
    challengeClaims: { type: "array", items: { type: "string" }, maxItems: 3 },
    ownerDecisions: { type: "array", items: { type: "string" } },
    changeMyMind: { type: "array", items: { type: "string" } }
  }
};
```

Task text:

- inspect supplied evidence directly
- do not ask other advisors or read peer reports
- stay read-only
- do not spawn children
- return only the structured report
- keep the report under about 600 words

For external runners, say: `Return only JSON matching this shape. Do not wrap it in Markdown.` Include any evidence they cannot read with tools.

## Pass 1 aggregate receipt

After reading the saved reports, return one aggregate receipt in roster order. For each advisor include its executable profile name, latest child runId, known context mode, and report. Identify children from completion notices or run status, not from a parent workflow ID. Use `runtime-default-unknown` when the context mode is not known rather than guessing it.

## Pass 2 challenge

A challenge packet contains only disputed claims, strong conflicting evidence, missing proof, owner decisions, and high-impact risks. Attribute peer content as "another advisor". Do not include full peer reports.

Native Pi continuations explicitly replace the stored Pass 1 schema with `options.outputSchema: pass2OutputSchema`. External runners receive the same shape as JSON-only message text and no native output-schema option.

```js
const pass2OutputSchema = {
  type: "object",
  required: ["responses", "recommendationChanged", "outOfScopeFindings"],
  properties: {
    responses: {
      type: "array",
      items: {
        type: "object",
        required: ["claimId", "disposition", "reason", "sources"],
        properties: {
          claimId: { type: "string" },
          disposition: { enum: ["accept", "reject", "refine", "owner-decision"] },
          reason: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        }
      }
    },
    recommendationChanged: {
      type: "object",
      required: ["changed", "reason"],
      properties: {
        changed: { type: "boolean" },
        reason: { type: "string" }
      }
    },
    outOfScopeFindings: { type: "array", items: { type: "string" } }
  }
};
```

For a completed native advisor:

```javascript
subagent({
  action: "resume",
  id: "<latest child runId>",
  message: "<curated challenge packet; retain the read-only scope>",
  options: { outputSchema: pass2OutputSchema },
})
```

The aggregate Pass 2 receipt uses the same fields as Pass 1 with the new runIds and saved reports. Pass 3 continues those latest ids with the same challenge schema. Reuse the selected model profiles; the council task supplies the read-only scope and report contract.
