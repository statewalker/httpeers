---
"@statewalker/httpeers-access": minor
---

`ruleSet` takes `facts`, an application's own fact vocabulary (`name` or `name/arity`), and `params`, values bound as terms in rules and policies. `authorize` takes those facts as `RequestFacts.extra`; undeclared predicates stay refused in both places, and a rule cannot derive a declared fact. `RuleSet.facts` lists the declaration. Predicate and role detection now ignore text inside string literals.
