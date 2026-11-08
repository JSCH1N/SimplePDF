export function setupPanels(workspace, leftDivider, rightDivider) {
  const widths = { left: 230, right: 258 };
  try {
    const stored = JSON.parse(localStorage.getItem('pdfboard-panel-widths'));
    for (const side of Object.keys(widths)) {
      if (Number.isFinite(stored?.[side])) widths[side] = Math.max(132, stored[side]);
    }
  } catch { /* Storage may be disabled. */ }
  function apply() {
    const available = Math.max(264, workspace.clientWidth - 320);
    const left = Math.max(132, Math.min(widths.left, available - 132));
    const right = Math.max(132, Math.min(widths.right, available - left));
    workspace.style.setProperty('--left-width', `${left}px`);
    workspace.style.setProperty('--right-width', `${right}px`);
    leftDivider.setAttribute('aria-valuenow', left);
    rightDivider.setAttribute('aria-valuenow', right);
  }
  function persist() {
    try { localStorage.setItem('pdfboard-panel-widths', JSON.stringify(widths)); } catch { /* Optional preference. */ }
  }
  for (const [side, divider] of [['left', leftDivider], ['right', rightDivider]]) {
    const direction = side === 'left' ? 1 : -1;
    function adjust(value) {
      const other = side === 'left' ? 'right' : 'left';
      const otherWidth = parseFloat(workspace.style.getPropertyValue(`--${other}-width`));
      widths[side] = Math.max(132, Math.min(value, workspace.clientWidth - 320 - otherWidth));
      apply();
    }
    divider.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault();
      divider.focus();
      divider.setPointerCapture(event.pointerId);
      const x = event.clientX;
      const width = Number(divider.getAttribute('aria-valuenow'));
      divider.classList.add('resizing');
      divider.onpointermove = move => adjust(width + direction * (move.clientX - x));
      divider.onlostpointercapture = () => {
        divider.onpointermove = null;
        divider.classList.remove('resizing');
        persist();
      };
    };
    divider.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      adjust(Number(divider.getAttribute('aria-valuenow')) + direction * (event.key === 'ArrowLeft' ? -12 : 12));
      persist();
    };
  }
  new ResizeObserver(apply).observe(workspace);
  apply();
}
