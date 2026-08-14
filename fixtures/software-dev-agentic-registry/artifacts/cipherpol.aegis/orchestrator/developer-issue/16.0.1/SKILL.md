---
name: developer-issue
description: Create or pick up a GitHub Issue — opens the issue, creates a branch, and updates the local backlog.
allowed-tools: Agent
user-invocable: true
disable-model-invocation: true
---

## Arguments

`$ARGUMENTS` — issue title (new issue) or issue number (pick up existing).

## Steps

Spawn `developer-issue-worker` using the Agent tool with:

> <$ARGUMENTS>
