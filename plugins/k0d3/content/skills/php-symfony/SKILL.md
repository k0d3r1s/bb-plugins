---
name: php-symfony
description: Use when building apps with Symfony 8 — attribute routing, DI/autowiring, Form/Validator, Twig, asset-mapper.
metadata:
  added: 2026-05-23
  last_reviewed: 2026-05-23
  type: language
  languages: [php]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-23"
  related: [php-essentials, php-doctrine, php-testing, infra-frankenphp, rest-essentials]
---

# Symfony 8

**Iron Law: wire by type, not by string — autowiring + `#[Autowire]` over manual `services.yaml` ids. Controllers stay thin: validate, delegate to a service, render. Never `new` a service Symfony can inject. Secrets come from env, never from committed YAML.**

**Versions:** `8.0` stable (the LTS-line baseline); `8.1` in beta and tracked by this project via `"require": "8.1.*"`. PHP floor is **8.5**. Symfony 8 drops the legacy container-builder compat layer — attribute config is the default, annotations are gone for good.

## framework-bundle + Flex

`symfony/framework-bundle` is the kernel. **Flex** maps a package to a _recipe_ — on `composer require` it drops config into `config/packages/`, registers the bundle in `config/bundles.php`, and adds env defaults to `.env`. Don't hand-edit `bundles.php`; let the recipe own it. `allow-contrib: true` (set in `composer.json extra.symfony`) opts into community recipes.

## Runtime — FrankenPHP, not PHP-FPM

```php
// public/index.php
use App\Kernel;
require_once dirname(__DIR__).'/vendor/autoload_runtime.php';
return fn (array $context) => new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);
```

`symfony/runtime` decouples the front controller from the SAPI. This project sets `APP_RUNTIME=Runtime\FrankenPhpSymfony\Runtime` (via `runtime/frankenphp-symfony`, pinned in `composer.json extra.runtime.class`). FrankenPHP runs the app as a **resident worker** — the kernel boots once and serves many requests, so module-level state leaks across requests. Reset stateful services between requests; never cache request-scoped data on a service property. See `Skill(k0d3:infra-frankenphp)` for worker config, `frankenphp_handle_request()`, and the Caddy layer.

## Attribute routing

```php
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\HttpFoundation\{Request, Response, JsonResponse};

#[Route('/api/orders', name: 'order_')]
final class OrderController
{
    #[Route('/{id}', name: 'show', methods: ['GET'], requirements: ['id' => '\d+'])]
    public function show(int $id, OrderRepository $orders): JsonResponse
    {
        $order = $orders->find($id) ?? throw $this->createNotFoundException();
        return $this->json($order, context: ['groups' => ['order:read']]);
    }
}
```

Class-level `#[Route]` prefixes path + name. `methods` is mandatory discipline — never let one action answer every verb. Generate URLs with the router service or `$this->generateUrl('order_show', ['id' => $id])`, never string-concatenate paths.

## DI — autowiring + autoconfigure

```yaml
# config/services.yaml
services:
  _defaults:
    autowire: true # inject by type-hint
    autoconfigure: true # auto-tag commands, subscribers, voters
  App\:
    resource: "../src/"
    exclude: "../src/{Entity,Kernel.php}"
```

Type-hint a service in a constructor and it's injected — no id wiring. Disambiguate scalars/multiple impls with `#[Autowire]`:

```php
public function __construct(
    #[Autowire('%kernel.project_dir%/var/uploads')] private string $uploadDir,
    #[Autowire(service: 'monolog.logger.audit')] private LoggerInterface $audit,
    #[Autowire(env: 'STRIPE_KEY')] private string $stripeKey,
) {}
```

Bind interfaces to implementations once under `services.yaml` when one type has multiple consumers; reach for `#[AsAlias]` / tagged-iterator (`#[AutowireIterator]`) for plugin-style collections.

## Console commands

```php
use Symfony\Component\Console\Attribute\{AsCommand, Argument, Option};
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Component\Console\Command\Command;

#[AsCommand(name: 'app:purge-orders', description: 'Delete cancelled orders older than N days')]
final class PurgeOrdersCommand
{
    public function __construct(private OrderRepository $orders) {}

    public function __invoke(
        SymfonyStyle $io,
        #[Argument] int $days = 30,
        #[Option] bool $dryRun = false,
    ): int {
        $count = $this->orders->purgeCancelledOlderThan($days, $dryRun);
        $io->success("Purged {$count} orders");
        return Command::SUCCESS;
    }
}
```

`#[AsCommand]` + invokable command with `#[Argument]`/`#[Option]` params is the Symfony 8 style — no `configure()`/`execute()` boilerplate. Return `Command::SUCCESS|FAILURE`. `autoconfigure` registers it; no manual tag.

## Form + Validator

Constraints live as attributes on the data object; the form binds to it.

```php
use Symfony\Component\Validator\Constraints as Assert;

final class RegistrationDto
{
    #[Assert\NotBlank, Assert\Email]
    public string $email = '';

    #[Assert\Length(min: 12), Assert\NotCompromisedPassword]
    public string $password = '';
}
```

