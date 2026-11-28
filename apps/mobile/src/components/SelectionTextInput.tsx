import React, { type ComponentProps } from "react";
import { Platform, TextInput } from "react-native";

/** The read-only selection field used by the thread and Work passages. */
export function SelectionTextInput(props: ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      editable={Platform.OS !== "ios"}
      showSoftInputOnFocus={false}
      multiline
      scrollEnabled
      textAlignVertical="top"
      {...props}
    />
  );
}
