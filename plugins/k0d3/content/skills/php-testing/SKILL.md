---
name: php-testing
description: Use when testing PHP — PHPUnit 13 attributes, data providers, fixtures, test doubles, Mockery, Symfony KernelTestCase/WebTestCase.
metadata:
  added: 2026-05-23
  last_reviewed: 2026-05-23
  type: language
  languages: [php]
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-23"
  related: [tdd, testing-strategy, php-symfony]
---

# PHP Testing

**Iron Law: PHPUnit 13 reads PHP 8 attributes, NOT docblock annotations — `/** @test \*/`and`@dataProvider`are gone (removed in 13). Every test class extends`TestCase`; every data provider is a `public static function`. Reach for `createMock`/`createStub` first; Mockery only when PHPUnit's doubles can't express the interaction.\*\*

**Versions:** PHPUnit `13.x` (requires **PHP 8.4+**; 8.4 + 8.5 are the only PHP lines it supports) · Mockery `1.x` · — _PHPUnit 11 deprecated annotations, 12 hard-deprecated them, 13 removed them. If you land on 13 you have already migrated to attributes — there is no annotation fallback. Run `vendor/bin/phpunit --migrate-configuration` once to bump the XML schema._

## TestCase structure

```php
<?php
declare(strict_types=1);                     // catches int/float/string coercion the SUT relies on

namespace App\Tests\Service;                 // mirrors src/ via PSR-4

use App\Service\PriceCalculator;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(PriceCalculator::class)]        // replaces @covers; ties coverage to the SUT
final class PriceCalculatorTest extends TestCase   // final: tests are leaves, never subclassed
{
    public function testAppliesVat(): void    // method name still must start with `test`...
    {
        self::assertSame(121.0, (new PriceCalculator())->withVat(100.0, 0.21));  // static form is modern
    }
}
```

File `XxxTest.php` under `tests/`. `self::assert*` (static) is the modern form; `$this->assert*` still works.

## PHP 8 attributes — the annotation replacement table

| Removed annotation       | Attribute (namespace `PHPUnit\Framework\Attributes`) |
| ------------------------ | ---------------------------------------------------- |
| `/** @test */`           | `#[Test]` (lets you drop the `test` name prefix)     |
| `@dataProvider provideX` | `#[DataProvider('provideX')]`                        |
| `@covers \App\Foo`       | `#[CoversClass(Foo::class)]` / `#[CoversMethod]`     |
| `@group slow`            | `#[Group('slow')]`                                   |
| `@depends testCreate`    | `#[Depends('testCreate')]`                           |
| `@testWith [...]`        | `#[TestWith([1, 2, 3])]` (inline rows)               |
| `@dataProviderExternal`  | `#[DataProviderExternal(OtherTest::class, 'provX')]` |

`#[Test]` lets you drop the `test` name prefix; stack attributes (`#[Test] #[Group('unit')]`). `#[Depends('appliesVat')]` makes a method receive the depended-on test's return value as an argument.

## Assertions worth reaching for

`assertSame` (`===`, type-strict — default choice) vs `assertEquals` (`==`, loose — avoid). `assertEqualsCanonicalizing` for order-insensitive arrays. `assertInstanceOf`, `assertCount`, `assertArrayHasKey`, `assertStringContainsString`. `expectException(DomainException::class)` + `expectExceptionMessage(...)` BEFORE the throwing call. New in 13: `assertArrayIsEqualToArrayOnlyConsideringListOfKeys` and friends for partial array comparison.

## Data providers — static methods

```php
use PHPUnit\Framework\Attributes\DataProvider;

#[Test]
#[DataProvider('vatCases')]
public function appliesVat(float $net, float $rate, float $expected): void
{
    self::assertSame($expected, (new PriceCalculator())->withVat($net, $rate));
}

public static function vatCases(): iterable    // MUST be static + public in PHPUnit 10+
{
    yield 'standard' => [100.0, 0.21, 121.0];  // string keys name the row in output
    yield 'zero rate' => [100.0, 0.0, 100.0];
}
```

`yield`-with-string-keys names each row in the failure report. Non-static providers are a hard error since PHPUnit 10 — don't `$this->` inside one.

## Fixtures

```php
protected function setUp(): void    { parent::setUp(); $this->sut = new Thing(); }
protected function tearDown(): void { unset($this->sut); parent::tearDown(); }
```

`setUp` runs before EACH test (fresh state). `setUpBeforeClass`/`tearDownAfterClass` are static, run once per class — use only for genuinely immutable shared setup. Prefer fresh per-test state; shared mutable state across tests is order-dependence waiting to happen.

## Test doubles — PHPUnit first

```php
$repo = $this->createMock(UserRepository::class);   // all methods stubbed + expectations
$repo->method('find')->willReturn($user);
$repo->expects(self::once())->method('save')->with($user);

$clock = $this->createStub(Clock::class);           // stub: returns only, no expectations
$clock->method('now')->willReturn(new DateTimeImmutable('2026-05-23'));

$svc = $this->createPartialMock(Mailer::class, ['send']);  // mock ONLY listed methods
```

