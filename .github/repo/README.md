# Repository settings as code

Each file here is the exact body the GitHub REST API takes, so you can copy from the API docs
or export a ruleset from the GitHub UI and drop it in. `scripts/repo_settings.py` compares
these with the live repo and applies them. The script is kept byte-identical across the
`rae004` repos that use this pattern; change it everywhere or nowhere.

| file | endpoint | notes |
|---|---|---|
| `repository.json` | `PATCH /repos/{owner}/{repo}` | only the keys listed are managed |
| `actions-permissions.json` | `PUT …/actions/permissions` | which Actions may run |
| `actions-workflow.json` | `PUT …/actions/permissions/workflow` | `GITHUB_TOKEN` defaults; `can_approve_pull_request_reviews` lets release-please open PRs |
| `rulesets/*.json` | `POST`/`PUT …/rulesets` | matched to the live ruleset by `name`; branches must be up to date before merge (this repo deploys); `CDK Diff` is not required because it needs AWS credentials Dependabot PRs don't get |
| `labels.json` | `POST`/`PATCH …/labels` | optional and not used here; issue labels matched by name |

```
python3 scripts/repo_settings.py diff    # show drift between these files and the live repo (exit 1 if any)
python3 scripts/repo_settings.py apply   # push the files to GitHub (needs repo admin)
```

CI runs `diff` on every PR that touches this folder. The default Actions token can't read
the Actions-permission endpoints, so those report `skipped` in CI unless a `REPO_ADMIN_TOKEN`
secret (fine-grained PAT, Administration: read) is set. Applying is always done locally.

## One-off prerequisites (no JSON body, so not managed here)

- Dependabot alerts must be on before `security_and_analysis.dependabot_security_updates` can
  be enabled: `gh api -X PUT repos/{owner}/{repo}/vulnerability-alerts` (204 = on).
