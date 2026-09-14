# gh-app-identity — one attributable GitHub identity per agent

## The problem this solves

Several agents on one machine usually authenticate to GitHub as the same account. Then the
platform cannot tell you **who initiated** anything: every comment, label and issue looks like it
came from the same person. Internal logs recording attribution do not fix that — if the platform
cannot show it, adopters reading the repository cannot see it either.

A GitHub App fixes it: each agent gets its own bot identity (`<slug>[bot]`), owned by a human
account, installed on a chosen subset of repositories, with its own permissions and its own
one-hour installation tokens. Revoking one agent's access does not disturb the others.

## Files

| file | what it does |
| --- | --- |
| `gh-app-token.py` | signs an RS256 JWT from the App private key, exchanges it for an installation token, and either reports it or runs a command with `GH_TOKEN` set |
| `create-github-app.py` | creates the App through GitHub's manifest flow (needs one browser confirmation) |

## Create the App (once per agent, needs a human)

```bash
python create-github-app.py --name my-agent --wait 600
# then open http://127.0.0.1:8765/ in a browser that is logged into GitHub,
# confirm on GitHub's page, and choose "Only select repositories"
```

Credentials are written to `$GH_APP_CRED_DIR/<slug>.json` (default `~/.dsh/gh-apps/`). Treat that
file as a secret: it holds the App private key. Install the App on the fewest repositories the
agent needs; "All repositories" is almost never the right answer.

## Use the identity

```bash
python gh-app-token.py --app my-agent                       # who am I, when does the token expire
python gh-app-token.py --app my-agent --exec -- gh issue comment 1 -R owner/repo --body "…"
python gh-app-token.py --app my-agent --exec -- git push origin HEAD:refs/heads/my-branch
```

The token is **never printed** unless you pass `--print-token`. The normal path is `--exec`, which
runs the command with `GH_TOKEN` in its environment, so `gh` and `git` use the App identity without
the token ever reaching a shell history or a log. Tokens last one hour and are cached until 60
seconds before expiry.

`--account <login>` picks the installation when the App is installed for more than one owner; the
credentials file may carry an `"account"` field instead. With several owners and neither given, the
tool refuses to guess.

## Two things that cost time when you first wire this up

1. **`--exec -- <cmd>` must be split by hand.** `argparse` treats a bare `--` as its own option
   terminator, so `nargs=argparse.REMAINDER` never sees the child command and the call dies with
   "unrecognized arguments". This tool splits the tail itself before parsing.
2. **`GET /user` returns 403 for an installation token** (`Resource not accessible by
   integration`). That is correct behaviour, not a broken token: installation tokens cannot read
   user endpoints. Prove the identity by the **author of an action** instead — do one real write,
   then read it back with a different credential and check `author.login`.

## Boundaries worth keeping

* One identity per agent, used for that agent's own actions. Do not let one agent speak as another,
  and do not let an agent widen its own permissions or repository list — that is the owner's call.
* The installation token is scoped by the App's permissions, not by the human account's, which is
  the reason this is safer than handing every agent the same personal token.
* Webhooks can stay inactive (`hook_attributes.active: false`) while you only need to act; turn them
  on when you actually want push notifications.
