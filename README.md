# Awareness

A [Claude Code](https://claude.com/claude-code) mod that keeps a pane open beside the conversation, showing:

- the model, its thinking level, and how full the context window is (red above 50%)
- your 5-hour and weekly usage (red above 80%)
- the workspace: the YouTrack card named by a `BL-` branch with its summary (read with the `YOUTRACK_BOT` token), the branch and its parent (the pull request's base, else the repository's default branch), the folder with buttons that open it in Explorer or VS Code, and the branch's pull request with the branch it merges into
- uncommitted files and unpushed commits (orange when there are any)
- subagents still running
- your last three prompts, the newest highlighted

The pane docks beside the transcript in Claude Code's fullscreen layout when the terminal is at least 110 columns wide; otherwise it sits above the prompt. It opens itself when a session starts on a terminal at least 144 columns wide. Type `/awareness` to open it at any width.

In Orca, it also keeps the session's terminal tab labelled with a two- or three-word summary of what the conversation is working on, asked for again every few prompts. Until the first summary, the words of the card's branch name stand in (`BL-15958-crop-marks` reads `crop marks`). Turn this off with the "Label the Orca tab" row in `/config`.

The pull request comes from the [GitHub CLI](https://cli.github.com/) (`gh`), so `gh` must be installed and signed in for that part to show.

## Install

In a Claude Code terminal session:

```
/plugin install awareness --marketplace hatton/awareness
```

Answer `y` to add the marketplace, then choose the user scope so it loads in every session.

## Develop

```
claude --plugin-dir <path to this folder>
claude plugin validate <path to this folder>
claude plugin test <path to this folder>
```

## License

MIT
