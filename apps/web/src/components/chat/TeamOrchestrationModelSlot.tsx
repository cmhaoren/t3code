import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { useGT } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { AppModelOption } from "../../modelSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker } from "./TraitsPicker";

export interface TeamOrchestrationModelSlotProps {
  readonly environmentId: EnvironmentId;
  readonly workspaceCwd: string | null;
  readonly value: ModelSelection | null;
  readonly fallbackSelection: ModelSelection | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly getModelDisabledReason?: (
    instanceId: ProviderInstanceId,
    model: string,
  ) => string | null;
  readonly onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  readonly onChange: (next: ModelSelection | null) => void;
  readonly emptyLabel?: string;
  readonly allowClear?: boolean;
  readonly className?: string;
}

export function TeamOrchestrationModelSlot(props: TeamOrchestrationModelSlotProps) {
  const gt = useGT();
  const {
    environmentId,
    workspaceCwd,
    value,
    fallbackSelection,
    instanceEntries,
    modelOptionsByInstance,
    getModelDisabledReason,
    onOpenProviderSetup,
    onChange,
    emptyLabel,
    allowClear = true,
    className,
  } = props;

  if (value === null) {
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={fallbackSelection === null}
          onClick={() => {
            if (fallbackSelection) {
              onChange({
                instanceId: fallbackSelection.instanceId,
                model: fallbackSelection.model,
                options: [...(fallbackSelection.options ?? [])],
              });
            }
          }}
        >
          <PlusIcon className="size-3" />
          <span>{emptyLabel ?? gt("继承主会话")}</span>
        </Button>
      </div>
    );
  }

  const activeEntry = instanceEntries.find((entry) => entry.instanceId === value.instanceId);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <ProviderModelPicker
        environmentId={environmentId}
        workspaceCwd={workspaceCwd}
        activeInstanceId={value.instanceId}
        model={value.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        size="xs"
        triggerClassName="h-7 max-w-[220px] rounded-md border border-border bg-background/80 px-2 text-xs"
        {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
        {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
        onInstanceModelChange={(instanceId, model) =>
          onChange(pickModelSelection(value, instanceId, model))
        }
      />
      {activeEntry ? (
        <TraitsPicker
          provider={activeEntry.driverKind}
          models={activeEntry.models}
          model={value.model}
          modelOptions={value.options ?? []}
          allowPromptInjectedEffort={false}
          triggerClassName="h-7 rounded-md border border-border bg-background/80 px-2 text-xs"
          onModelOptionsChange={(options) =>
            onChange(createModelSelection(value.instanceId, value.model, options))
          }
        />
      ) : null}
      {allowClear ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("清除模型绑定")}
          onClick={() => onChange(null)}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
