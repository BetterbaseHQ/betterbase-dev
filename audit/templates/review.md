# Review: <scope>

- Reviewer / assignment:
- Date / baseline revisions / local changes:
- Status: queued | in progress | analyzed | verified
- Invariant IDs:
- Entry points and reviewed surfaces:
- Explicit exclusions and unreviewed dependencies:

## Guarantees and state transitions

Describe trust boundaries, state ownership, transactions, and failure/recovery paths. Separate intended behavior from observed implementation.

## Evidence and candidate findings

Use assignment-local IDs, source paths/lines at the recorded revision, preconditions, expected versus actual behavior, and reproduction/evidence links. Include counterevidence and uncertainty. Distinguish test gaps from product defects.

## Checks executed

Link execution records created from [the evidence template](../templates/evidence.md). Record passes, failures, skips, and checks not run. State whether mocks or real browser/database/network paths were used.

## Architecture and cross-component handoffs

Identify duplicated state, ambiguous ownership, fragile error propagation, and specific handoffs the coordinator must reconcile. Tie recommendations to failure mechanisms.

## Remaining work

List unresolved hypotheses, follow-up tests, remediation dependencies, and scope needed before closure.
