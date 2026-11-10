# Adding your integration

## 1. Copy the template

```bash
cp -r integrations/_template integrations/your-site
```

Your directory holds exactly three files: `manifest.json`, `tests.json` and `logo.svg`.

## 2. Add the link to your site

Put a link to `https://timetopost.co` on a public page of your site, such as your integrations, tools or partners page. Set that page in `backlink.page`. It must be on the same site as `siteUrl`.

The check fetches the page and looks for the link in the HTML the server sends:

- The link must be a normal `<a href="https://timetopost.co...">`. `rel="nofollow"`, `ugc` or `sponsored` is accepted.
- It must be visible, on a page that is not `noindex`.
- It must stay there. A nightly job re-checks every listing. If the link goes away, the maintainer has 14 days to restore it before the listing is removed.

Your listing on TimeToPost links to your site with `rel="nofollow ugc"`, because listings are submitted by contributors. What you get is the listing and the visitors it sends.

## 3. Write the manifest

| Key | Meaning |
| --- | --- |
| `id` | Same as the directory name. 2 to 40 lowercase letters, digits or hyphens. |
| `name`, `tagline` | Shown on the listing. Plain facts, 40 and 120 characters at most. |
| `siteUrl` | Your site. Visitors from the listing go here. |
| `category` | `blog`, `community`, `newsletter`, `social` or `other`. |
| `maintainer.github` | Your GitHub username. It must match the pull request author. |
| `content.format` | `article` needs a title and body. `text` is one block of text. |
| `content.maxChars` | The longest post your API accepts. |
| `api` | `{ "host": "api.example.com" }` for one hosted API, or `{ "instance": { "label", "placeholder" } }` when each user has their own site. |
| `connect.secret` | How to ask for the key, and where users find it. |
| `connect.fields` | Extra values such as a blog ID. Optional `pattern` must be anchored. |
| `auth` | The header that carries the key, and a prefix such as `Bearer `. |
| `verify` | A read-only request that proves the key works. |
| `publish` | The request that creates the post. |

### Requests

`verify` and `publish` take `method`, `path`, `json`, `headers`, `status`, `errorPath` and `result`.

- `path` is relative to the host. It may use `{{config.x}}`, which is URL-encoded.
- `json` is a template. Strings may use:

| Placeholder | Value |
| --- | --- |
| `{{post.text}}` | The whole post (publish only) |
| `{{post.title}}` | The first line, without a leading `#` |
| `{{post.body}}` | Everything after the first line |
| `{{post.tags}}` | An array when it is the whole string |
| `{{config.key}}` | A value from `connect.fields` |

A key or array item whose whole value is a placeholder with nothing in it is left out of the request.

- `status` lists the HTTP statuses that mean success. Default `[200, 201]`.
- `errorPath` is for APIs that answer 200 with an error, such as GraphQL (`"errors"`).
- `result` says where to read the answer, as dot paths into the JSON. `publish.result` needs at least one of `postId`, `url` or `urlHeader`.

Text and Markdown only for now. Image and video attachments are not supported.

## 4. Write the tests

`tests.json` needs at least one successful `verify` and one successful `publish`, each with `expectRequest`. A test states the input, the exact request expected, a sample response and the expected result. No network is used.

## 5. Open the pull request

```bash
node --test 'tests/*.test.ts'
node scripts/check-all.ts
```

One adapter per pull request, changing only files in your directory. `logo.svg` must be plain shapes: no scripts, links, styles, embedded images or entities, under 50 KB.

## Review

CI checks the format, runs your tests and verifies the link. Then a maintainer reads the adapter and checks that:

1. The site is real, and you run it or may list it.
2. `api.host` belongs to that site, and the API call does what the listing says.
3. The tagline and logo are accurate and do not imitate someone else.
4. The link can be seen on the page by a person, and the site's domain is not a shared host where anyone can get a subdomain.
5. `connect.fields` does not collect a password or key. Only `connect.secret` is encrypted.
6. The site is not spam, adult content, gambling, or anything built to scrape or deceive.

Passing CI does not guarantee a merge. A change to `api` or `auth` can only be made by a maintainer, and users have to reconnect afterwards. After merge, your integration ships with the next TimeToPost release that picks it up.

## Removal

A listing can be removed if its backlink goes away, its API stops working, or it breaks these rules. Report a security problem by emailing hello@timetopost.co, not in a public issue.
