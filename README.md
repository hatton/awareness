# Awareness

A [Claude Code](https://claude.com/claude-code) mod that keeps a pane open beside the conversation, showing:

- the model, its thinking level, and how full the context window is (red above 50%)
- your 5-hour and weekly usage (red above 80%)
- the workspace: the YouTrack issue named by a `BL-` branch with its summary and state (read with the `YOUTRACK_BOT` token), the branch and its parent (the pull request's base, else the repository's default branch), the folder with buttons that open it in Explorer or VS Code, and the branch's pull request with the branch it merges into, its status and a link to its Reviewable page
- a stack of pull requests, when the branch's pull request is in one: each pull request in merge order, with its status (a draft's highlighted) and a link to the worktree on this machine that has its branch checked out, which brings Orca's window to that worktree; an open one checked out nowhere offers to create one
- a warning when the pull request is merged or closed, or when the folder is named for a different branch than the one checked out
- uncommitted files and unpushed commits (orange when there are any)
- a "Working on:" line naming the skill and the task in progress
- subagents still running
- your last three prompts, each on one line, the newest highlighted

The pane docks beside the transcript in Claude Code's fullscreen layout when the terminal is at least 110 columns wide; otherwise it sits above the prompt. It opens itself when a session starts on a terminal at least 144 columns wide. Type `/awareness` to open it at any width.

In Orca, it also keeps the session's terminal tab labelled with a two- or three-word summary of what the conversation is working on, asked for again every few prompts. Until the first summary, the words of the card's branch name stand in (`BL-15958-crop-marks` reads `crop marks`). Turn this off with the "Label the Orca tab" row in `/config`.

The pull request comes from the [GitHub CLI](https://cli.github.com/) (`gh`), so `gh` must be installed and signed in for that part to show.

## Install

In a Claude Code terminal session:

```
/plugin install awareness --marketplace hatton/awareness
```

Answer `y` to add the marketplace, then choose the user scope so it loads in every session.

### Keep it up to date

Claude Code does not update plugins from a marketplace like this one unless you ask it to. To get each new version on its own, run `/plugin`, open **Marketplaces**, select **awareness**, and choose **Enable auto-update**. Claude Code then checks for a new version a few minutes into each session and loads it the next time you start Claude Code, or straight away after `/reload-plugins`.

To update right now instead:

```
claude plugin update awareness@awareness
```

## Develop

```
claude --plugin-dir <path to this folder>
claude plugin validate <path to this folder>
claude plugin test <path to this folder>
```

## License

MIT
