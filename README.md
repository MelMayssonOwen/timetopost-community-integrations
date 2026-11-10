# TimeToPost community integrations

Add your own site to [TimeToPost](https://timetopost.co/integrations/community/) so people can schedule and publish to it next to Instagram, X and LinkedIn.

An integration here is a small JSON file that describes one HTTPS request. There is no code to write and none is run. Once your pull request is merged, your site shows up under **Integrations > Community** with your logo and a link to your site.

## What you need

1. An HTTP API on your site that creates a post, and a key or token your users can copy.
2. A visible link to `https://timetopost.co` on a public page of your site. `rel="nofollow"`, `ugc` or `sponsored` is accepted.
3. One pull request that adds `integrations/<your-id>/`.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). `integrations/_template` is a working example you can copy.

## Listed so far

| Integration | Pattern it shows |
| --- | --- |
| [Hashnode](integrations/hashnode) | GraphQL, one fixed host, an extra connection field |
| [Micro.blog](integrations/micro-blog) | Short posts, post URL read from a response header |
| [Micropub site](integrations/micropub) | Self-hosted: each user enters the address of their own site |

## How it stays safe

- Adapters are data. The manifest format has no way to run code, loops or expressions.
- Requests only go to the host in the manifest, or to the address the user typed for a self-hosted site. Private and internal addresses are refused.
- The user's key is only ever sent in the one header the manifest names. It cannot be placed in a URL or a body.
- Post text is inserted into a parsed JSON tree, so it cannot change the shape of a request.
- Redirects are not followed. Responses are size limited and never shown to users as raw text.
- Every adapter is read by a maintainer before merge, and TimeToPost ships a pinned, reviewed copy. Merging here does not change production by itself.

## Run the checks

Node 24 or newer, no install step:

```bash
node --test 'tests/*.test.ts'
node scripts/check-all.ts
```

MIT licensed.
