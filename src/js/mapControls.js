import { store } from './appState.js';

export function initMapControls() {
  const controls = document.getElementById('map-controls');
  if (!controls) return;

  const tools = ['lines', 'stops'].map((name) => ({
    button: document.getElementById(`map-${name}-toggle`),
    panel: document.getElementById(`map-${name}-panel`),
  }));
  let activeTool = null;

  const closePanel = (restoreFocus = false) => {
    if (!activeTool) return;
    const { button, panel } = activeTool;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    activeTool = null;
    if (restoreFocus) button.focus({ preventScroll: true });
  };

  for (const tool of tools) {
    const { button, panel } = tool;
    button.addEventListener('click', () => {
      const wasOpen = activeTool === tool;
      closePanel();
      if (wasOpen) return;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      activeTool = tool;
    });
    panel.querySelector('[data-close-map-panel]').addEventListener('click', () => closePanel(true));
  }

  controls.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !activeTool) return;
    event.preventDefault();
    closePanel(true);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!controls.contains(event.target)) {
      closePanel(activeTool?.panel.contains(document.activeElement));
    }
  });
  store.subscribe((state, prev) => {
    if (state.selectedStop && state.stopSelectionSeq !== prev.stopSelectionSeq && activeTool === tools[1]) {
      closePanel(true);
    }
  });
}
