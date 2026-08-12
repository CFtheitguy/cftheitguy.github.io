# Homepage notes (`index.html`)

Working notes that used to live as comments inside `index.html`. Kept here so the
page source stays clean.

## Structured data — two fields still to fill in

The `application/ld+json` block in `<head>` describes the business to Google.
Two things were deliberately left out because they have to be factual:

**1. Street address.** Add it inside `"address"`:

```json
"streetAddress": "<street>, Monroe, NY 10950"
```

Google needs a real street address for a LocalBusiness to rank in the map pack.
Without it the entity still validates, but map coverage is weak. This is the
single highest-value thing left on the list.

**2. Business hours.** Add alongside `"geo"`:

```json
"openingHoursSpecification": [{
  "@type": "OpeningHoursSpecification",
  "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday"],
  "opens": "09:00", "closes": "17:00"
},{
  "@type": "OpeningHoursSpecification",
  "dayOfWeek": "Friday", "opens": "09:00", "closes": "13:00"
}]
```

The `geo` block currently holds the Monroe, NY village centroid — replace it with
the office coordinates when the street address goes in.

Validate changes at https://search.google.com/test/rich-results.

## Contact form (Formspree)

The form posts to `https://formspree.io/f/mjgzyppb`.

The hidden `_gotcha` field is Formspree's honeypot — submissions that arrive with
it filled are dropped silently. It replaced `_honey` and `_captcha`, which are
FormSubmit.co syntax and did nothing on a Formspree endpoint, meaning the form
had no working honeypot at all.

The honeypot only stops lazy bots. Real spam protection is **reCAPTCHA** and the
**allowed-domain restriction**, both per-form settings in the Formspree
dashboard, not markup. Until those are on, anyone who reads the page source can
POST to the endpoint directly.

## Other

- Footer copyright year is set from the clock at the bottom of the page — no
  yearly edit needed.
- `robots.txt`, `sitemap.xml`, the canonical link and every internal anchor all
  use the `www` host, matching `CNAME`. The apex serves a clean 301 to `www`.
