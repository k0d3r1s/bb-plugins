# Twig 3

Template engine for the Symfony view layer. This is the depth reference behind `Skill(k0d3:php-symfony)` — load the skill first for how Twig wires into the framework; come here for the language itself.

## Three delimiters

| Delimiter | Purpose                          | Example                       |
| --------- | -------------------------------- | ----------------------------- |
| `{{ }}`   | print an expression (escaped)    | `{{ user.name }}`             |
| `{% %}`   | a statement / tag (control flow) | `{% if user %}...{% endif %}` |
| `{# #}`   | comment (not rendered, not sent) | `{# note for devs #}`         |

`{{ user.name }}` resolves in order: `$user['name']`, `$user->name`, `$user->getName()`/`isName()`/`hasName()`. The same dot syntax works for arrays and objects — that's deliberate.

## Inheritance + composition

```twig
{# base.html.twig #}
<!DOCTYPE html>
<html><head><title>{% block title %}Default{% endblock %}</title></head>
<body>{% block body %}{% endblock %}</body></html>
```

```twig
{# page.html.twig #}
{% extends 'base.html.twig' %}
{% block title %}Orders — {{ parent() }}{% endblock %}   {# parent() pulls the overridden block #}
{% block body %}<h1>Orders</h1>{% endblock %}
```

- `extends` — single-parent inheritance; child overrides named `block`s.
- `include` — drop a sub-template inline, passing a fresh variable scope: `{{ include('_row.html.twig', { order: o }) }}`.
- `embed` — `include` + the ability to override the embedded template's blocks at the include site (a one-off subclass).
- `use` — horizontal reuse: import another template's blocks into the current one without an inheritance edge.

`include` for dumb partials; `embed` when the partial needs per-call block overrides; `extends` for the page skeleton.

## Filters, functions, tests

```twig
{{ price|number_format(2, '.', ',') }}      {# filter: value | name(args) #}
{{ name|upper|trim }}                        {# chained left-to-right #}
{{ items|length }} · {{ list|join(', ') }}
{{ html|striptags }}                          {# strips tags; output still escaped — striptags is NOT a sanitizer #}

{{ max(a, b) }} {{ date('now') }}            {# functions: name(args) #}

{% if user.email is not null %}...{% endif %}
{% if loop.index is divisible by(3) %}...{% endif %}   {# tests: `is <name>` #}
```

Filters transform a piped value (`|`); functions are called standalone; tests follow `is`/`is not` (`defined`, `null`, `empty`, `iterable`, `same as`, `divisible by`). Default a possibly-missing value with `{{ x|default('—') }}`.

## Loops + the `loop` variable

```twig
{% for order in orders %}
  {{ loop.index }}/{{ loop.length }} — {{ order.sku }}
  {% if loop.first %}<strong>newest</strong>{% endif %}
{% else %}
  <p>No orders.</p>      {# runs only when `orders` is empty #}
{% endfor %}
```

`loop` exposes `index` (1-based), `index0`, `revindex`, `first`, `last`, `length`, and `parent` (the enclosing loop). Filter inside the head — `{% for o in orders|filter(o => o.active) %}` — instead of an inner `if`+`continue`.

## Macros + import

```twig
{# forms.html.twig #}
{% macro field(name, value, type = 'text') %}
  <input type="{{ type }}" name="{{ name }}" value="{{ value }}">
{% endmacro %}
```

```twig
{% import 'forms.html.twig' as forms %}          {# namespaced #}
{{ forms.field('email', user.email, 'email') }}

{% from 'forms.html.twig' import field %}        {# pull one macro into scope #}
{{ field('sku', order.sku) }}
```

Macros are Twig's reusable functions — pure, parameterised fragments. `import ... as` keeps them namespaced (preferred); `from ... import` pulls names directly. Macros don't see the template's outer variables unless passed in — that isolation is the point.

## Autoescaping + the `|raw` danger

Twig autoescapes every `{{ }}` for the HTML context by default — `<script>` becomes `&lt;script&gt;`. **`|raw` disables that for the value and is the #1 Twig XSS hole.** Never `|raw` anything that contains user input.

```twig
{{ comment.body }}              {# SAFE: escaped #}
{{ trusted_cms_html|raw }}      {# only for HTML you generated/sanitised server-side #}
{{ user_comment|raw }}          {# XSS — never do this #}
```

If user content must carry markup, sanitise server-side (an allow-list HTML sanitiser) and only then `|raw`. Twig escapes for the _current_ context; emitting into a `<script>` or attribute needs the right strategy (`|e('js')`, `|e('html_attr')`) — string-building JS from Twig vars is a footgun, prefer a data attribute the JS reads.

## Symfony integration

```twig
<a href="{{ path('order_show', { id: order.id }) }}">view</a>   {# relative URL by route name #}
<a href="{{ url('order_show', { id: order.id }) }}">absolute</a>
<link rel="stylesheet" href="{{ asset('styles/app.css') }}">     {# asset-mapper aware #}

{{ form_start(form) }}
  {{ form_row(form.email) }}                {# label + widget + errors #}
{{ form_end(form) }}                          {# emits the CSRF token automatically #}

<input type="hidden" name="_token" value="{{ csrf_token('delete_order') }}">  {# hand-rolled forms #}

{{ 'order.placed'|trans({ '%count%': n }) }}  {# translation via the trans filter #}
{% trans %}Hello {{ name }}{% endtrans %}      {# or the trans tag #}
```

`path()`/`url()` take a **route name**, never a literal path — that's how routes stay refactorable. `asset()` routes through asset-mapper so fingerprinted prod URLs Just Work. `form_*` functions render the bound Symfony form (and the CSRF field); see `Skill(k0d3:php-symfony)` for the Form/Validator side.

## Custom extensions + filters

```php
use Twig\Extension\AbstractExtension;
use Twig\TwigFilter;

final class PriceExtension extends AbstractExtension
{
    public function getFilters(): array
    {
        return [new TwigFilter('money', $this->money(...))];
    }
    public function money(int $cents, string $cur = 'EUR'): string
    {
        return number_format($cents / 100, 2).' '.$cur;
    }
}
// autoconfigure tags it as twig.extension — no manual service config
// usage: {{ order.totalCents|money('USD') }}
```

Extend `AbstractExtension` and return `TwigFilter`/`TwigFunction`/`TwigTest` instances. With `autoconfigure: true` Symfony tags it automatically. If a filter emits HTML you trust, mark it safe with `['is_safe' => ['html']]` on the `TwigFilter` rather than forcing callers to `|raw`.

## twig-cs-fixer

`vincentlanglet/twig-cs-fixer` is the formatter/linter for templates (this project wires it as the `twig` composer script: `vendor/bin/twig-cs-fixer lint --fix`). It enforces delimiter spacing, operator style, and block indentation — run it before commit so template diffs stay about content, not whitespace.
