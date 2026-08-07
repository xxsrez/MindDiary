---
type: Attested Computation
title: Revenue fixture
runtime: future-runtime
parameters:
  - name: year
    type: integer
    required: true
executor:
  resource: references/run-future-runtime.md
  receipt: [result]
attester:
  resource: references/attest-result.md
future_contract_field:
  preserve: exactly
---

# Computation

```text
revenue(year)
```
