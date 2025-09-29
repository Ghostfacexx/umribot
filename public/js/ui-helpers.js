/**
 * Tooltip and UI Helper Functions
 * Provides tooltip functionality and UI utilities for the GUI
 */

/**
 * Create tooltip system
 */
function createTooltipSystem() {
  // Add CSS for tooltips
  const style = document.createElement('style');
  style.textContent = `
    .tooltip-container {
      position: relative;
      display: inline-block;
    }
    
    .tooltip {
      position: absolute;
      bottom: 125%;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      white-space: nowrap;
      z-index: 1000;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.3s, visibility 0.3s;
      pointer-events: none;
      max-width: 300px;
      white-space: normal;
      line-height: 1.4;
    }
    
    .tooltip::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: #333;
    }
    
    .tooltip-container:hover .tooltip {
      opacity: 1;
      visibility: visible;
    }
    
    .help-icon {
      display: inline-block;
      width: 16px;
      height: 16px;
      background: #666;
      color: white;
      border-radius: 50%;
      text-align: center;
      line-height: 16px;
      font-size: 12px;
      margin-left: 5px;
      cursor: help;
      vertical-align: middle;
    }
    
    .help-icon:hover {
      background: #333;
    }
    
    .setting-group {
      margin-bottom: 15px;
    }
    
    .setting-label {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 5px;
    }
    
    .hint-box {
      background: #f0f8ff;
      border: 1px solid #b0d4f1;
      border-radius: 4px;
      padding: 10px;
      margin: 10px 0;
      font-size: 13px;
      color: #2c5282;
    }
    
    .hint-box .hint-title {
      font-weight: bold;
      margin-bottom: 5px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Add tooltip to an element
 */
function addTooltip(element, text) {
  if (!element || !element.parentNode) return null;
  
  const container = document.createElement('div');
  container.className = 'tooltip-container';
  
  // Move element into container
  element.parentNode.insertBefore(container, element);
  container.appendChild(element);
  
  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.textContent = text;
  container.appendChild(tooltip);
  
  return container;
}

/**
 * Add help icon with tooltip
 */
function addHelpIcon(element, text) {
  if (!element || !element.parentNode) return null;
  
  const helpIcon = document.createElement('span');
  helpIcon.className = 'help-icon';
  helpIcon.textContent = '?';
  helpIcon.title = text;
  
  // Add tooltip to help icon
  addTooltip(helpIcon, text);
  
  // Insert after the element
  element.parentNode.insertBefore(helpIcon, element.nextSibling);
  
  return helpIcon;
}

/**
 * Create a labeled input with tooltip
 */
function createLabeledInput(config) {
  const {
    id,
    label,
    type = 'text',
    tooltip,
    defaultValue,
    options = [],
    min,
    max,
    step
  } = config;
  
  const group = document.createElement('div');
  group.className = 'setting-group';
  
  const labelDiv = document.createElement('div');
  labelDiv.className = 'setting-label';
  
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  labelEl.setAttribute('for', id);
  labelDiv.appendChild(labelEl);
  
  if (tooltip) {
    const helpIcon = document.createElement('span');
    helpIcon.className = 'help-icon';
    helpIcon.textContent = '?';
    addTooltip(helpIcon, tooltip);
    labelDiv.appendChild(helpIcon);
  }
  
  group.appendChild(labelDiv);
  
  let input;
  
  if (type === 'select') {
    input = document.createElement('select');
    options.forEach(option => {
      const opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;
      input.appendChild(opt);
    });
  } else if (type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = defaultValue;
  } else {
    input = document.createElement('input');
    input.type = type === 'number' ? 'number' : 'text';
    if (type === 'number') {
      if (min !== undefined) input.min = min;
      if (max !== undefined) input.max = max;
      if (step !== undefined) input.step = step;
    }
    input.value = defaultValue || '';
  }
  
  input.id = id;
  group.appendChild(input);
  
  return { group, input, label: labelEl };
}

/**
 * Create hint box
 */
function createHint(title, content) {
  const hintBox = document.createElement('div');
  hintBox.className = 'hint-box';
  
  if (title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'hint-title';
    titleEl.textContent = title;
    hintBox.appendChild(titleEl);
  }
  
  const contentEl = document.createElement('div');
  contentEl.textContent = content;
  hintBox.appendChild(contentEl);
  
  return hintBox;
}

/**
 * Add stop button with confirmation
 */
function createStopButton(text, onStop, confirmMessage) {
  const button = document.createElement('button');
  button.textContent = text;
  button.className = 'button secondary';
  button.style.marginLeft = '10px';
  
  button.addEventListener('click', () => {
    if (confirmMessage && !confirm(confirmMessage)) {
      return;
    }
    onStop();
  });
  
  return button;
}

/**
 * Show loading state
 */
function setLoading(element, loading = true) {
  if (loading) {
    element.disabled = true;
    element.style.opacity = '0.6';
    element.style.cursor = 'not-allowed';
  } else {
    element.disabled = false;
    element.style.opacity = '1';
    element.style.cursor = 'pointer';
  }
}

/**
 * Show status message
 */
function showStatus(message, type = 'info') {
  const statusEl = document.getElementById('status') || createStatusElement();
  statusEl.textContent = message;
  statusEl.className = `notice ${type}`;
  
  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      statusEl.style.opacity = '0';
      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.style.opacity = '1';
      }, 300);
    }, 3000);
  }
}

function createStatusElement() {
  const statusEl = document.createElement('div');
  statusEl.id = 'status';
  statusEl.className = 'notice';
  statusEl.style.transition = 'opacity 0.3s';
  document.body.insertBefore(statusEl, document.body.firstChild);
  return statusEl;
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createTooltipSystem,
    addTooltip,
    addHelpIcon,
    createLabeledInput,
    createHint,
    createStopButton,
    setLoading,
    showStatus
  };
} else {
  // Browser environment
  window.UIHelpers = {
    createTooltipSystem,
    addTooltip,
    addHelpIcon,
    createLabeledInput,
    createHint,
    createStopButton,
    setLoading,
    showStatus
  };
}