import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SkillsMatrixSection } from "../components/settings/SkillsMatrixSection";

function SettingsSkillsRoute() {
  const { environment, scope } = useSettingsScope();
  const gt = useGT();
  if (!environment) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {scope.kind === "environment"
            ? gt("重新连接 {label} 以查看其技能声明状态。", { label: scope.label })
            : gt("连接环境以查看其全局技能声明状态。")}
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <SkillsMatrixSection
        key={`skills-matrix:${environment.environmentId}`}
        environmentId={environment.environmentId}
      />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/skills")({
  component: SettingsSkillsRoute,
});
