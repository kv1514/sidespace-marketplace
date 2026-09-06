# Proposed permission allowlist for Claude Code

This is a **proposal, not live configuration**. Copy the JSON below into
`.claude/settings.json` yourself to apply it.

It cannot be applied by Claude. The harness refuses to let an agent write,
stage or commit its own permission file, which is the correct rule — an agent
that can commit its own grants can grant itself anything. So the list lives
here, where a person reads it and decides.

## Where the list came from

Every rule below is something this project actually did, counted from one long
working session (30,921 transcript entries, 2,636 shell calls):

| Ran | Command |
| ---: | --- |
| 1,877 | `grep` |
| 1,380 | `git` (290 log, 132 diff, 128 status, 110 show, 110 fetch, 107 checkout, 96 add, 80 commit, 65 push) |
| 1,359 | `head` |
| 1,059 | `sed` |
| 733 | `tail` |
| 557 | `python3` |
| 474 | `cat` |
| 405 | `node` |
| 231 | `npx` (148 tsc, 49 eslint, 18 next, 11 vitest) |
| 205 | `curl` |
| 178 | `pnpm` (65 typecheck, 44 lint, 37 test, 12 dev) |
| 70 | `psql` |

Plus the MCP tools: 579 Supabase queries, 160 pull-request reads, 65 Vercel
deployment lists, 44 merges, and the rest.

## What it changes

`defaultMode: "acceptEdits"` stops the prompt on every file edit. The `allow`
list covers the reading, building, testing, git and database work above. The
`deny` list is the point of the exercise: it is what stops a force-push to
main, a push straight to main, a Vercel purchase, a paused Supabase project,
or an email answered on your behalf.

Two deliberate omissions from `allow`, so they still ask once each time:

- **`mcp__github__merge_pull_request`** — merging deploys to production. Worth
  one click.
- **`Bash(rm:*)`** — deleting files is not on the list at all. Removing a
  scratch file is worth a prompt.

And two deliberate entries in `deny` that look inconsistent but are not:

- **`mcp__Gmail__send_message` is allowed**, because the hourly outbox routine
  sends transactional mail with it and denying it would stall that job.
- **`mcp__Gmail__reply` and `forward` are denied**, because "never answer a
  human on my behalf" is a standing rule and this is that rule as config.

## The blunt alternative

`"defaultMode": "bypassPermissions"` is one line and removes every prompt.
It also removes the `deny` list's protection. Not recommended.

