---
name: testing-property-based
description: Use when a unit has invariants that hold for many inputs — Hypothesis / QuickCheck / fast-check / proptest. Properties, generators, shrinking.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [testing-strategy, testing-fuzzing-mutation, tdd, debugging]
---

# Property-Based Testing

**Iron Law: properties before examples. Generate, don't enumerate. Shrinking is the value.**

An example test says "input X produces Y." A property test says "for _any_ valid input, this invariant holds." The framework generates hundreds of inputs trying to break it, then **shrinks** to the minimal counterexample.

## When properties pay

**Strong fit:**

- **Encoders/decoders** — `decode(encode(x)) == x`.
- **Parsers** — `parse(serialize(x)) == x`; never crashes on any byte string.
- **Sorters / set ops** — output sorted; permutation of input; idempotent.
- **State machines** — sequences of valid ops leave the system valid.
- **Data transformations** — round-trip identities, conservation laws.
- **Validators / sanitizers** — `is_valid(x)` and `sanitize(x)` agree on the result.

**Weak fit:**

- Pure CRUD glue — no interesting invariants.
- UI — properties usually trivial.
- Code already covered by short parametrize tables.

## Tool landscape

| Ecosystem               | Library                        |
| ----------------------- | ------------------------------ |
| Python                  | Hypothesis                     |
| Haskell (origin)        | QuickCheck                     |
| JavaScript / TypeScript | fast-check                     |
| Rust                    | proptest, quickcheck           |
| Go                      | rapid, gopter, `testing/quick` |
| Java / JVM              | jqwik                          |
| Erlang                  | PropEr                         |

All share the same machinery: strategies/generators produce values; the test asserts a property; shrinking minimizes any counterexample.

## Anatomy

```pseudo
@given(strategy_for(input_type))
def test_property_name(input):
    # 1. Optionally constrain (assume(...))
    # 2. Run system under test
    output = function_under_test(input)
    # 3. Assert invariant
    assert invariant(input, output)
```

The framework runs this many times with generated inputs.

## Property patterns — what to look for

| Pattern           | Example                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| **Round-trip**    | `decode(encode(x)) == x`; `parse(format(x)) == x`                           |
| **Idempotence**   | `f(f(x)) == f(x)` (normalize, sort, dedupe)                                 |
| **Commutativity** | `f(x, y) == f(y, x)` (set union, merge, max)                                |
| **Associativity** | `f(f(a, b), c) == f(a, f(b, c))`                                            |
| **Identity**      | `f(x, identity) == x` (concat with empty, add zero)                         |
| **Inverse**       | `inverse(f(x)) == x` (encrypt/decrypt)                                      |
| **Oracle**        | Reference impl (slow but correct) agrees with optimized one                 |
| **Metamorphic**   | `f(transform(x)) == transform(f(x))` (rotate-translate vs translate-rotate) |
| **No crash**      | For any input in domain, function doesn't raise/panic/segfault              |
| **Postcondition** | Output meets a constraint (sorted, non-negative, within bounds)             |
| **Conservation**  | Sum / length / set membership preserved                                     |
| **Model-based**   | Implementation matches a simpler model for any operation sequence           |

If you find no property, the function might be too complicated — or property tests aren't the right tool.

## Shrinking — the killer feature

When a 500-element list fails, the framework reduces it to the smallest list (often 1-2 elements) that still fails:

```
Falsifying example: test_merge_is_commutative(
    xs=[0], ys=[-1],
)
```

The minimal counterexample usually points straight at the bug. Custom generators that don't shrink well are a footgun — **prefer built-in strategies**.

## Generators — write the right shape

- Highest-level strategy that matches the domain. `lists(integers(), min_size=1)` not "generate ints and filter."
- **Constrain at generation time, not via `assume()`.** `assume` wastes iterations.
- **Compose strategies** for domain objects (`@composite` in Hypothesis, equivalents elsewhere) so generators read like the domain.
- For domain values, the generator _is_ the schema. Change one, change the other.

## Stateful / model-based property tests

For state machines and APIs, generate a _sequence_ of operations and check an invariant after each:

```pseudo
class BankAccount(StateMachineRule):
    @rule(amount=positive_ints())
    def deposit(self, amount):
        self.account.deposit(amount); self.model_balance += amount

    @rule(amount=positive_ints())
    def withdraw(self, amount):
        if amount > self.model_balance:                 # match the domain rule the impl enforces
            with raises(InsufficientFunds):
                self.account.withdraw(amount)            # impl MUST reject overdraft
        else:
            self.account.withdraw(amount); self.model_balance -= amount

    @invariant()
    def balances_match_and_non_negative(self):
        assert self.account.balance == self.model_balance
        assert self.account.balance >= 0                # the actual domain invariant
```

Two crimes to avoid in the model: (1) model that silently allows what the impl rejects (test passes for the wrong reason — exception fires before invariant); (2) model that mirrors impl bugs (both wrong → green test). The model encodes the _spec_, not a copy of the production code.

## Property vs example tests

They complement; they don't replace:

- **Examples** anchor specific known cases (the original bug, the boundary, the spec example).
- **Properties** explore the input space and find what you didn't think of.

**A bug found by a property test should become a regression example test, plus keep the property.**

## Anti-patterns

- **Asserting `f(x) == reference(x)` where `reference` is buggy** — same bug both sides, test passes.
- **Over-constraining with `assume()`** — generator wastes iterations; tighten the strategy.
- **Non-deterministic property tests** — set the framework's seed in CI; capture seed in the failure report.
- **Shrinking takes forever** — usually a custom generator without a shrink strategy; switch to built-in.
- **Property tests run forever in CI** — default ~100 iterations is fast; tune down for PR, up for nightly.
- **Treating property tests as a replacement for examples** — keep both; examples anchor known cases.
- **Generators that mirror the implementation** rather than the domain — they pass for the wrong reason.

## Common rationalizations

| Excuse                           | Reality                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| "We don't have invariants"       | You probably do. Round-trip and "doesn't crash" apply almost everywhere. |
| "Property tests are slow"        | Default ~100 iters is fast. Tune down; tune up nightly.                  |
| "Generators are too much work"   | Built-ins cover most. Domain composers are a one-time cost.              |
| "We already have 100 unit tests" | They share blind spots. A property test exposes them in minutes.         |

## Hand-off

Unit/integration/e2e foundation: `Skill(testing-strategy)`. Byte-level crash-finding + assertion strength: `Skill(testing-fuzzing-mutation)`. TDD-driven invariants: `Skill(tdd)`. Language harnesses: `Skill(python-testing)`, `Skill(go-testing)`, `Skill(rust-testing)`, `Skill(typescript)`.
