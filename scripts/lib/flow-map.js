'use strict';

const fs = require('fs');
const path = require('path');

const KINDS = ['det', 'judgment', 'human'];

// A step is [name, kind, enforcedBy, rules]. kind says what the step should be: det (a rule that code can run),
// judgment (open-ended, needs a model), human (the owner decides). enforcedBy is the repo path of the script,
// hook, or workflow that runs a det step today, or null when only rule text asks an agent to do it by hand.
function toStep([name, kind, enforcedBy, rules]) {
  return { name, kind, enforcedBy: enforcedBy || null, rules: rules || '' };
}

function validate(data, root) {
  const errors = [];
  const ids = new Set();
  for (const flow of data.flows) {
    const where = `flow ${flow.id}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(flow.id)) errors.push(`${where}: id is not kebab-case`);
    if (ids.has(flow.id)) errors.push(`${where}: duplicate id`);
    ids.add(flow.id);
    if (!data.areas.includes(flow.area)) errors.push(`${where}: unknown area "${flow.area}"`);
    if (!flow.steps.length) errors.push(`${where}: no steps`);
    for (const raw of flow.steps) {
      const s = toStep(raw);
      if (!s.name) errors.push(`${where}: a step has no name`);
      if (!KINDS.includes(s.kind)) errors.push(`${where}: step "${s.name}" has kind "${s.kind}"`);
      if (s.enforcedBy && s.kind !== 'det') errors.push(`${where}: step "${s.name}" is ${s.kind} but names a script`);
      if (s.enforcedBy && !fs.existsSync(path.join(root, s.enforcedBy))) errors.push(`${where}: step "${s.name}" names ${s.enforcedBy}, which does not exist`);
    }
  }
  return errors;
}

// Who does the step: target = what it should be; today = what the repo makes happen.
function actor(step, view) {
  if (step.kind === 'human') return 'human';
  if (step.kind === 'judgment') return 'agent';
  return view === 'target' || step.enforcedBy ? 'code' : 'agent';
}

// A flow with only code steps is deterministic, only agent steps is agent, both is mixed.
// Human decisions are gates and do not count; a flow of only human steps is "human".
function classify(actors) {
  const code = actors.includes('code');
  const agent = actors.includes('agent');
  if (code && agent) return 'mixed';
  if (code) return 'deterministic';
  if (agent) return 'agent';
  return 'human';
}

function build(data, root) {
  const errors = validate(data, root);
  if (errors.length) throw new Error(errors.join('\n'));
  const flows = data.flows.map(flow => {
    const steps = flow.steps.map(toStep).map(s => ({ ...s, today: actor(s, 'today'), target: actor(s, 'target') }));
    return {
      id: flow.id, name: flow.name, area: flow.area, summary: flow.summary || '', steps,
      today: classify(steps.map(s => s.today)), target: classify(steps.map(s => s.target)),
    };
  });
  const count = (key, values) => Object.fromEntries(values.map(v => [v, flows.filter(f => f[key] === v).length]));
  const stepCount = view => Object.fromEntries(['code', 'agent', 'human'].map(a => [a, flows.reduce((n, f) => n + f.steps.filter(s => s[view] === a).length, 0)]));
  const classes = ['deterministic', 'mixed', 'agent', 'human'];
  return {
    title: data.title, areas: data.areas, flows,
    totals: { flows: flows.length, today: count('today', classes), target: count('target', classes), stepsToday: stepCount('today'), stepsTarget: stepCount('target') },
  };
}

module.exports = { toStep, validate, actor, classify, build };
