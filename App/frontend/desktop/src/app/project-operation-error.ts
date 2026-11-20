/**
 * 项目操作失败时该给用户看哪句文案。
 *
 * 看板与侧栏没有显示操作错误的地方：`operationErrorsBySurface.sidebar` 只在首页的输入框上方渲染，
 * 所以删除、停止共享、退出项目这些操作在看板上失败时，界面上一个字都不会出现，人只觉得「点了没反应」。
 * 这些操作失败一律再走一次全局通知，文案就从这里取。
 */
import type { MessageKey } from "../i18n/messages.js";

const PROJECT_OPERATION_ERROR_MESSAGE_KEYS: Record<string, MessageKey> = {
  /** 当前账号还共享着这个项目：先停止共享。 */
  project_shared: "home.error.projectShared",
  /** 本机还有别的账号的协作项目拴着它：去那个账号停共享。 */
  project_shared_elsewhere: "home.error.projectSharedElsewhere",
  project_directory_unavailable: "home.error.projectUnavailable",
  project_unavailable: "home.error.projectUnavailable",
  workspace_unavailable: "home.error.projectUnavailable",
  project_removed: "home.error.projectUnavailable",
  project_deleting: "home.error.projectDeleting",
  project_directory_not_empty: "home.error.projectNotEmpty",
  project_limit_reached: "home.error.projectLimit",
  project_registry_corrupt: "home.error.projectRegistry",
  /** 前一个项目操作还在进行（例如刚启动时在补建项目），这一次直接被挡回。 */
  project_mutation_conflict: "home.error.projectBusy",
  project_request_invalid: "home.error.generic",
  project_operation_failed: "home.error.generic",
  agent_gateway_unavailable: "home.error.network",
  network_unavailable: "home.error.network"
};

/** 认不出这个错误码时给一句通用的，不能什么都不显示。 */
export function projectOperationErrorMessageKey(code: string | null | undefined): MessageKey {
  return (code && PROJECT_OPERATION_ERROR_MESSAGE_KEYS[code]) || "home.error.generic";
}
