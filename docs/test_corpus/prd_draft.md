# Leave Request Management System — PRD Draft v0.3

**Author:** Sarah Chen, Product Lead
**Last updated:** 2024-11-12
**Status:** Draft — incomplete

---

## Problem statement

Current process relies on a shared Google Sheet. Issues: no audit trail,
managers miss requests when away, HR cannot see real-time availability,
payroll team manually cross-references approved leave with payroll runs.

---

## Users

- **Employees** — submit and track their own leave requests
- **Line managers** — approve or reject direct reports' requests
- **HR administrators** — full visibility, manual overrides, reporting

---

## Core features

### Leave submission
- Employee selects leave type (annual, sick, parental, other)
- Employee selects date range with a calendar picker
- System checks remaining entitlement and warns if insufficient balance
- Employee adds optional notes
- Submission triggers notification to line manager

### Approval workflow
- Manager receives notification of pending request
- Manager can approve, reject, or request more information
- Employee notified of decision
- Approved leave reflected in team calendar immediately

### HR dashboard
- Overview of all pending requests across the organisation
- Team calendar view showing who is off when
- Leave balance report per employee
- Ability to manually adjust leave balances
- Export to CSV for payroll integration

### Integrations
- BambooHR sync: employee records, reporting lines, leave entitlements
- Payroll export: approved leave data in payroll-compatible CSV format

---

## Out of scope for V1

- Mobile application — web only for V1, mobile considered for V2
- SSO / SAML integration — basic email/password auth for V1
- Automated payroll API integration — CSV export only
- Multi-language support

---

## Open questions

- What happens when a manager is on leave and cannot approve requests?
  *(no answer yet)*
- Should the system enforce minimum notice periods per leave type?
- Who approves HR administrators' own leave requests?

---

## Non-functional requirements

- Must support 340 concurrent users
- Response time under 2 seconds for all core actions
- 99.5% uptime SLA

---

## Acceptance criteria

*(incomplete — to be filled before development)*

### Leave submission
- [ ] Employee can submit a leave request in under 3 clicks
- [ ] System rejects requests where remaining balance is insufficient
- [ ] Submission confirmation shown to employee within 2 seconds

### Approval workflow
- [ ] Manager receives notification within 5 minutes of submission
- [ ] Approved leave appears on team calendar within 1 minute of approval

### HR dashboard
- [ ] HR can filter requests by team, leave type, and date range
- [ ] CSV export contains all fields required by payroll team

---

## Stack notes

*(TBD)*