| Need                                         | Tool                                       |
| -------------------------------------------- | ------------------------------------------ |
| Verify a call happened (`expects`)           | `createMock`                               |
| Canned return, no verification               | `createStub`                               |
| Real object, override one method             | `createPartialMock`                        |
| Fluent/chained APIs, magic methods, closures | **Mockery** (`Mockery::mock`)              |
| `final` class / no interface                 | Mockery `mock('overload:...')` or refactor |

PHPUnit 13 ships **sealed test doubles** — calling an unconfigured method throws instead of returning null. Configure every method the SUT touches.

## Mockery — when PHPUnit can't express it

```php
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;

final class GatewayTest extends TestCase
{
    use MockeryPHPUnitIntegration;            // auto-runs Mockery::close() in tearDown

    public function testCharges(): void
    {
        $api = \Mockery::mock(StripeClient::class);
        $api->shouldReceive('charges->create')   // chained call in one expectation
            ->once()->with(\Mockery::on(fn($a) => $a['amount'] === 5000))
            ->andReturn((object) ['id' => 'ch_1']);
    }
}
```

The `MockeryPHPUnitIntegration` trait is mandatory — without `Mockery::close()` unmet expectations pass silently.

## Symfony — KernelTestCase / WebTestCase

```php
// KernelTestCase: real DI container, no HTTP layer — for services
final class OrderServiceTest extends KernelTestCase {
    public function testService(): void {
        self::bootKernel();
        $svc = self::getContainer()->get(OrderService::class);   // real wired service
        self::assertSame('ok', $svc->process());
    }
}
// WebTestCase: boots kernel + HTTP layer (no real server) — for controllers
final class HomeControllerTest extends WebTestCase {
    public function testHomepage(): void {
        $client = static::createClient();
        $client->request('GET', '/');
        self::assertResponseIsSuccessful();      // Symfony assertion mixin
        self::assertSelectorTextContains('h1', 'Welcome');
    }
}
```

Console commands: `ApplicationTester` (or the lighter `CommandTester`):

```php
$app = new Application(self::$kernel);
$app->setAutoExit(false);                     // tester needs the exit code, not exit()
$tester = new ApplicationTester($app);
$tester->run(['command' => 'app:import', 'file' => 'data.csv']);
self::assertSame(0, $tester->getStatusCode());
self::assertStringContainsString('imported', $tester->getDisplay());
```

## DB tests — transaction rollback

Wrap each test in a transaction rolled back in `tearDown` — the DB returns to its prior state with zero per-test truncation cost:

```php
protected function setUp(): void {
    parent::setUp();
    self::bootKernel();
    $this->em = self::getContainer()->get(EntityManagerInterface::class);
    $this->em->getConnection()->beginTransaction();
}
protected function tearDown(): void {
    $this->em->getConnection()->rollBack();   // discard everything the test wrote
    $this->em->close();
    parent::tearDown();
}
```

Or use `dama/doctrine-test-bundle` — it does this for every test automatically via a static connection. Either way: never share data between DB tests; never assume insertion order.

## Anti-patterns

- Docblock annotations (`@test`, `@dataProvider`, `@covers`) — silently ignored in 13; the test won't run or won't be a provider. Migrate to attributes.
- `assertEquals` where `assertSame` fits — `0 == "0" == false` passes loosely; bugs slip through.
- Mockery without `Mockery::close()` (the trait) — unmet expectations never fail.
- Mocking the SUT itself, or mocking value objects — test the real thing; mock only collaborators at the boundary.
- `setUpBeforeClass` mutated by tests — leaks state across the class; order-dependent flake.
- Real Postgres on `localhost:5432` in a unit test — flaky, CI-hostile. Use the transaction-rollback fixture or a container.

## Red flags

| Thought                                   | Reality                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| "My test isn't running after the upgrade" | `@test` annotation removed in 13 — add `#[Test]` or `test` prefix     |
| "Provider says it must be static"         | PHPUnit 10+ requires `public static` providers                        |
| "Mock returns null and the SUT crashes"   | Sealed doubles in 13 — configure every method, or it throws           |
| "DB tests pass alone, fail in the suite"  | Order dependence — wrap each in a rolled-back transaction             |
| "WebTestCase is slow"                     | You're booting the kernel per test; that's expected — keep units pure |

## Hand-off

The test-first discipline (when to write the test, Red-Green-Refactor) lives in `Skill(k0d3:tdd)` — this skill is mechanics, not theory. What to test where (unit vs integration vs e2e ratios, flaky-test triage): `Skill(k0d3:testing-strategy)`. Booting the Symfony kernel, the DI container, fixtures, and Doctrine wiring under test: `Skill(k0d3:php-symfony)`.
