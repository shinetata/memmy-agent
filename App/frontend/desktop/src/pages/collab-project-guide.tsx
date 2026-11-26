import { CircleHelp, MoreHorizontal, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { Tooltip } from "../components/tooltip.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-page.module.css";

const guideScenes = {
  find: {
    feature: "copyLink",
    related: ["continue", "mention"],
    example: { title: "collab.guide.example.task", menuItem: "collab.session.continue", action: "collab.session.copyLink" },
    external: ["searchSessions", "readLink"]
  },
  share: {
    feature: "invite",
    related: ["share", "linkSessions"],
    example: { title: "collab.members.inviteTitle", action: "collab.members.copyLink" }
  },
  setup: {
    feature: "agents",
    related: ["config"],
    example: { title: "collab.guide.example.preferences", action: "settings.collab" },
    external: ["useAgent"]
  },
  assist: {
    feature: "assist",
    related: ["assistHistory", "receiveAssist"],
    example: { title: "collab.guide.example.member", action: "collab.assist.askButton" },
    external: ["askAssist"]
  }
} as const;

type GuideScene = keyof typeof guideScenes;
const sceneOrder: GuideScene[] = ["find", "share", "setup", "assist"];

export function CollabProjectGuide({ projectName }: { projectName: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<GuideScene>("find");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeSceneRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const title = t("collab.guide.title");
  const activeScene = guideScenes[scene];
  const { feature, related, example } = activeScene;
  const external = "external" in activeScene ? activeScene.external : null;
  const menuItem = "menuItem" in example ? example.menuItem : null;

  function close() {
    triggerRef.current?.focus();
    setOpen(false);
  }

  return (
    <>
      <Tooltip content={t("collab.guide.hint")} shouldShow={() => !open}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.guideTrigger}
          data-window-drag-exclusion="collab-project-guide"
          aria-label={title}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <CircleHelp size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      {open ? createPortal(
        <Modal
          open={open}
          title={title}
          className={styles.guideModal}
          backdropClassName={styles.guideBackdrop}
          initialFocusRef={activeSceneRef}
          closeLabel={t("common.close")}
          closeContent={<X size={18} aria-hidden="true" />}
          onClose={close}
        >
          <div className={styles.guideTabs} role="group" aria-label={t("collab.guide.scenes")}>
            {sceneOrder.map((id) => (
              <Button
                key={id}
                ref={id === scene ? activeSceneRef : undefined}
                type="button"
                size="sm"
                variant="ghost"
                className={styles.guideTab}
                aria-pressed={id === scene}
                aria-controls={panelId}
                onClick={() => setScene(id)}
              >
                {t(`collab.guide.scene.${id}`)}
              </Button>
            ))}
          </div>
          <div id={panelId} className={styles.guidePanel}>
            <section className={styles.guideMemmy} aria-labelledby={`${panelId}-feature`}>
              <div className={styles.guideFeature}>
                <div>
                  <h3 id={`${panelId}-feature`}>{t(`collab.guide.${feature}.title`)}</h3>
                  <p>{t(`collab.guide.${feature}.body`)}</p>
                </div>
                <div className={styles.guideExample} aria-hidden="true">
                  <div className={styles.guideExampleHeader}>
                    <span>{t(example.title)}</span>
                    {menuItem ? <MoreHorizontal size={15} className={styles.guideExampleMore} /> : null}
                    {scene === "assist" ? <span className={styles.guideExampleTarget}>{t(example.action)}</span> : null}
                  </div>
                  {scene === "assist" ? null : (
                    <div className={styles.guideExampleMenu}>
                      {menuItem ? <span>{t(menuItem)}</span> : null}
                      <span className={styles.guideExampleTarget}>{t(example.action)}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.guideRelated}>
                {related.map((id) => (
                  <div key={id}>
                    <h4>{t(`collab.guide.${id}.title`)}</h4>
                    <p>{t(`collab.guide.${id}.body`)}</p>
                  </div>
                ))}
              </div>
            </section>
            {external ? (
              <section className={styles.guideExternal} aria-labelledby={`${panelId}-agent`}>
                <h3 id={`${panelId}-agent`}>{t("collab.guide.context.agent")}</h3>
                <div className={styles.guideRelated}>
                  {external.map((id) => (
                    <div key={id}>
                      <h4>{t(`collab.guide.${id}.title`)}</h4>
                      <p>{t(`collab.guide.${id}.body`, { project: projectName })}</p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </Modal>,
        document.body
      ) : null}
    </>
  );
}
