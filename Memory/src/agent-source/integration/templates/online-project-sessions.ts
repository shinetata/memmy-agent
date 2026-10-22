/**
 * The skill section that teaches an agent to read online project sessions from a pasted Memmy session link.
 * Every skill manifest includes it — hook, plugin, and skill-only agents alike — so a member can reference a
 * session from whichever agent they already use.
 */
export function onlineProjectSessionLines(): string[] {
  return [
    "## Online Project Sessions",
    "",
    "Members of a Memmy online project can reference each other's sessions. A copied session looks like `【Memmy】<title> https://<host>/s/<session-id>`.",
    "",
    "**The link is not a web page.** Do not open it with curl, a browser, or any web-fetch tool. It is read through the Memmy CLI:",
    "",
    "```bash",
    "memmy-memory sessions read \"<session link or id>\"",
    "memmy-memory sessions search \"keywords\" [--member <name>] [--project <name>]",
    "```",
    "",
    "- When the message contains a Memmy session link, run `sessions read` with that link before anything else. It downloads the session and prints the path of a Markdown file; read that file before answering.",
    "- If fetching the link returned 401, 404, JSON or HTML, the link was opened directly. Do not investigate the URL or the port: run `sessions read` instead.",
    "- When the user refers to a project member's session or work without a link, run `sessions search`. If several results fit and you cannot tell which one, list their titles and ask the user to choose.",
    "- In your answer, name the session title and the member you relied on.",
    "- If a command fails, tell the user the reason it printed. Never guess what a session contains."
  ];
}