```php
$form = $this->createForm(RegistrationType::class, $dto);
$form->handleRequest($request);
if ($form->isSubmitted() && $form->isValid()) { /* persist $dto */ }
```

The Validator runs constraint metadata regardless of the Form layer — call it directly on DTOs in API controllers via the injected `ValidatorInterface`. Validate the _domain object_, not raw request input.

## Serializer

```php
use Symfony\Component\Serializer\Attribute\Groups;

final class Order
{
    #[Groups(['order:read'])] public int $id;
    #[Groups(['order:read', 'order:write'])] public string $sku;
}
// $serializer->serialize($order, 'json', ['groups' => ['order:read']]);
```

Groups gate which properties cross the wire — never expose an entity without them. For request bodies, deserialize into a DTO then validate; don't deserialize straight onto a Doctrine entity. For REST contract shape see `Skill(k0d3:rest-essentials)`.

## Security CSRF

`symfony/security-csrf` guards state-changing forms. The Form component injects a token automatically; for hand-rolled forms emit `csrf_token('intent')` in Twig and verify with `isCsrfTokenValid('intent', $request)`. Stateless JSON APIs use token/JWT auth instead — CSRF protection applies to cookie-session flows.

## Twig (shallow)

`symfony/twig-bundle` wires templating; render with `$this->render('order/show.html.twig', [...])`. Autoescaping is on by default; `|raw` on user input is XSS. Depth — inheritance, macros, Symfony functions (`path()`, `asset()`, `form_*`), custom extensions, `twig-cs-fixer` — lives in `references/twig.md`.

## asset-mapper + importmap (no Node build)

`symfony/asset-mapper` ships ES modules straight to the browser — **no webpack/vite, no `node_modules` build step**. `importmap.php` pins versions; `bin/console importmap:require bootstrap` adds one. In dev files serve raw; `asset-map:compile` fingerprints + dumps for prod. Reference assets in Twig via `asset('styles/app.css')`; the runtime emits an import map + modulepreload links. Reach for a real bundler only when you need JSX/TS compilation or tree-shaking.

## Env + secrets

`.env` holds non-secret defaults (committed); `.env.local` is git-ignored per-machine overrides. Real secrets use the **secrets vault**: `bin/console secrets:set DATABASE_PASSWORD` (encrypted with `config/secrets/<env>/`), decrypt key injected at deploy. Read with `%env(DATABASE_URL)%` in config or `#[Autowire(env: ...)]`. Never commit `.env.local` or a plaintext secret.

## Multi-app architecture (this project)

`composer.json` autoloads `apps/autoload.php` (a `files` entry) and runs `valksor:autoload-generate` post-install/update to regenerate it. Multiple apps live under `apps/`, each with its own kernel/config slice, sharing the `App\` (`src/`) and `Infrastructure\` PSR-4 roots. The generated autoload stitches per-app namespaces in. Don't hand-edit the generated file — re-run the generator. `optimize-autoloader: false` + `apcu-autoloader: true` is deliberate: APCu caches the classmap at runtime instead of a frozen build-time map, which suits the resident FrankenPHP worker.

## Anti-patterns

- Manual `services.yaml` ids when autowiring would resolve by type — config rot
- `new SomeService()` inside a controller/service — bypasses DI, untestable
- Deserializing request JSON directly onto a Doctrine entity — mass-assignment + no validation gate
- Returning an entity from a controller without Serializer `#[Groups]` — leaks every column
- Business logic in controllers or `__invoke` — push to a service; controller orchestrates only
- `|raw` / `mark_safe`-style escaping bypass on user content — XSS
- Caching request-scoped data on a service property under the FrankenPHP worker — leaks across requests
- Hand-editing `config/bundles.php` or the generated `apps/autoload.php` — let Flex / the generator own them
- Plaintext secrets in `.env` or committed `.env.local` — use the secrets vault
- Reaching for webpack when asset-mapper + importmap already cover plain ES modules

## Red flags

| Thought                                   | Reality                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| "I'll just `new` the mailer here"         | now it's untestable and unconfigurable — type-hint it, DI injects it          |
| "Autowiring is magic I can't trust"       | it resolves by type at compile time; `bin/console debug:autowiring` shows all |
| "FPM and FrankenPHP behave the same"      | the worker keeps the kernel alive — static/request state leaks between hits   |
| "I'll validate in the controller by hand" | put `#[Assert\*]` on the DTO and let the Validator run it everywhere          |
| "Render the entity straight to JSON"      | no `#[Groups]` means every column ships, including hashes and internal flags  |
| "I need webpack for this stylesheet"      | asset-mapper serves it; importmap pins JS deps — drop the Node build          |

## Hand-off

For persistence — entities, EntityManager, DQL, migrations, N+1: `Skill(k0d3:php-doctrine)`. For the FrankenPHP worker runtime, Caddy, and worker-mode pitfalls: `Skill(k0d3:infra-frankenphp)`. For PHPUnit, Symfony's `KernelTestCase`/`WebTestCase`, and DI in tests: `Skill(k0d3:php-testing)`. For language-level PHP rules: `Skill(k0d3:php-essentials)`. For the full Twig 3 surface: `references/twig.md`.
