# Test Corpus — Leave Management System (Synthetic)

This is a synthetic project bundle used to test the Project Description Agent.
It contains four deliberately planted issues that the agent must catch.

---

## Planted issues (ground truth)

### 1. Contradiction — mobile scope
**Where:** `discovery_call_transcript.txt` vs `prd_draft.md`
- Transcript (Marcus, referencing CEO): mobile is a hard requirement, in scope
- PRD draft (Section: Out of scope for V1): "Mobile application — web only for V1"
- **Expected agent behaviour:** Challenger surfaces this as a conflict; agent asks
  user to confirm which is correct before writing outputs.

### 2. Buried constraint — EU data residency
**Where:** `rfp.md` paragraph 7
- The RFP's data residency clause (all data must stay in the EU, AWS eu-region
  only) is buried in paragraph 7 under a generic "compliance" heading.
- It is not flagged as a key constraint in the PRD draft or the brief.
- **Expected agent behaviour:** Extractor surfaces this as a requirement with
  sourceDocument = rfp.md; Challenger flags it as missing from PRD non-functional
  requirements.

### 3. Missing acceptance criteria — manager delegation
**Where:** `discovery_call_transcript.txt` vs `prd_draft.md`
- Transcript (Joanna, Tom): delegation is "a core workflow, not a nice-to-have";
  Tom lists specific sub-questions that need acceptance criteria.
- PRD draft: delegation appears only as an open question with no acceptance criteria.
- **Expected agent behaviour:** Challenger flags this gap; agent asks user to
  confirm delegation behaviour before writing the PRD.

### 4. Ambiguous requirement — notifications
**Where:** `prd_draft.md` + `discovery_call_transcript.txt`
- PRD draft: "Submission triggers notification to line manager" — channel unspecified.
- Transcript: partially resolved (email + in-app agreed verbally) but not yet
  updated in the PRD.
- **Expected agent behaviour:** Extractor notes the ambiguity; agent asks user
  to confirm the notification channels before writing outputs.

---

## How to use this corpus

Feed all four files (project_brief.txt, prd_draft.md, rfp.md,
discovery_call_transcript.txt) as the input bundle in Phase 8 evals.

A passing eval requires the agent to surface all four issues above — either
in the Challenger output, the clarifying questions, or both. Any output
document that reflects the PRD draft's "mobile out of scope" without flagging
the conflict is a faithfulness failure.
