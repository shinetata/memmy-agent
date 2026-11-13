/** Types module. */

/** Contract for skill manifest. */
export interface SkillManifest {
  targetId: string;
  content: string;
  marker: string;
}

/** Contract for memory plugin conflict. */
export interface MemoryPluginConflict {
  sourceId: string;
  displayName: string;
  configPath: string;
  installedPluginId: string;
}

/** Contract for skill target. */
export interface SkillTarget {
  readonly targetId: string;
  readonly displayName: string;
  resolveRootDirectory(): Promise<string | null>;
  install(manifest: SkillManifest): Promise<void>;
  uninstall(targetId: string): Promise<void>;
  isInstalled(targetId: string): Promise<boolean>;
  installPlugin?(targetId: string): Promise<void>;
  uninstallPlugin?(targetId: string): Promise<void>;
  isInstalledHookCurrent?(): Promise<boolean>;
  /** 记忆钩子是否已经装在这台电脑上（不看版本），项目钩子的安装条件之一。 */
  isMemoryHookInstalled?(): Promise<boolean>;
  /**
   * 项目钩子：本机项目指令、协作项目段与项目知识库由它注入，与记忆钩子分开安装、分开算版本。
   * 只支持其中一部分宿主时可以不实现这几个方法。
   */
  installProjectHook?(): Promise<void>;
  uninstallProjectHook?(): Promise<void>;
  isProjectHookInstalled?(): Promise<boolean>;
  isProjectHookCurrent?(): Promise<boolean>;
  detectMemoryPluginConflict?(): Promise<MemoryPluginConflict | null>;
}
