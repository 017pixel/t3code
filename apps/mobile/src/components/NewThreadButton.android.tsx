import type { ComponentProps } from "react";
import { FloatingActionButton } from "./FloatingActionButton.android";
import { MaterialScrollComposeButton } from "./MaterialScrollComposeButton.android";
import type { NewThreadButton as SharedMaterialNewThreadButton } from "./NewThreadButton.shared";

export function NewThreadButton(props: ComponentProps<typeof SharedMaterialNewThreadButton>) {
  if (props.extended && props.expanded !== undefined) {
    return <MaterialScrollComposeButton {...props} expanded={props.expanded} />;
  }
  return (
    <FloatingActionButton
      {...props}
      icon="square.and.pencil"
      label="New thread"
      tone="primary"
      variant={props.extended ? "extended" : "large"}
    />
  );
}