## The file

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep",

      "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
      "Bash(cut:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(tr:*)", "Bash(awk:*)",
      "Bash(sed:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(file:*)",
      "Bash(stat:*)", "Bash(du:*)", "Bash(df:*)", "Bash(realpath:*)",
      "Bash(dirname:*)", "Bash(basename:*)", "Bash(readlink:*)", "Bash(which:*)",
      "Bash(echo:*)", "Bash(printf:*)", "Bash(date:*)", "Bash(env:*)", "Bash(pwd:*)",
      "Bash(diff:*)", "Bash(cmp:*)", "Bash(md5sum:*)", "Bash(sha256sum:*)",
      "Bash(base64:*)", "Bash(jq:*)", "Bash(xxd:*)", "Bash(seq:*)", "Bash(sleep:*)",
      "Bash(timeout:*)", "Bash(test:*)", "Bash(tee:*)", "Bash(xargs:*)",

      "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(chmod:*)",
      "Bash(chown:*)", "Bash(ln:*)", "Bash(tar:*)", "Bash(zip:*)", "Bash(unzip:*)",
      "Bash(gzip:*)", "Bash(gunzip:*)",

      "Bash(git:*)",

      "Bash(pnpm:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(yarn:*)",
      "Bash(bun:*)", "Bash(tsc:*)", "Bash(eslint:*)", "Bash(vitest:*)",
      "Bash(prettier:*)",

      "Bash(python3:*)", "Bash(python:*)", "Bash(pip3:*)", "Bash(pip:*)",

      "Bash(lsof:*)", "Bash(pgrep:*)", "Bash(pkill:*)", "Bash(kill:*)", "Bash(ps:*)",
      "Bash(psql:*)", "Bash(pg_ctl:*)", "Bash(initdb:*)", "Bash(pg_isready:*)",
      "Bash(pg_dump:*)", "Bash(createdb:*)", "Bash(dropdb:*)", "Bash(runuser:*)",
      "Bash(supabase:*)",

      "Bash(curl:*)", "Bash(wget:*)", "Bash(dig:*)", "Bash(host:*)",

      "WebFetch", "WebSearch", "Agent", "Task", "TaskCreate", "TaskUpdate",
      "TaskList", "TaskGet", "TaskOutput", "TaskStop", "ToolSearch", "Skill",
      "SendUserFile", "Monitor", "ListAgents", "SendMessage", "ReadNotifications",
      "ScheduleWakeup", "EnterPlanMode", "ExitPlanMode", "ListSkills", "SearchSkills",

      "mcp__Supabase__execute_sql", "mcp__Supabase__apply_migration",
      "mcp__Supabase__list_tables", "mcp__Supabase__list_migrations",
      "mcp__Supabase__list_extensions", "mcp__Supabase__list_projects",
      "mcp__Supabase__list_organizations", "mcp__Supabase__list_branches",
      "mcp__Supabase__list_edge_functions", "mcp__Supabase__get_project",
      "mcp__Supabase__get_project_url", "mcp__Supabase__get_publishable_keys",
      "mcp__Supabase__get_advisors", "mcp__Supabase__get_logs",
      "mcp__Supabase__query_logs", "mcp__Supabase__search_docs",
      "mcp__Supabase__generate_typescript_types",

      "mcp__github__get_me", "mcp__github__get_file_contents",
      "mcp__github__get_commit", "mcp__github__list_commits",
      "mcp__github__list_branches", "mcp__github__list_tags",
      "mcp__github__search_code", "mcp__github__search_issues",
      "mcp__github__search_pull_requests", "mcp__github__search_repositories",
      "mcp__github__list_issues", "mcp__github__issue_read",
      "mcp__github__issue_write", "mcp__github__add_issue_comment",
      "mcp__github__list_pull_requests", "mcp__github__pull_request_read",
      "mcp__github__create_pull_request", "mcp__github__update_pull_request",
      "mcp__github__create_branch", "mcp__github__push_files",
      "mcp__github__create_or_update_file",
      "mcp__github__add_comment_to_pending_review",
      "mcp__github__add_reply_to_pull_request_comment",
      "mcp__github__pull_request_review_write",
      "mcp__github__resolve_review_thread", "mcp__github__unresolve_review_thread",
      "mcp__github__get_check_run", "mcp__github__get_job_logs",
      "mcp__github__actions_get", "mcp__github__actions_list",
      "mcp__github__update_pull_request_branch",
      "mcp__github__subscribe_pr_activity", "mcp__github__unsubscribe_pr_activity",

      "mcp__Vercel__list_projects", "mcp__Vercel__get_project",
      "mcp__Vercel__list_teams", "mcp__Vercel__list_deployments",
      "mcp__Vercel__get_deployment", "mcp__Vercel__get_deployment_build_logs",
      "mcp__Vercel__get_runtime_logs", "mcp__Vercel__get_runtime_errors",
      "mcp__Vercel__get_web_analytics", "mcp__Vercel__web_fetch_vercel_url",
      "mcp__Vercel__search_vercel_documentation",
      "mcp__Vercel__get_project_deployment_protection",
      "mcp__Vercel__list_toolbar_threads", "mcp__Vercel__get_toolbar_thread",

      "mcp__Gmail__search_threads", "mcp__Gmail__get_thread",
      "mcp__Gmail__get_message", "mcp__Gmail__list_labels",
      "mcp__Gmail__list_drafts", "mcp__Gmail__get_draft",
      "mcp__Gmail__create_draft", "mcp__Gmail__update_draft",
      "mcp__Gmail__label_message", "mcp__Gmail__label_thread",
      "mcp__Gmail__unlabel_message", "mcp__Gmail__unlabel_thread",
      "mcp__Gmail__send_message",

      "mcp__Claude_Code_Remote__get_session", "mcp__Claude_Code_Remote__list_sessions",
      "mcp__Claude_Code_Remote__list_repos",
      "mcp__Claude_Code_Remote__list_environments",
      "mcp__Claude_Code_Remote__list_triggers",
      "mcp__Claude_Code_Remote__create_trigger",
      "mcp__Claude_Code_Remote__update_trigger",
      "mcp__Claude_Code_Remote__delete_trigger",
      "mcp__Claude_Code_Remote__send_later", "mcp__Claude_Code_Remote__watch_url",
      "mcp__Claude_Code_Remote__unwatch_url",
      "mcp__Claude_Code_Remote__subscribe_pr_activity",
      "mcp__Claude_Code_Remote__unsubscribe_pr_activity",
      "mcp__Claude_Code_Remote__add_repo",
      "mcp__Claude_Code_Remote__register_repo_root",
      "mcp__Claude_Code_Remote__set_session_title",
      "mcp__Claude_Code_Remote__set_session_tags"
    ],
    "deny": [
      "Bash(rm -rf /:*)",
      "Bash(rm -rf ~:*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(git push origin main:*)",
      "Bash(git push origin +:*)",
      "Bash(git reset --hard origin:*)",
      "Bash(git filter-branch:*)",
      "Bash(git update-ref -d:*)",
      "Bash(shutdown:*)",
      "Bash(reboot:*)",
      "Bash(mkfs:*)",
      "Bash(dd if=:*)",
      "mcp__github__delete_file",
      "mcp__github__fork_repository",
      "mcp__github__create_repository",
      "mcp__Supabase__pause_project",
      "mcp__Supabase__restore_project",
      "mcp__Supabase__delete_branch",
      "mcp__Supabase__merge_branch",
      "mcp__Supabase__create_project",
      "mcp__Vercel__pause_project",
      "mcp__Vercel__deploy_to_vercel",
      "mcp__Vercel__update_project_deployment_protection",
      "mcp__Vercel__buy_domain",
      "mcp__Vercel__buy_pro",
      "mcp__Vercel__buy_credits",
      "mcp__Vercel__buy_addon",
      "mcp__Gmail__reply",
      "mcp__Gmail__forward",
      "mcp__Gmail__trash_message",
      "mcp__Gmail__trash_thread"
    ]
  }
}
```
