export function canReadConversation(state: {
  open: boolean; enabled: boolean; visible: boolean; focused: boolean;
  nearBottom: boolean; selectedPeerID?: string; peerID: string;
}) {
  return state.enabled && state.open && state.visible && state.focused && state.nearBottom &&
    Boolean(state.peerID) && state.selectedPeerID === state.peerID;
}
