'use strict';

function createModeSwitchController(deps) {
  let pendingSwitch = null;

  return {
    getPendingSwitch() {
      return pendingSwitch;
    },
    requestModeSwitch(nextMode, nextCloudUrl = '') {
      const current = deps.getCurrentRuntimeInfo();
      if (!current || current.mode === nextMode) return false;
      if (!current.clientConfigPath) return false;
      pendingSwitch = {
        mode: nextMode,
        cloudUrl: nextCloudUrl || '',
        clientConfigPath: current.clientConfigPath
      };
      deps.quitApp();
      return true;
    },
    cancelPendingSwitch() {
      if (!pendingSwitch) return false;
      pendingSwitch = null;
      deps.rebuildMenu(deps.getCurrentRuntimeInfo());
      return true;
    },
    commitPendingSwitchBeforeQuit() {
      if (!pendingSwitch) return false;
      const target = pendingSwitch;
      pendingSwitch = null;
      deps.writeMode(target.clientConfigPath, target.mode, target.cloudUrl);
      deps.relaunchApp();
      return true;
    }
  };
}

function handleWillPreventUnload({ event, showConfirmDialog, onCancel }) {
  const choice = showConfirmDialog();
  if (choice === 1) {
    event.preventDefault();
    return 'discard';
  }
  onCancel?.();
  return 'keep';
}

module.exports = {
  createModeSwitchController,
  handleWillPreventUnload
};
