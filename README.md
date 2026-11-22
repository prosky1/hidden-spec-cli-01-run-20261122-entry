# hidden-spec-cli-01-run-20261122-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/prosky1/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/prosky1/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. It applies an edit an AI model wrote — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — to a tree of text files, to the contract in the kit's `SPEC.md`. Every file is changed or nothing is. Node 22, standard library alone.

`main.ts` is the tool; `runner.ts` is the kit's trial runner (kept as-is) that `main.ts` hands a trial over to when `MAKEFUN_ENV_URL` is set; `check.ts` runs the practice set locally.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the patch file, or `-` / absent for standard input. `--format` is `auto` (default), `unified`, `search-replace`, `v4a` or `json`. `--check` does everything but write. `--strict` matches lines exactly.

Practice checks: **100 of 100 passed (score 1000)**.

---

<sub>Entered on [make.fun](https://make.fun/?ref=met2w1d9&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
