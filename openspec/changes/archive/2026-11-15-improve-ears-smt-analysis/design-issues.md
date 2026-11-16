# Implementation Design Issues

## Permission-Track Cross-Side Comparison

**Status:** Resolved. The user selected separate permission verdicts and instructed implementation to continue.

### Existing contract

- `FLA-MODAL-TRACKS` excludes permissions from mandatory baseline C and does not require the permitted response.
- `STC-IMPLY-AGGREGATE` compares compatible modal tracks.
- `STC-IMPLY-STRONGER` / `STC-IMPLY-WEAKER` use implication direction to classify guarantees.
- The design does not define whether those guarantee labels apply to permission tracks, whether permission-set inclusion has separate labels, or how permission differences affect whole-capability assessment.

### Concrete distinguishing case

Under the same guard and background, suppose the original explicitly permits response A and the generated specification permits A or B.

The finite response sets are:

```text
original:  {A}
generated: {A, B}
```

The original response predicate entails the generated predicate, but not conversely. Applying the existing obligation-oriented direction table therefore reports generated `weaker`. As a permission relation, the generated set is instead strictly broader. Neither interpretation is defined as the intended permission verdict by the current artifacts.

Comparing only mandatory C is also insufficient: both baselines are true in this example, so dropping permission predicates yields `same` and loses the explicit permission difference.

### Decision needed

Choose the permission-track relation and its reporting impact:

1. **Separate permission-set comparison:** report equivalent, broader, narrower, or different permitted sets within the admitted static scope; reserve stronger/weaker guarantee labels for obligation tracks. Qualify whole-capability assessment when permission tracks differ.
2. **Reuse stronger/weaker labels:** explicitly define their permission meaning and the intended polarity, including the distinguishing example above and absence of an explicit permission on one side.
3. **Feasibility-only permissions initially:** retain permission/prohibition checks but report cross-side permission comparison as unsupported scope, preventing whole-capability equivalence when relevant permissions are unexamined.

The selected first option preserves modality separation. Permission relations are `permission-equivalent`, `permission-broader`, `permission-narrower`, or `permission-different`, with ordinary unresolved/incompatible/uncertain scope retained. Broader and narrower refer to the generated permitted set relative to the original. Missing explicit permission is unmapped scope, not an implicit empty permitted set. Whole-capability alignment requires equivalent permission tracks as well as compatible obligation conclusions.

### Work completed before pause

- Task 1.1: 199 tagged headers mapped to verification expectations under 34 requirement groups.
- Task 1.2: lifecycle abstraction refined with raw attempt evidence, frozen registry snapshots, ownerless group queries, and additional-sample failure; five positive witnesses and twelve bounded assertions checked successfully.

Production parsing/formalization/solver behavior has not yet been changed. Remaining implementation tasks stay unchecked.
