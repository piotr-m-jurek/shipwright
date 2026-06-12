# Test Corpus — Leave Management System (Synthetic)

This is a synthetic project bundle used to test the Project Description Agent.
It contains five deliberately planted issues that the agent must catch.

---

## Files

| File | Type | Author |
|---|---|---|
| `project_brief.txt` | Short project brief | Anonymous (stakeholder) |
| `prd_draft.md` | PRD draft v0.3 | Sarah Chen, Product Lead |
| `rfp.md` | Request for Proposal | HR Department |
| `discovery_call_transcript.txt` | Discovery call transcript | Meeting notes |
| `hr_requirements.pdf` | HR department requirements doc | Joanna Kowalski, HR Director |

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
- **Expected agent behaviour:** Summarizer surfaces this as a requirement with
  sourceDocument = rfp.md; Challenger flags it as missing from PRD non-functional
  requirements.

### 3. Missing acceptance criteria — manager delegation
**Where:** `discovery_call_transcript.txt` vs `prd_draft.md` vs `hr_requirements.pdf`
- Transcript (Joanna, Tom): delegation is "a core workflow, not a nice-to-have";
  Tom lists specific sub-questions that need acceptance criteria.
- PRD draft: delegation appears only as an open question with no acceptance criteria.
- HR requirements PDF (Section 2): provides full delegation rules and a detailed
  acceptance criteria checklist — but these are not reflected in the PRD draft.
- **Expected agent behaviour:** Challenger flags the gap between the PRD and the
  HR requirements doc; agent asks user to confirm which delegation spec is canonical.

### 4. Ambiguous requirement — notifications
**Where:** `prd_draft.md` + `discovery_call_transcript.txt` + `hr_requirements.pdf`
- PRD draft: "Submission triggers notification to line manager" — channel unspecified.
- Transcript: partially resolved (email + in-app agreed verbally) but not updated in PRD.
- HR requirements PDF (Section 4): specifies email + in-app as mandatory, adds a
  48-hour pending reminder as "non-negotiable", and explicitly defers Slack to V2.
- **Expected agent behaviour:** Summarizer notes the three-way inconsistency; agent
  asks user to confirm the notification spec and whether the 48-hour reminder is in scope.

### 5. Contradiction — SSO / authentication
**Where:** `prd_draft.md` vs `hr_requirements.pdf`
- PRD draft (Section: Out of scope for V1): "SSO / SAML integration — basic
  email/password auth for V1"
- HR requirements PDF (Section 1): "Azure AD SSO is mandatory for all user roles.
  No local username/password accounts." States this is non-negotiable for
  offboarding/deprovisioning reasons.
- **Expected agent behaviour:** Challenger surfaces this as a direct conflict;
  agent asks user to resolve before writing outputs. This is a high-impact
  contradiction — the PRD and the process owner disagree on a fundamental
  architecture decision.

---

## How to use this corpus

Feed all five files as the input bundle in Phase 8 evals.

A passing eval requires the agent to surface all five issues above — either
in the Challenger output, the clarifying questions, or both. Any output
document that reflects the PRD draft's "mobile out of scope" or "email/password
auth" without flagging the conflicts is a faithfulness failure.
