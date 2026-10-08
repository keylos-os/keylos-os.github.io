'use strict';

// An explanatory, client-only walkthrough. No terminal, API calls or live claims.
const steps = [
  {
    title: 'A workspace of its own.',
    description: 'The planned workbench gives a coding agent a microVM with explicit project shares. Its tools work inside that boundary; host files and credentials are not ambient permissions.',
    component: 'bench + broker',
    trace: [['workspace', 'parser-fix / agent-07'], ['project', 'read + working copy'], ['host home', 'not granted', 'muted'], ['effect', 'requires authorization', 'mint']]
  },
  {
    title: 'Useful access. Clear limits.',
    description: 'The agent edits, builds and tests its working copy. The intended integration bounds spending and network access, and tracks sensitive or untrusted inputs before allowing further actions.',
    component: 'aide + broker + gate',
    trace: [['change', 'parser boundary fixed'], ['tests', 'passing in this example', 'mint'], ['network', 'approved destinations only'], ['budget', 'hard ceiling, shared by retries']]
  },
  {
    title: 'Progress survives the process.',
    description: 'Loom records completed observations and pending steps. Recovery uses fresh attempts and rechecks authority. The current implementation proves this with controlled effects; full reboot and agent integration come later.',
    component: 'loom',
    trace: [['step', 'test result recorded'], ['interruption', 'worker stopped', 'muted'], ['recovery', 'new execution attempt'], ['authority', 'checked again', 'mint']]
  },
  {
    title: 'Review before it leaves.',
    description: 'The planned coding-agent flow presents the exact prepared change and destination before a T3 approval. A changed payload or invalid permission must block execution until the required review is complete.',
    component: 'aide + gate + trusted approval',
    trace: [['proposal', 'open a pull request'], ['payload', 'bound to the reviewed digest'], ['approval', 'waiting for you', 'muted'], ['dispatch', 'not authorized yet']]
  },
  {
    title: 'Know what happened next.',
    description: 'Confirmed effects produce inspectable receipts. Supported local transactions can be undone; external actions may need compensation. If a remote outcome is unknown, reconcile it before risking a duplicate.',
    component: 'ledger + strata + gate',
    trace: [['result', 'confirmed by the executor', 'mint'], ['evidence', 'signed receipt'], ['local change', 'undo where supported'], ['uncertain result', 'reconcile before retry']]
  }
];

const buttons = [...document.querySelectorAll('.workflow-step')];
const next = document.getElementById('next-step');
let currentStep = 0;

function selectStep(index) {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return;
  currentStep = index;
  const step = steps[index];
  buttons.forEach((button, i) => {
    button.classList.toggle('active', i === index);
    button.setAttribute('aria-pressed', String(i === index));
  });
  document.getElementById('step-count').textContent = `STEP ${String(index + 1).padStart(2, '0')} / 05`;
  document.getElementById('step-title').textContent = step.title;
  document.getElementById('step-description').textContent = step.description;
  document.getElementById('step-component').textContent = step.component;
  const trace = document.getElementById('step-trace');
  trace.replaceChildren(...step.trace.map(([key, value, emphasis]) => {
    const line = document.createElement('p');
    const label = document.createElement('span');
    label.className = 'trace-key';
    label.textContent = key;
    const content = document.createElement('span');
    content.textContent = value;
    if (emphasis) content.className = `trace-${emphasis}`;
    line.append(label, content);
    return line;
  }));
  next.replaceChildren(document.createTextNode(index === steps.length - 1 ? 'Start again ' : 'Next step '));
  const arrow = document.createElement('span');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = index === steps.length - 1 ? '↺' : '→';
  next.append(arrow);
}

buttons.forEach(button => button.addEventListener('click', () => selectStep(Number(button.dataset.step))));
next.addEventListener('click', () => selectStep((currentStep + 1) % steps.length));
