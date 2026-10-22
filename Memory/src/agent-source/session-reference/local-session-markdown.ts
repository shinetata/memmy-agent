/** Renders a local session as the Markdown file handed to the referencing agent. */
import type { LocalSession, LocalSessionTurn } from "./local-session-reference.js";

/** Renders render local session markdown. */
export function renderLocalSessionMarkdown(session: LocalSession, readAt: Date): string {
  const lines = [
    `# ${session.title}`,
    "",
    `- Agent：${session.agentName}`,
    ...(session.workspacePath ? [`- 工作目录：${session.workspacePath}`] : []),
    `- 最近交互：${formatLocalTime(new Date(session.updatedAt))}`,
    `- 读取时间：${formatLocalTime(readAt)}`,
    "",
    `## 会话记录（共 ${session.turns.length} 轮）`
  ];
  session.turns.forEach((turn, index) => {
    lines.push("", `### 第 ${index + 1} 轮`, ...renderTurn(turn));
  });
  return `${lines.join("\n")}\n`;
}

function renderTurn(turn: LocalSessionTurn): string[] {
  const lines: string[] = [];
  if (turn.question) {
    lines.push(`提问：${turn.question}`);
  }
  if (turn.reply) {
    lines.push(`回复：${turn.reply}`);
  }
  if (turn.steps.length) {
    lines.push(`执行步骤：${summarizeSteps(turn.steps)}`);
  }
  return lines;
}

/** Collapses repeated tool names, e.g. Bash ×3、Edit. */
function summarizeSteps(steps: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join("、");
}

function formatLocalTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
