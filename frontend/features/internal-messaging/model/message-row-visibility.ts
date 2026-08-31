export type MessageRowContainmentState = {
  loadingOlderMessages: boolean;
  preservingOlderScroll: boolean;
};

export type MessageRowContainmentStyle = {
  contentVisibility: "auto";
  containIntrinsicSize: string;
};

// content-visibility:auto sizes off-viewport prepended rows at ~72px, so a
// scrollHeight delta restore jumps. Re-enabling after restore still under-reports
// those siblings, so message rows never opt into it.
export function messageRowContainmentStyle(
  _state: MessageRowContainmentState,
): MessageRowContainmentStyle | undefined {
  return undefined;
}
