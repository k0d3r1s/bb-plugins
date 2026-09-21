---
name: php-quality
description: Use when linting and static-analysing PHP — php-cs-fixer, PHPStan, twig-cs-fixer, CI wiring.
metadata:
  added: 2026-05-23
  last_reviewed: 2026-05-23
  type: language
  languages: [php]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-23"
  related: [php-essentials, ci-github-actions]
---

# PHP Quality

**Iron Law: php-cs-fixer owns FORMAT, PHPStan owns CORRECTNESS — two tools, two jobs, never blur them. PHPStan runs at `max` (or the highest level your code clears) from the start; a baseline is debt you pay down, not a place to hide errors. In CI run the fixer with `--dry-run --using-cache=no` so it gates without rewriting.**

**Versions:** php-cs-fixer `3.x` · PHPStan `2.x` (+ `phpstan/phpstan-symfony`, `phpstan/phpstan-strict-rules`) · twig-cs-fixer `latest` · — _php-cs-fixer 3 split rulesets into `@PER-CS` (the PSR successor) and `@Symfony`; PHPStan 2 raised the default to bleeding-edge analysis and tightened generics. Pin both in `composer.json` `require-dev` so CI and local agree._

## php-cs-fixer — the formatter

```php
<?php
// .php-cs-fixer.dist.php  (committed; `.php-cs-fixer.php` is the local override, gitignored)
$finder = (new PhpCsFixer\Finder())
    ->in([__DIR__ . '/src', __DIR__ . '/tests'])
    ->exclude(['var', 'vendor']);

return (new PhpCsFixer\Config())
    ->setRiskyAllowed(true)                  // required to enable any *_risky rule
    ->setRules([
        '@PER-CS'             => true,        // PSR-12 successor — the modern base
        '@Symfony'            => true,        // Symfony house style on top
        '@Symfony:risky'      => true,        // risky = may change behaviour (e.g. strict comparisons)
        'declare_strict_types'=> true,        // adds `declare(strict_types=1);`
        'native_function_invocation' => ['include' => ['@compiler_optimized']],  // \strlen etc.
        'global_namespace_import'    => ['import_classes' => true, 'import_functions' => false],
    ])
    ->setFinder($finder);
```

`@*:risky` rules can change runtime behaviour (strict comparisons, type juggling) — review the diff the first time. Commands mirror the project's composer scripts:

```jsonc
// composer.json scripts — mirror the fixer invocation so it's one command
"fix":      ["vendor/bin/php-cs-fixer --config=.php-cs-fixer.dist.php --using-cache=no fix -vvv"],
// multi-config monorepo: one script per package, each using that package's own config
"fix:acme": ["vendor/bin/php-cs-fixer --config=packages/acme/.php-cs-fixer.dist.php --using-cache=no fix packages/acme/ -vvv"]
```

`--using-cache=no` is deliberate in these scripts — the cache keys on file mtime + ruleset, and in a multi-config monorepo (one config per package path) stale cache hits skip files that a different config should touch. Locally you may keep the cache (`--using-cache=yes`, default) for speed; in CI always disable it.

## PHPStan — the static analyser

```neon
# phpstan.neon
includes:
    - vendor/phpstan/phpstan-symfony/extension.neon
    - vendor/phpstan/phpstan-strict-rules/rules.neon
    - phpstan-baseline.neon            # legacy debt only — see below

parameters:
    level: max                          # 0..9 then `max`; start as high as the code clears
    paths:
        - src
        - tests
    symfony:
        containerXmlPath: var/cache/dev/App_KernelDevDebugContainer.xml  # resolves get()/getParameter()
    treatPhpDocTypesAsCertain: false    # don't trust phpdoc that the engine can't verify
    ignoreErrors:
        - identifier: missingType.generics   # narrow: by error identifier, scoped
          path: src/Legacy/*.php
```

Levels 0→9 add checks incrementally (0 = basic, 9 = strict nullability + generics); `max` is the current ceiling and tracks new rules across releases. **Set the level as high as the codebase clears today, not lower** — a too-low level (e.g. `level: 3` on greenfield code) silently waves through whole classes of bugs PHPStan would otherwise catch.

- `phpstan-symfony` resolves `$container->get(Foo::class)` return types and service IDs — point `containerXmlPath` at the compiled dev container (regenerate with `bin/console cache:warmup` in CI before analysing).
- `phpstan-strict-rules` bans loose comparisons, dynamic method calls, and switch-without-default — the correctness complement to the fixer's `:risky` formatting.

