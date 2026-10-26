/**
 * The `memmy-session` skill: teaches an agent to find and read the sessions of the person's shared Memmy projects
 * with the `memmy-session` command. It is its own skill, apart from `memmy-memory`: reading teammates' shared
 * sessions has nothing to do with the person's memory, and a separate name and description are what an agent
 * matches a request like 「看看某人在某事上的最新进展」 against. Searching is the agent's call; nothing runs it on
 * every turn.
 */
export const MEMMY_SESSION_SKILL_DIRECTORY_NAME = "memmy-session";

/**
 * Codex runs commands in a sandbox that blocks network access by default, 127.0.0.1 included, so the command cannot
 * reach Memmy until it runs outside the sandbox.
 */
const CODEX_SANDBOX_NOTE = "In Codex, `memmy-session` talks to Memmy on this computer (127.0.0.1), which the sandbox blocks while network access is off. If it says the sandbox blocked the connection, run the same command again with escalated permissions, outside the sandbox, instead of asking the user to open Memmy.";

/**
 * The skill's whole SKILL.md. Every agent reads sessions through the same command; only Codex, whose sandbox blocks
 * the command's connection to Memmy, gets a note on running it outside the sandbox.
 */
export function renderMemmySessionSkillFile(source?: string): string {
  return [
    "---",
    "name: memmy-session",
    // A plain YAML scalar: no colon followed by a space, or the rest would be read as another key.
    "description: Find and read sessions of the user's shared Memmy projects, the record of what teammates decided, did and how far their work got. Use it first, before web, IM or chat-history search, when the user asks what a teammate did or decided (如「看看某人在某事上的最新进展」「这个当时怎么定的」), pastes a Memmy session link or a screenshot of another agent's conversation to build on, or works on a task in a shared Memmy project that teammates may already have touched.",
    "---",
    "",
    "# Memmy Session",
    "",
    "Members of a shared Memmy project can read each other's sessions. These sessions are the record of what teammates decided, did, and where their work stands. A copied session looks like `【Memmy】<title> https://<host>/s/<session-id>`.",
    "",
    "**The link is not a web page.** Do not open it with curl, a browser, or any web-fetch tool. Sessions are read through the `memmy-session` command, which needs Memmy to be running:",
    "",
    "```bash",
    "memmy-session search \"keywords\" [--member <name>] [--project <project name>] [--since 30d]",
    "memmy-session read \"<session link or id>\" [--turns <from>-<to>] [--around <turn>] [--find \"<sentence>\"] [--all]",
    "```",
    "",
    ...(source === "codex" ? [CODEX_SANDBOX_NOTE, ""] : []),
    "These are teammates' shared sessions, not the user's memory; for the user's own remembered context, use the `memmy-memory` skill.",
    "",
    "## When to search",
    "",
    "Check project sessions first, before web search, IM search or chat-history search, when:",
    "",
    "- The message contains a Memmy session link: run `memmy-session read` with that link before anything else.",
    "- The user asks what someone did or decided, or how far their work got, such as 「看看张三在事项编辑上的最新进展」 or 「这个当时是怎么定的」.",
    "- The user shares a screenshot of another agent's conversation to build on (see \"Screenshots\").",
    "- The task belongs to a shared Memmy project and touches a feature, module, API or document teammates may already have worked on.",
    "",
    "Skip it for local work that has nothing to do with teammates, such as editing one function or running tests.",
    "",
    "## How to search",
    "",
    "- Put a person's name only in `--member`, and two to four short topic words, separated by spaces, in the query. Add `--since 30d` for recent progress. Example: 「看看张三在事项编辑权限上是怎么定的」 → `memmy-session search \"事项 编辑 权限\" --member 张三`.",
    "- `--project` takes a project name as the results show it after the session title, never a session title.",
    "- Nothing found: drop `--since`, then `--member`, then try other words, such as words from a likely session title. After three searches without a match, stop: say nothing was found and suggest asking the teammate to copy the session's link in Memmy.",
    "- If several results fit and you cannot tell which one, list their titles and ask the user to choose.",
    "",
    "## How to read",
    "",
    "- `memmy-session read` prints an overview: where the session comes from, its latest turns in full, and one line per earlier turn. Latest progress is usually in it.",
    "- Expand with `--turns 3-8`, or `--around 12` for one turn and its neighbours. Each read fetches the session again, since nothing is stored on this computer; use `--all` only when you need everything.",
    "- Read at most two sessions per turn unless the user asks for more.",
    "",
    "## Where to stop",
    "",
    "A teammate's work is what their shared sessions say. Do not look for it in other agents' local histories, code repositories, the web or IM unless the user asks. If the sessions do not answer the question, say so.",
    "",
    "## Screenshots",
    "",
    "1. From the screenshot, take the session title, one or two sentences you can read exactly, and the teammate's name if it is shown.",
    "2. Search by the title; without a title, search by short keywords from those sentences.",
    "3. Check the match with `memmy-session read <id> --find \"<an exact sentence>\"`. If the sentence is not in the session, try the next candidate or ask the user.",
    "4. If nothing matches, say the session may not be shared to a Memmy project yet, and suggest asking the teammate to copy its link in Memmy.",
    "",
    "## Answering",
    "",
    "- Name the session title, the teammate and the last activity time you relied on. Refer to teammates by name, not by a guessed pronoun.",
    "- If the screenshot shows turns the shared session does not have yet, say so: the teammate's computer may not have synced them.",
    "- If fetching a link returned 401, 404, JSON or HTML, the link was opened directly. Do not investigate the URL or the port: run `memmy-session read` instead.",
    "- If a command fails, tell the user the reason it printed. Never guess what a session contains.",
    ""
  ].join("\n");
}
