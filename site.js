'use strict';

// Static policy examples, not a policy evaluator or a live terminal.
const requests = [
  {
    decision: 'WITHIN GRANT', kind: 'allow',
    title: 'The project is an explicit VM share.',
    description: 'Broker authorizes the project grant. Bench exposes it to the agent’s workbench as a share with the permitted access. Other home directories are not shared.',
    path: [['broker', 'check grant'], ['bench', 'expose share'], ['agent', 'open file']],
    implication: 'You can let the agent modify one repository without giving it every file your login can read.',
    status: 'Broker and native Warden grants have implementations and development tests. The agent microVM path is still planned.',
    doc: '02-architecture/authority-flow.md', label: 'Authority flow'
  },
  {
    decision: 'NO FILE GRANT', kind: 'deny',
    title: 'Your SSH directory was never mounted.',
    description: 'This task has a project grant, not a grant to your home directory. The process cannot reach your SSH key through its filesystem view. In the full design, credential use goes through authorized services with separate policy checks.',
    path: [['agent', 'request key file'], ['workbench', 'no shared path'], ['result', 'read fails']],
    implication: 'A dependency script running in this workspace should not inherit your personal credentials.',
    status: 'Native filesystem isolation and Vault exist. Workbench integration and Gate’s credential-injection path are still planned.',
    doc: '06-security/secrets.md', label: 'How secrets are used'
  },
  {
    decision: 'REVIEW REQUIRED', kind: 'review',
    title: 'Private data + untrusted input + egress.',
    description: 'This session has read a private repository and an untrusted issue. The destination is not marked sink-safe, so adding egress completes the combination restricted by the Rule of Two. Without an accepted flow proof, it needs a declassification approval.',
    path: [['labels', 'track exposure'], ['broker', 'require review'], ['gate', 'enforce decision']],
    implication: 'A malicious instruction in an issue cannot, by itself, grant permission to send your repository elsewhere.',
    status: 'Broker label tracking and policy evaluation exist. Enforcement through the complete agent and external-effect path is still being integrated.',
    doc: '06-security/labels-and-rule-of-two.md', label: 'Labels and the Rule of Two'
  },
  {
    decision: 'APPROVAL PENDING', kind: 'review',
    title: 'Review the effect that will be executed.',
    description: 'In this example, updating an existing branch needs explicit approval of the destination, ref updates and commits. Approval is bound to that payload. A changed payload needs fresh approval; Gate checks authority again before execution.',
    path: [['gate', 'prepare effect'], ['you', 'review payload'], ['gate', 'check and commit']],
    implication: 'Permission to edit and test the working copy does not automatically include permission to publish it.',
    status: 'The approval contracts and authority services exist. Real Gate adapters, agent workbenches and the complete coding-agent flow remain planned.',
    doc: '07-agents/effects-and-outbox.md', label: 'Effect preparation and approval'
  },
  {
    decision: 'RECONCILE FIRST', kind: 'review',
    title: 'The reply was lost. Did the action complete?',
    description: 'Loom restores progress and starts a new attempt with fresh authority. Gate uses the effect’s stable identity to check the recorded outcome or the destination’s state. Retrying requires an adapter contract that makes it safe; otherwise the outcome stays unknown.',
    path: [['loom', 'restore progress'], ['broker', 'fresh authority'], ['gate', 'reconcile effect']],
    implication: 'Completed work can be reused. An uncertain external action must not be blindly repeated.',
    status: 'Loom restart recovery and lost-reply tests exist with controlled Gate and Depot doubles. Real adapters and full machine-reboot integration come later.',
    doc: '08-state/durable-workflows.md', label: 'Durable workflows and unknown outcomes'
  }
];

const requestButtons = [...document.querySelectorAll('.request')];
function selectRequest(index) {
  const request = requests[index];
  if (!request) return;
  requestButtons.forEach((button, i) => {
    button.classList.toggle('active', i === index);
    button.setAttribute('aria-pressed', String(i === index));
  });
  const decision = document.getElementById('decision');
  decision.textContent = request.decision;
  decision.dataset.kind = request.kind;
  document.getElementById('request-count').textContent = String(index + 1).padStart(2, '0') + ' / 05';
  document.getElementById('request-title').textContent = request.title;
  document.getElementById('request-description').textContent = request.description;
  document.getElementById('request-implication').textContent = request.implication;
  document.getElementById('request-status').textContent = request.status;
  document.getElementById('request-path').replaceChildren(...request.path.map(([name, action]) => {
    const node = document.createElement('li');
    const detail = document.createElement('span');
    detail.textContent = action;
    node.append(document.createTextNode(name), detail);
    return node;
  }));
  const link = document.getElementById('request-doc');
  const arrow = document.createElement('span');
  arrow.textContent = '↗';
  arrow.setAttribute('aria-hidden', 'true');
  link.href = 'handbook/#/' + request.doc;
  link.replaceChildren(document.createTextNode(request.label + ' '), arrow);
}
requestButtons.forEach(button => button.addEventListener('click', () => selectRequest(Number(button.dataset.request))));