### Baseline — debt, not a dumping ground

```bash
vendor/bin/phpstan analyse --generate-baseline   # snapshots current errors into phpstan-baseline.neon
```

The baseline freezes today's errors so you can raise the level without fixing everything at once. Rules: shrink it every sprint, never let it grow, and review every NEW entry in code review — a PR that adds baseline lines is hiding fresh errors. Treat a growing baseline as a failing health metric.

### Inline ignores — last resort, always explained

```php
// WRONG — opaque, suppresses everything on the line forever
$x = $svc->maybe();  // @phpstan-ignore-line

// RIGHT — specific identifier + reason, fails if the error disappears
$x = $svc->maybe();  /** @phpstan-ignore method.notFound (upstream stub gap, tracked #1234) */
```

Always pin the identifier (`@phpstan-ignore method.notFound`) not the blanket `@phpstan-ignore-line`. With `reportUnmatchedIgnoredErrors: true` (PHPStan 2 default) a stale ignore fails CI — that's the signal to delete it once the underlying issue is fixed.

## twig-cs-fixer — templates

```php
// .twig-cs-fixer.php (or .twig-cs-fixer.dist.php)
return (new TwigCsFixer\Config\Config())
    ->setFinder((new TwigCsFixer\File\Finder())->in(__DIR__ . '/templates'));
```

```jsonc
"twig": ["vendor/bin/twig-cs-fixer lint --fix"]   // --fix rewrites; CI uses bare `lint`
```

Twig has its own whitespace/spacing rules PHP fixers can't see (`{{ x }}` spacing, block ordering). Lint templates in the same pipeline so a `.twig` file can't bypass formatting.

## CI wiring

Three independent gates, three failure modes — never collapse them, since the first failure would mask the rest:

```yaml
# pseudo-pipeline — see ci-github-actions for the full workflow
- composer install --no-progress --prefer-dist
- bin/console cache:warmup --env=dev # PHPStan needs the compiled container
- vendor/bin/php-cs-fixer fix --dry-run --diff --using-cache=no # FORMAT gate (no rewrite)
- vendor/bin/phpstan analyse --no-progress --error-format=github # CORRECTNESS gate
- vendor/bin/twig-cs-fixer lint # TEMPLATE gate
```

`--dry-run --diff` makes the fixer report-and-fail instead of rewriting in CI; `--error-format=github` turns PHPStan errors into inline annotations on the PR.

## Anti-patterns

- Baseline as a dumping ground — regenerating it to make CI green hides every new error. Shrink it; review new entries.
- `level` set lower than the code clears — silently disables real checks; raise to `max` and baseline the gap instead.
- Inline `@phpstan-ignore-line` everywhere — opaque, suppresses unrelated future errors. Use `@phpstan-ignore <identifier>` with a reason.
- Running the fixer WITH cache in CI — stale mtime/ruleset cache skips files; always `--using-cache=no` in CI.
- Fixer rewriting files in CI (`fix` without `--dry-run`) — CI should gate, not mutate; rewrites belong to local `composer fix`.
- Letting PHPStan analyse without the warmed Symfony container — `get()`/`getParameter()` types degrade to `mixed`, weakening every check.
- `setRiskyAllowed(false)` then enabling a `:risky` ruleset — the risky rules silently no-op.
- Twig templates excluded from the pipeline — formatting drift hides where no PHP fixer reaches.

## Red flags

| Thought                                  | Reality                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| "Just baseline it, we'll fix it later"   | The baseline only ever grows; later never comes. Fix or scope-ignore. |
| "PHPStan passes, so the code is correct" | At `level: 2` it barely checks nullability. Raise the level.          |
| "The fixer rewrote files in CI"          | You omitted `--dry-run`; CI must gate, not mutate.                    |
| "Errors come and go between runs"        | Fixer cache in CI, or unwarmed container for PHPStan.                 |
| "`@phpstan-ignore-line` is fine here"    | It also hides the NEXT bug on that line. Pin the identifier.          |

## Hand-off

PHP language idioms the fixer/analyser presuppose (strict types, naming, typed properties, layout): `Skill(k0d3:php-essentials)`. Turning these three gates into a real workflow — caching `vendor/`, the dependency matrix, warming the container, PR annotations: `Skill(k0d3:ci-github-actions)`.
