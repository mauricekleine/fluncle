export type NetworkSnapshot = {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
};

export function isOnline(state: NetworkSnapshot | null | undefined): boolean {
  if (!state) {
    return true;
  }
  if (state.isInternetReachable === false) {
    return false;
  }
  if (state.isInternetReachable === true) {
    return true;
  }

  return state.isConnected !== false;
}
